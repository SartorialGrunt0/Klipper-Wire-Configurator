import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { useConfigStore } from '../stores/configStore';
import { useGraphStore } from '../stores/graphStore';
import { useNativeStore } from '../stores/nativeStore';
import * as api from '../services/api';
import ConfigReferenceDialog from './dialogs/ConfigReferenceDialog';
import { buildProjectGraph } from '../utils/graphBuilder';
import { restoreLayoutAfterRebuild } from '../utils/layoutPersistence';
import { acknowledgeableWarning } from '../utils/warningAcknowledgment';
import { resolveIssueLine } from '../utils/issueLine';
import { ISSUE_MARKER } from '../utils/issueMarker';
import type { ExampleConfig, ConfigFile, ConfigSection, ValidationError } from '../types/config';

interface SearchResult {
  file: string;
  line: number;
  lineText: string;
  matchStart: number;
  matchEnd: number;
}

interface TextIssue {
  line: number;
  text: string;
  severity: 'error' | 'warning' | 'info';
  section?: string;
  param?: string;
  acknowledgeSection?: ConfigSection;
  acknowledgeKind?: 'unknown' | 'duplicate';
}

interface ConfigParamEntry {
  key: string;
  line: number;
}

interface ConfigSectionEntry {
  id: string;
  title: string;
  line: number;
  params: ConfigParamEntry[];
  isCommented: boolean;
}

function TextEditor({ isActive = true }: { isActive?: boolean }) {
  const {
    configFiles,
    activeFile,
    setActiveFile,
    setConfigFile,
    updateConfigFile,
    setValidation,
    markDirty,
    renameConfigFile,
    copyConfigFile,
    removeConfigFile,
    setTextParseError,
    validation,
    revalidateFile,
  } = useConfigStore();
  const isDirty = useConfigStore((s) => s.isDirty);
  const parseError = useConfigStore((s) => s.textParseErrors[activeFile]);
  const validationText = useConfigStore((s) => s.validationText);

  const config = configFiles[activeFile];
  const filenames = Object.keys(configFiles);

  const [editText, setEditText] = useState('');

  // Helper: export config text via backend (preserves comments, whitespace, #*# markers).
  // Falls back to offline re-serialization when the backend is unreachable; callers use
  // `usedFallback` to warn that applying may normalize formatting.
  const exportTextRef = useRef<number>(0);
  const exportConfigText = useCallback(async (cf: typeof config): Promise<{ text: string; usedFallback: boolean }> => {
    if (!cf) return { text: '', usedFallback: false };
    try {
      return { text: await api.exportConfig(cf), usedFallback: false };
    } catch {
      return { text: configToText(cf), usedFallback: true };
    }
  }, []);

  // Tracks which files are currently showing fallback-derived text (per-file, component-lifetime)
  const [fallbackExportFiles, setFallbackExportFiles] = useState<Record<string, boolean>>({});
  const markFallbackExport = useCallback((filename: string, usedFallback: boolean) => {
    setFallbackExportFiles((prev) => (prev[filename] === usedFallback ? prev : { ...prev, [filename]: usedFallback }));
  }, []);
  const fallbackExportUsed = !!fallbackExportFiles[activeFile];

  // Surface backend export failures (fallback banner below covers the lossy case)

  // True while a config change originated from this editor's own debounced
  // apply — the export effect must not echo it back into the textarea
  // (that would fight the user's typing and reset the cursor).
  const applyingRef = useRef(false);
  // True while the textarea was (re)populated from the model's export — the
  // live-sync parse of that text is an echo, not a user edit.
  const exportingRef = useRef(false);

  // When config changes from OUTSIDE the text editor (undo/redo, import,
  // graph edits, file switch), re-export the model text into the textarea.
  // Only run while the text view is actually visible: the editor stays mounted
  // (CSS-hidden) in graph view so viewport state survives toggling, but its
  // effects must not fire there — a panel edit would otherwise be re-exported,
  // re-parsed and synced back into the graph (commType snap-back, undo churn).
  useEffect(() => {
    if (!isActive) return;
    if (applyingRef.current) {
      applyingRef.current = false;
      return;
    }
    if (!config) {
      setEditText('');
      return;
    }
    const requestId = ++exportTextRef.current;
    exportingRef.current = true;
    exportConfigText(config).then(({ text, usedFallback }) => {
      if (requestId === exportTextRef.current) {
        setEditText(text);
        markFallbackExport(activeFile, usedFallback);
      }
    });
  }, [isActive, activeFile, config, exportConfigText, markFallbackExport]);

  const [showSearch, setShowSearch] = useState(false);
  const [showFileSidebar, setShowFileSidebar] = useState(true);
  const [showSectionsSidebar, setShowSectionsSidebar] = useState(true);
  const [showReferenceViewer, setShowReferenceViewer] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({});
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const lineNumbersRef = useRef<HTMLDivElement>(null);
  const highlightRef = useRef<HTMLPreElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const editorScrollRef = useRef<HTMLDivElement>(null);
  const liveValidateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const liveValidateRequestRef = useRef(0);

  // File management state
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; file: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<{ file: string } | null>(null);
  const [renameDialog, setRenameDialog] = useState<{ file: string; value: string } | null>(null);
  const [showAddConfig, setShowAddConfig] = useState(false);
  const [addConfigStep, setAddConfigStep] = useState<'choose' | 'blank-name' | 'reference-pick'>('choose');
  const [newFileName, setNewFileName] = useState('');
  const [referenceSearch, setReferenceSearch] = useState('');
  const [referenceResults, setReferenceResults] = useState<ExampleConfig[]>([]);
  const [fileError, setFileError] = useState('');

  const syncLineNumbersScroll = useCallback(() => {
    if (!textareaRef.current || !lineNumbersRef.current) return;
    lineNumbersRef.current.scrollTop = textareaRef.current.scrollTop;
    if (highlightRef.current) {
      highlightRef.current.scrollTop = textareaRef.current.scrollTop;
      highlightRef.current.scrollLeft = textareaRef.current.scrollLeft;
    }
  }, []);

  // Debounced live sync: parse the current text as the user types and apply it
  // straight into the model (config store + graph). Parse succeeds with any
  // validation issues → the model updates and validation rides along (same as
  // the settings panel — the Save button colors accordingly, no gate).
  // Parse FAILS → the last-good model is held, the textarea keeps the user's
  // text, and the error is surfaced inline + as a save-blocking flag.
  // A request-id guard drops stale responses (older text resolving after
  // newer edits or a file switch).
  useEffect(() => {
    if (!isActive) return;
    if (liveValidateTimerRef.current) clearTimeout(liveValidateTimerRef.current);
    const requestId = ++liveValidateRequestRef.current;
    liveValidateTimerRef.current = setTimeout(async () => {
      try {
        const result = await api.parseConfigText(editText, activeFile);
        if (requestId !== liveValidateRequestRef.current) return;
        setTextParseError(activeFile, null);

        const currentConfig = useConfigStore.getState().configFiles[activeFile];
        const comparable = (cf: ConfigFile) => {
          const { raw_text: _rawText, ...rest } = cf;
          return JSON.stringify(rest);
        };
        const normalizeNewlines = (s: string) => s.replace(/\r\n?/g, '\n');
        // No-op echo (identical parse — e.g. native textarea undo returning to
        // an already-applied state, or re-parse of text we just exported from
        // the model) → skip the store write, history push, and graph sync so we
        // don't churn the undo stack or re-render the whole app.
        //
        // A formatting-only edit (whitespace, blank lines) parses to the same
        // structure — without distinguishing "exported text" from "user-typed
        // text" it would be dropped here and silently vanish on save. The
        // exportingRef marks text that came from the model; anything else with
        // the same structure is a real user edit and is applied (raw_text
        // updates so the edit survives). In offline fallback mode the
        // re-serialized export normalizes formatting, so the echo is detected
        // by structure alone (the banner already warns edits may normalize).
        const structureSame = currentConfig && comparable(currentConfig) === comparable(result.config);
        const textSame = currentConfig
          && normalizeNewlines(currentConfig.raw_text ?? '') === normalizeNewlines(result.config.raw_text ?? '');
        if (structureSame && (exportingRef.current || fallbackExportUsed || textSame)) {
          exportingRef.current = false;
          return;
        }
        exportingRef.current = false;

        applyingRef.current = true;
        useGraphStore.getState().pushHistory();
        // raw_text = editText so the backend export returns the user's text
        // verbatim — the text the user typed is the canonical content.
        // updateConfigFile (not setConfigFile) so the store's debounced
        // revalidation fires: for a multi-file project that runs the
        // PROJECT validation, which is the only source of the cross-file
        // findings (duplicate sections, missing includes) the gutter and
        // issue list render from. A single-file /parse would overwrite the
        // store with file-local findings and erase them (see 3.5 Q1).
        updateConfigFile(activeFile, { ...result.config, raw_text: editText });
        useGraphStore.getState().syncGraphWithConfig(activeFile);
      } catch (err) {
        if (requestId !== liveValidateRequestRef.current) return;
        // Parse failed — don't keep stale validation on screen, hold last-good model
        setTextParseError(activeFile, err instanceof Error ? err.message : 'Unable to parse configuration text.');
      }
    }, 800);
    return () => {
      if (liveValidateTimerRef.current) clearTimeout(liveValidateTimerRef.current);
      liveValidateRequestRef.current++;
    };
  }, [isActive, activeFile, editText, updateConfigFile, setTextParseError]);

  // Collect inline issues for the center editor from the store's project
  // validation of the active file. Project validation (not a single-file
  // parse) is the authoritative source: it carries the cross-file findings a
  // lone file can't know about — duplicate sections (info) and missing
  // includes (warning) — so the gutter + issue list stay in sync with the
  // right-hand section list, the save button, and the graph.
  //
  // Staleness guard: validation lags the textarea by the 800ms parse debounce
  // + the 500ms revalidation debounce + network time. While the user is
  // typing, the backend line_numbers describe the OLD layout — rendering them
  // as-is paints a dot several lines off (the "info dot in the middle of a
  // section" bug). When the live text has moved ahead of the text the
  // validation was computed against, re-resolve each line from the current
  // text (or hide the finding) until the fresh result lands.
  const inlineIssues = useMemo((): TextIssue[] => {
    const errors = validation[activeFile]?.errors ?? [];
    if (!errors || errors.length === 0) return [];
    const issues: TextIssue[] = [];
    const lines = editText.split('\n');
    const activeSections = configFiles[activeFile]?.sections ?? [];
    const normalizeNewlines = (s: string) => s.replace(/\r\n?/g, '\n');
    const validatedText = validationText[activeFile];
    const validationStale =
      validatedText != null &&
      normalizeNewlines(validatedText) !== normalizeNewlines(editText);
    for (const err of errors) {
      // Info findings are legal, order-dependent context — shown in the
      // gutter + issue list in muted grey, never as an alarm (3.5/Q1).
      if (err.severity === 'error' || err.severity === 'warning' || err.severity === 'info') {
        const lineNum = resolveIssueLine(err, lines, { stale: validationStale });
        const ack = err.severity === 'warning' ? acknowledgeableWarning(err) : null;
        issues.push({
          line: lineNum,
          text: err.message,
          severity: err.severity,
          section: err.section,
          param: err.param,
          acknowledgeSection: ack
            ? activeSections.find((section) => section.full_header === err.section)
            : undefined,
          acknowledgeKind: ack ? ack.kind : undefined,
        });
      }
    }
    return issues;
  }, [validation, validationText, activeFile, editText, configFiles]);

  const handleAcknowledgeWarning = useCallback(async (section: ConfigSection, kind: 'unknown' | 'duplicate' = 'unknown') => {
    if (kind === 'duplicate') {
      await api.acknowledgeDuplicateWarning(section);
      // Duplicates are cross-file (or same-file) section-type warnings, so the
      // whole project must be revalidated to clear every occurrence's flag.
      void revalidateFile(activeFile);
      return;
    }
    await api.acknowledgeWarning(section);
    const result = await api.parseConfigText(editText, activeFile);
    // Re-apply the (unchanged) model without marking dirty, then re-run
    // validation so the acknowledged finding clears. revalidateFile performs
    // the PROJECT revalidation for multi-file projects — the same source the
    // gutter renders from. Writing the file-local /parse result into the
    // store instead would erase cross-file findings.
    setConfigFile(activeFile, { ...result.config, raw_text: editText });
    void revalidateFile(activeFile);
  }, [activeFile, editText, setConfigFile, revalidateFile]);

  // Map line numbers to issues for rendering
  const issuesByLine = useMemo(() => {
    const map = new Map<number, TextIssue[]>();
    for (const issue of inlineIssues) {
      if (issue.line === 0) continue;
      const existing = map.get(issue.line) || [];
      existing.push(issue);
      map.set(issue.line, existing);
    }
    return map;
  }, [inlineIssues]);

  // All files as text for search — exported via backend for accuracy
  const [allFilesText, setAllFilesText] = useState<Record<string, string>>({});
  useEffect(() => {
    let cancelled = false;
    async function exportAll() {
      const result: Record<string, string> = {};
      for (const [fn, cf] of Object.entries(configFiles)) {
        result[fn] = (await exportConfigText(cf)).text;
        if (cancelled) return;
      }
      if (!cancelled) setAllFilesText(result);
    }
    exportAll();
    return () => { cancelled = true; };
  }, [configFiles]);

  // Search results across all files
  const searchResults = useMemo((): SearchResult[] => {
    if (!searchQuery.trim()) return [];
    const query = searchQuery.toLowerCase();
    const results: SearchResult[] = [];
    for (const [fn, fileText] of Object.entries(allFilesText)) {
      const lines = fileText.split('\n');
      lines.forEach((line, idx) => {
        const lowerLine = line.toLowerCase();
        const pos = lowerLine.indexOf(query);
        if (pos !== -1) {
          results.push({
            file: fn,
            line: idx + 1,
            lineText: line,
            matchStart: pos,
            matchEnd: pos + query.length,
          });
        }
      });
    }
    return results.slice(0, 200);
  }, [searchQuery, allFilesText]);

  const sectionEntries = useMemo<ConfigSectionEntry[]>(() => {
    const lines = editText.split('\n');
    const sections: ConfigSectionEntry[] = [];
    let currentSection: ConfigSectionEntry | null = null;

    lines.forEach((line, idx) => {
      const sectionMatch = line.match(/^\s*(#?)\[([^\]]+)\]\s*$/);
      if (sectionMatch) {
        const title = sectionMatch[2].trim();
        if (title.toLowerCase().startsWith('include ')) {
          currentSection = null;
          return;
        }
        currentSection = {
          id: `${idx + 1}:${title}`,
          title,
          line: idx + 1,
          params: [],
          isCommented: sectionMatch[1] === '#',
        };
        sections.push(currentSection);
        return;
      }

      if (!currentSection || currentSection.isCommented) return;
      const paramMatch = line.match(/^\s*(#?)([A-Za-z0-9_][A-Za-z0-9_\-]*)(\s*[:=]\s*)(.*)$/);
      if (paramMatch && paramMatch[1] !== '#') {
        currentSection.params.push({ key: paramMatch[2], line: idx + 1 });
      }
    });
    return sections;
  }, [editText]);

  useEffect(() => {
    setExpandedSections({});
  }, [activeFile]);

  const highlightedHtml = useMemo(() => buildHighlightedHtml(editText), [editText]);

  // Focus search input when panel opens
  useEffect(() => {
    if (showSearch && searchInputRef.current) {
      searchInputRef.current.focus();
    }
  }, [showSearch]);

  // Sync when switching files — the config→text effect re-exports the new
  // file's model text into the textarea.
  const handleFileSwitch = useCallback((filename: string) => {
    if (filename === activeFile) return;
    setActiveFile(filename);
  }, [activeFile, setActiveFile]);

  const handleTextChange = (newText: string) => {
    exportingRef.current = false;
    setEditText(newText);
  };

  const jumpToLine = useCallback((line: number) => {
    if (!textareaRef.current || line < 1) return;
    const lines = textareaRef.current.value.split('\n');
    let charPos = 0;
    for (let i = 0; i < line - 1 && i < lines.length; i++) {
      charPos += lines[i].length + 1;
    }
    const lineLen = lines[line - 1]?.length ?? 0;
    textareaRef.current.focus();
    textareaRef.current.setSelectionRange(charPos, charPos + lineLen);
    // Scroll the target line into view using the textarea's ACTUAL metrics.
    // The previous hardcoded 21px under-shot the real 22.75px line rhythm
    // (14px font, leading-relaxed) plus the 16px top padding, so every jump
    // landed a growing number of lines short (21 vs 22.75 → ~8px high per line).
    const cs = window.getComputedStyle(textareaRef.current);
    const lineHeight = parseFloat(cs.lineHeight) || 22.75;
    const paddingTop = parseFloat(cs.paddingTop) || 16;
    const lineTop = paddingTop + (line - 1) * lineHeight;
    const viewportH = textareaRef.current.clientHeight || 400;
    // Bring the line to ~20% down from the top of the visible area.
    textareaRef.current.scrollTop = Math.max(0, lineTop - viewportH * 0.2);
    syncLineNumbersScroll();
  }, [syncLineNumbersScroll]);

  const handleSearchResultClick = (file: string, line: number) => {
    if (file !== activeFile) {
      setActiveFile(file);
    }
    // Select the matching line after state settles
    setTimeout(() => {
      jumpToLine(line);
    }, 0);
  };

  const toggleSearch = () => {
    setShowSearch((prev) => {
      if (prev) setSearchQuery('');
      return !prev;
    });
  };

  const toggleSectionExpanded = useCallback((sectionId: string) => {
    setExpandedSections((current) => ({
      ...current,
      [sectionId]: !current[sectionId],
    }));
  }, []);

  // Close context menu on outside click
  useEffect(() => {
    if (!contextMenu) return;
    const handler = () => setContextMenu(null);
    window.addEventListener('click', handler);
    return () => window.removeEventListener('click', handler);
  }, [contextMenu]);

  // Ensure filename ends with .cfg
  const ensureCfgExtension = (name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return '';
    return trimmed.endsWith('.cfg') ? trimmed : `${trimmed}.cfg`;
  };

  // Check for duplicate file name
  const isDuplicateFileName = (name: string, excludeOriginal?: string) => {
    const target = name.toLowerCase();
    return Object.keys(configFiles).some((fn) => fn.toLowerCase() === target && fn !== excludeOriginal);
  };

  // File context menu handlers
  const handleFileContextMenu = (e: React.MouseEvent, file: string) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, file });
  };

  const handleRenameFile = () => {
    if (!contextMenu) return;
    if (contextMenu.file === 'printer.cfg') return; // Cannot rename printer.cfg
    setRenameDialog({ file: contextMenu.file, value: contextMenu.file.replace(/\.cfg$/, '') });
    setFileError('');
    setContextMenu(null);
  };

  const handleRenameConfirm = async () => {
    if (!renameDialog) return;
    const newName = ensureCfgExtension(renameDialog.value);
    if (!newName) return;
    if (newName === renameDialog.file) {
      setRenameDialog(null);
      return;
    }
    if (isDuplicateFileName(newName, renameDialog.file)) {
      setFileError(`"${newName}" already exists. Choose a different name.`);
      return;
    }
    renameConfigFile(renameDialog.file, newName);
    // Update graph nodes referencing this file
    const graphState = useGraphStore.getState();
    for (const node of graphState.nodes) {
      const d = node.data as Record<string, unknown>;
      if (d.configFile === renameDialog.file) {
        graphState.updateNodeData(node.id, { configFile: newName } as Partial<typeof node.data>);
      }
    }
    setRenameDialog(null);
    setFileError('');
  };

  const handleCopyFile = async () => {
    if (!contextMenu) return;
    const base = contextMenu.file.replace(/\.cfg$/, '');
    let copyName = `${base}_copy.cfg`;
    let counter = 1;
    while (isDuplicateFileName(copyName)) {
      counter++;
      copyName = `${base}_copy${counter}.cfg`;
    }
    copyConfigFile(contextMenu.file, copyName);
    setActiveFile(copyName);
    setContextMenu(null);
  };

  const doDeleteFile = useCallback(async (fileToDelete: string) => {
    // Remove graph nodes associated with this file
    const graphState = useGraphStore.getState();
    const nodesToRemove = graphState.nodes.filter(
      (n) => (n.data as Record<string, unknown>).configFile === fileToDelete,
    );
    for (const n of nodesToRemove) {
      graphState.removeNode(n.id);
    }
    removeConfigFile(fileToDelete);
    // Switch to another file — the config→text effect re-exports the new file
    const remaining = Object.keys(useConfigStore.getState().configFiles);
    if (remaining.length > 0) {
      setActiveFile(remaining[0]);
    }
  }, [removeConfigFile, setActiveFile]);

  // Add Configuration handlers
  const handleAddConfigBlank = () => {
    const name = ensureCfgExtension(newFileName);
    if (!name) return;
    if (isDuplicateFileName(name)) {
      setFileError(`"${name}" already exists. Choose a different name.`);
      return;
    }
    updateConfigFile(name, {
      filename: name,
      sections: [],
      includes: [],
      header_comments: [],
    });
    setActiveFile(name);
    setEditText('');
    setShowAddConfig(false);
    setAddConfigStep('choose');
    setNewFileName('');
    setFileError('');
  };

  // Load reference list for Add Configuration
  useEffect(() => {
    if (addConfigStep !== 'reference-pick') return;
    const timer = setTimeout(() => {
      const query = referenceSearch.trim();
      (query ? api.searchExamples(query) : api.listExamples())
        .then((res) => {
          const list = (res as { results?: ExampleConfig[] }).results
            || (res as { examples: ExampleConfig[] }).examples || [];
          setReferenceResults(list);
        })
        .catch(() => setReferenceResults([]));
    }, 200);
    return () => clearTimeout(timer);
  }, [referenceSearch, addConfigStep]);

  // Validation shown for a file: the store validation — text edits apply to
  // the model on every successful parse, so the store is always current.
  const getFileValidation = (fn: string) => validation[fn];

  const handleAddConfigFromReference = async (example: ExampleConfig) => {
    try {
      const res = await api.getExample(example.filename);
      let name = example.filename;
      // Ensure unique filename
      if (isDuplicateFileName(name)) {
        const base = name.replace(/\.cfg$/, '');
        let counter = 1;
        name = `${base}_${counter}.cfg`;
        while (isDuplicateFileName(name)) {
          counter++;
          name = `${base}_${counter}.cfg`;
        }
      }
      updateConfigFile(name, {
        filename: name,
        sections: res.config.sections,
        includes: res.config.includes || [],
        header_comments: res.config.header_comments || [],
      });
      setActiveFile(name);

      // Full rebuild over ALL config files (mirrors the import path).
      // The previous code did clearGraph() + syncGraphWithConfig(name) —
      // a single-file sync that can only add sections to EXISTING hardware
      // nodes, so after clearGraph() deleted them nothing could be
      // recreated and the canvas went empty.
      const configStore = useConfigStore.getState();
      const graphStore = useGraphStore.getState();
      graphStore.clearGraph();
      buildProjectGraph(configStore.configFiles, graphStore, configStore.schemas, configStore.validation);
      // The rebuild renumbers node ids — re-apply the saved layout so the
      // new file appears in the user's existing arrangement instead of
      // resetting every card to auto-arranged.
      await restoreLayoutAfterRebuild(useGraphStore.getState, useNativeStore.getState().isNative);
    } catch (err) {
      console.error('Failed to load reference config:', err);
    }
    setShowAddConfig(false);
    setAddConfigStep('choose');
    setReferenceSearch('');
    setReferenceResults([]);
  };

  return (
    <div className="flex h-full bg-[var(--color-bg-primary)]">
      {/* File list sidebar */}
      {showFileSidebar && (
      <div className="w-48 shrink-0 flex flex-col bg-[var(--color-bg-secondary)] border-r border-[var(--color-bg-tertiary)]">
        <div className="px-3 py-2 shrink-0 border-b border-[var(--color-bg-tertiary)] flex items-center justify-between">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-secondary)]">Files</span>
          <div className="flex items-center gap-1">
            <button
              onClick={() => { setShowAddConfig(true); setAddConfigStep('choose'); setFileError(''); }}
              title="Add Configuration"
              className="text-[var(--color-text-secondary)] hover:text-[var(--color-accent)] transition-colors"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
              </svg>
            </button>
            <button
              onClick={() => setShowFileSidebar(false)}
              title="Collapse files"
              className="rounded border border-[var(--color-bg-tertiary)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--color-text-secondary)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
            >
              {'<'}
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto py-1">
          {filenames.map((fn) => {
            const v = getFileValidation(fn);
            const fileErrors = v?.errors.filter((e) => e.severity === 'error') ?? [];
            const fileWarnings = v?.errors.filter((e) => e.severity === 'warning') ?? [];
            return (
              <button
                key={fn}
                onClick={() => handleFileSwitch(fn)}
                onContextMenu={(e) => handleFileContextMenu(e, fn)}
                title={fn}
                className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs font-medium transition-colors ${
                  fn === activeFile
                    ? 'bg-[var(--color-accent)] text-[var(--color-bg-primary)]'
                    : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-primary)]'
                }`}
              >
                <span className="min-w-0 flex-1 truncate">{fn}</span>
                {fileErrors.length > 0 ? (
                  <span
                    className="w-2 h-2 rounded-full bg-[var(--color-error)] shrink-0"
                    title={`${fileErrors.length} error${fileErrors.length > 1 ? 's' : ''}`}
                  />
                ) : fileWarnings.length > 0 ? (
                  <span
                    className="w-2 h-2 rounded-full bg-[var(--color-warning)] shrink-0"
                    title={`${fileWarnings.length} warning${fileWarnings.length > 1 ? 's' : ''}`}
                  />
                ) : null}
              </button>
            );
          })}
        </div>
      </div>
      )}
      {!showFileSidebar && (
        <div className="flex w-10 shrink-0 items-start justify-center border-r border-[var(--color-bg-tertiary)] bg-[var(--color-bg-secondary)] pt-2">
          <button
            onClick={() => setShowFileSidebar(true)}
            title="Show files"
            className="rounded border border-[var(--color-bg-tertiary)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--color-text-secondary)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
          >
            {'>'}
          </button>
        </div>
      )}

      {/* File context menu */}
      {contextMenu && (
        <div
          className="fixed z-50 bg-[var(--color-bg-secondary)] border border-[var(--color-bg-tertiary)] rounded-lg shadow-xl py-1 min-w-[140px]"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            onClick={handleRenameFile}
            disabled={contextMenu.file === 'printer.cfg'}
            className="w-full text-left px-3 py-1.5 text-xs hover:bg-[var(--color-bg-tertiary)] transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          >
            Rename
          </button>
          <button
            onClick={handleCopyFile}
            className="w-full text-left px-3 py-1.5 text-xs hover:bg-[var(--color-bg-tertiary)] transition-colors"
          >
            Duplicate
          </button>
          <div className="h-px bg-[var(--color-bg-tertiary)] my-1" />
          <button
            onClick={() => {
              if (contextMenu.file === 'printer.cfg') return;
              setConfirmDelete({ file: contextMenu.file });
              setContextMenu(null);
            }}
            disabled={contextMenu.file === 'printer.cfg'}
            className="w-full text-left px-3 py-1.5 text-xs text-[var(--color-error)] hover:bg-[var(--color-bg-tertiary)] transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          >
            Delete
          </button>
        </div>
      )}

      {/* Delete confirmation dialog */}
      {confirmDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setConfirmDelete(null)}>
          <div className="bg-[var(--color-bg-secondary)] rounded-xl border border-[var(--color-bg-tertiary)] shadow-2xl p-5 w-80" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-sm font-semibold text-[var(--color-text-primary)] mb-2">Delete File</h3>
            <p className="text-xs text-[var(--color-text-secondary)] mb-4">
              Delete <span className="font-mono text-[var(--color-text-primary)]">{confirmDelete.file}</span> and its graph nodes? This can&apos;t be undone.
            </p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setConfirmDelete(null)} className="px-3 py-1.5 rounded text-xs bg-[var(--color-bg-tertiary)] text-[var(--color-text-primary)]">Cancel</button>
              <button
                onClick={() => {
                  const file = confirmDelete.file;
                  setConfirmDelete(null);
                  void doDeleteFile(file);
                }}
                className="px-3 py-1.5 rounded text-xs bg-[var(--color-error)] text-[var(--color-bg-primary)]"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Rename dialog */}
      {renameDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => { setRenameDialog(null); setFileError(''); }}>
          <div className="bg-[var(--color-bg-secondary)] rounded-xl border border-[var(--color-bg-tertiary)] shadow-2xl p-5 w-80" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-sm font-semibold text-[var(--color-text-primary)] mb-3">Rename File</h3>
            <div className="flex items-center gap-1">
              <input
                type="text"
                value={renameDialog.value}
                onChange={(e) => { setRenameDialog({ ...renameDialog, value: e.target.value }); setFileError(''); }}
                onKeyDown={(e) => { if (e.key === 'Enter') handleRenameConfirm(); if (e.key === 'Escape') { setRenameDialog(null); setFileError(''); } }}
                className="flex-1 px-2 py-1.5 rounded text-sm bg-[var(--color-bg-primary)] border border-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-accent)]"
                autoFocus
              />
              <span className="text-xs text-[var(--color-text-secondary)]">.cfg</span>
            </div>
            {fileError && <p className="text-xs text-[var(--color-error)] mt-2">{fileError}</p>}
            <div className="flex justify-end gap-2 mt-4">
              <button onClick={() => { setRenameDialog(null); setFileError(''); }} className="px-3 py-1.5 rounded text-xs bg-[var(--color-bg-tertiary)] text-[var(--color-text-primary)]">Cancel</button>
              <button onClick={handleRenameConfirm} className="px-3 py-1.5 rounded text-xs bg-[var(--color-accent)] text-[var(--color-bg-primary)]">Rename</button>
            </div>
          </div>
        </div>
      )}

      {/* Add Configuration dialog */}
      {showAddConfig && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => { setShowAddConfig(false); setAddConfigStep('choose'); setNewFileName(''); setFileError(''); setReferenceSearch(''); }}>
          <div className="bg-[var(--color-bg-secondary)] rounded-xl border border-[var(--color-bg-tertiary)] shadow-2xl w-[480px] max-h-[70vh] overflow-hidden" onClick={(e) => e.stopPropagation()}>
            <div className="px-5 py-4 border-b border-[var(--color-bg-tertiary)]">
              <h3 className="text-sm font-semibold text-[var(--color-text-primary)]">Add Configuration</h3>
            </div>

            <div className="p-5 overflow-y-auto max-h-[calc(70vh-60px)]">
              {addConfigStep === 'choose' && (
                <div className="grid grid-cols-2 gap-3">
                  <button
                    onClick={() => { setAddConfigStep('blank-name'); setFileError(''); }}
                    className="flex flex-col items-center gap-2 p-5 rounded-lg border border-[var(--color-bg-tertiary)] hover:border-[var(--color-accent)] hover:bg-[var(--color-bg-primary)] transition-all"
                  >
                    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" className="text-[var(--color-text-secondary)]">
                      <rect x="4" y="4" width="16" height="16" rx="2" stroke="currentColor" strokeWidth="1.5"/>
                      <path d="M12 8v8M8 12h8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                    </svg>
                    <span className="text-xs font-medium text-[var(--color-text-primary)]">Blank</span>
                    <span className="text-[10px] text-[var(--color-text-secondary)]">Empty config file</span>
                  </button>
                  <button
                    onClick={() => { setAddConfigStep('reference-pick'); setReferenceSearch(''); }}
                    className="flex flex-col items-center gap-2 p-5 rounded-lg border border-[var(--color-bg-tertiary)] hover:border-[var(--color-accent)] hover:bg-[var(--color-bg-primary)] transition-all"
                  >
                    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" className="text-[var(--color-accent)]">
                      <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>
                      <path d="M14 2v6h6" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>
                    </svg>
                    <span className="text-xs font-medium text-[var(--color-text-primary)]">From Reference</span>
                    <span className="text-[10px] text-[var(--color-text-secondary)]">Pick from templates</span>
                  </button>
                </div>
              )}

              {addConfigStep === 'blank-name' && (
                <div>
                  <button
                    onClick={() => setAddConfigStep('choose')}
                    className="text-xs text-[var(--color-accent)] hover:text-[var(--color-accent-hover)] mb-3"
                  >
                    &larr; Back
                  </button>
                  <label className="text-xs text-[var(--color-text-secondary)] mb-2 block">File name</label>
                  <div className="flex items-center gap-1">
                    <input
                      type="text"
                      value={newFileName}
                      onChange={(e) => { setNewFileName(e.target.value); setFileError(''); }}
                      onKeyDown={(e) => { if (e.key === 'Enter') handleAddConfigBlank(); }}
                      placeholder="e.g. macros"
                      className="flex-1 px-3 py-2 rounded-lg text-sm bg-[var(--color-bg-primary)] border border-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]"
                      autoFocus
                    />
                    <span className="text-xs text-[var(--color-text-secondary)]">.cfg</span>
                  </div>
                  {fileError && <p className="text-xs text-[var(--color-error)] mt-2">{fileError}</p>}
                  <button
                    onClick={handleAddConfigBlank}
                    disabled={!newFileName.trim()}
                    className="mt-4 w-full py-2 rounded-lg text-sm font-semibold bg-[var(--color-accent)] text-[var(--color-bg-primary)] hover:bg-[var(--color-accent-hover)] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    Create
                  </button>
                </div>
              )}

              {addConfigStep === 'reference-pick' && (
                <div>
                  <button
                    onClick={() => setAddConfigStep('choose')}
                    className="text-xs text-[var(--color-accent)] hover:text-[var(--color-accent-hover)] mb-3"
                  >
                    &larr; Back
                  </button>
                  <input
                    type="text"
                    placeholder="Search reference configs..."
                    value={referenceSearch}
                    onChange={(e) => setReferenceSearch(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg text-sm bg-[var(--color-bg-primary)] border border-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)] mb-3"
                    autoFocus
                  />
                  <div className="space-y-1 max-h-60 overflow-y-auto">
                    {referenceResults.map((ex) => (
                      <button
                        key={ex.filename}
                        onClick={() => handleAddConfigFromReference(ex)}
                        className="flex items-center justify-between w-full p-2.5 rounded-lg text-left transition-all border border-transparent hover:border-[var(--color-accent)] hover:bg-[var(--color-bg-primary)]"
                      >
                        <div className="min-w-0">
                          <div className="text-xs font-medium text-[var(--color-text-primary)] truncate">{ex.name}</div>
                          <div className="text-[10px] text-[var(--color-text-secondary)] truncate">{ex.filename}</div>
                        </div>
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-400 shrink-0 ml-2">
                          {ex.category}
                        </span>
                      </button>
                    ))}
                    {referenceResults.length === 0 && referenceSearch && (
                      <p className="text-xs text-[var(--color-text-secondary)] text-center py-4">No matching configs found</p>
                    )}
                    {referenceResults.length === 0 && !referenceSearch && (
                      <p className="text-xs text-[var(--color-text-secondary)] text-center py-4">Type to search reference configs...</p>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Editor area */}
      <div className="flex flex-col flex-1 min-w-0">
        {/* Editor toolbar */}
        <div className="flex items-center justify-between px-3 py-1.5 bg-[var(--color-bg-secondary)] border-b border-[var(--color-bg-tertiary)] shrink-0">
          <span className="text-xs text-[var(--color-text-secondary)] truncate mr-2">
            {isDirty ? '● Unsaved changes' : 'Editing ' + activeFile}
          </span>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={() => setShowReferenceViewer(true)}
              className="px-2 py-1 rounded text-xs font-medium bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)] hover:bg-[var(--color-accent)] hover:text-[var(--color-bg-primary)]"
            >
              Configuration Reference
            </button>
            <button
              onClick={toggleSearch}
              className={`flex items-center gap-1.5 px-2 py-1 rounded text-xs font-medium transition-colors ${
                showSearch
                  ? 'bg-[var(--color-accent)] text-[var(--color-bg-primary)]'
                  : 'bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)] hover:bg-[var(--color-accent)] hover:text-[var(--color-bg-primary)]'
              }`}
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                <circle cx="6.5" cy="6.5" r="4" stroke="currentColor" strokeWidth="1.5" />
                <path d="M10.5 10.5l3.5 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
              Search
            </button>
          </div>
        </div>

        {/* Lossy export fallback banner */}
        {fallbackExportUsed && (
          <div className="shrink-0 border-b border-[var(--color-bg-tertiary)] bg-[var(--color-bg-secondary)] px-3 py-1.5 flex items-center gap-2">
            <span className="text-xs text-[var(--color-warning)] flex-1">
              Using offline text export — edits may normalize comments and formatting.
            </span>
            <button
              onClick={() => markFallbackExport(activeFile, false)}
              title="Dismiss"
              className="text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]"
            >
              ✕
            </button>
          </div>
        )}

        {/* Parse failure banner — the model holds last-good; Save blocks until this clears */}
        {parseError && (
          <div className="shrink-0 border-b border-[var(--color-bg-tertiary)] bg-[var(--color-bg-secondary)] px-3 py-1.5 flex items-center gap-2">
            <span className="text-xs text-[var(--color-error)] flex-1">
              Couldn&apos;t parse this file — showing the last valid configuration. Fix the text to re-enable saving.
            </span>
          </div>
        )}

        {/* Search panel */}
        {showSearch && (
          <div className="shrink-0 bg-[var(--color-bg-secondary)] border-b border-[var(--color-bg-tertiary)]">
            <div className="flex items-center gap-2 px-3 py-2">
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" className="shrink-0 text-[var(--color-text-secondary)]">
                <circle cx="6.5" cy="6.5" r="4" stroke="currentColor" strokeWidth="1.5" />
                <path d="M10.5 10.5l3.5 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
              <input
                ref={searchInputRef}
                type="text"
                placeholder="Search all files…"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Escape') toggleSearch(); }}
                className="flex-1 bg-[var(--color-bg-primary)] text-[var(--color-text-primary)] text-xs font-mono px-2 py-1 rounded border border-[var(--color-bg-tertiary)] focus:outline-none focus:border-[var(--color-accent)]"
              />
              {searchQuery.trim() && (
                <span className="text-[10px] text-[var(--color-text-secondary)] shrink-0">
                  {searchResults.length}{searchResults.length === 200 ? '+' : ''} match{searchResults.length !== 1 ? 'es' : ''}
                </span>
              )}
            </div>
            {searchResults.length > 0 && (
              <div className="max-h-52 overflow-y-auto border-t border-[var(--color-bg-tertiary)]">
                {searchResults.map((r, i) => (
                  <button
                    key={i}
                    onClick={() => handleSearchResultClick(r.file, r.line)}
                    className="w-full text-left px-3 py-1.5 text-xs hover:bg-[var(--color-bg-tertiary)] flex items-baseline gap-2 transition-colors"
                  >
                    <span className="text-[var(--color-accent)] shrink-0 font-medium">{r.file}</span>
                    <span className="text-[var(--color-text-secondary)] shrink-0">:{r.line}</span>
                    <span className="font-mono text-[var(--color-text-primary)] truncate">
                      {r.lineText.slice(0, r.matchStart)}
                      <mark className="bg-[var(--color-accent)] text-[var(--color-bg-primary)] rounded-sm not-italic">
                        {r.lineText.slice(r.matchStart, r.matchEnd)}
                      </mark>
                      {r.lineText.slice(r.matchEnd)}
                    </span>
                  </button>
                ))}
              </div>
            )}
            {searchQuery.trim() && searchResults.length === 0 && (
              <p className="px-3 py-2 text-xs text-[var(--color-text-secondary)] border-t border-[var(--color-bg-tertiary)]">
                No matches found.
              </p>
            )}
          </div>
        )}

        {/* Editor with line numbers and inline issues */}
        <div className="flex-1 flex overflow-hidden">
          <div className="flex flex-col flex-1 min-w-0 relative">
            <div className="flex-1 flex overflow-hidden" ref={editorScrollRef}>
              {/* Line numbers + issue indicators */}
              <div
                ref={lineNumbersRef}
                className="shrink-0 overflow-hidden bg-[var(--color-bg-secondary)] text-right select-none pr-2 pl-2 pt-4 pb-4 font-mono text-sm leading-relaxed text-[var(--color-text-secondary)] border-r border-[var(--color-bg-tertiary)]"
                style={{ minWidth: '3rem' }}
              >
                {editText.split('\n').map((_line, idx) => {
                  const lineNum = idx + 1;
                  const lineIssues = issuesByLine.get(lineNum);
                  const hasError = lineIssues?.some((i) => i.severity === 'error');
                  const hasWarning = !hasError && lineIssues?.some((i) => i.severity === 'warning');
                  const hasInfo = !hasError && !hasWarning && lineIssues?.some((i) => i.severity === 'info');
                  return (
                    <div
                      key={lineNum}
                      className="h-[1.625em] flex items-center justify-end"
                      title={lineIssues?.map((i) => i.text).join('\n')}
                    >
                      {hasError && <span className={`${ISSUE_MARKER.error.gutterDotClass} mr-1 shrink-0`} />}
                      {hasWarning && <span className={`${ISSUE_MARKER.warning.gutterDotClass} mr-1 shrink-0`} />}
                      {hasInfo && <span className={`${ISSUE_MARKER.info.gutterDotClass} mr-1 shrink-0`} />}
                      <span>{lineNum}</span>
                    </div>
                  );
                })}
              </div>
              {/* Text area with syntax color parsing overlay */}
              <div className="relative flex-1 overflow-hidden">
                <pre
                  ref={highlightRef}
                  aria-hidden
                  className="pointer-events-none absolute inset-0 overflow-auto p-4 font-mono text-sm leading-relaxed"
                  style={{ margin: 0, tabSize: 4 }}
                  dangerouslySetInnerHTML={{ __html: highlightedHtml }}
                />
                <textarea
                  ref={textareaRef}
                  aria-label="Configuration text editor with syntax highlighting overlay"
                  value={editText}
                  onChange={(e) => handleTextChange(e.target.value)}
                  onScroll={syncLineNumbersScroll}
                  spellCheck={false}
                  wrap="off"
                  // Text is intentionally transparent; syntax-highlighted text is rendered in the overlay <pre>.
                  className="absolute inset-0 w-full resize-none overflow-auto bg-transparent p-4 font-mono text-sm leading-relaxed text-transparent caret-[var(--color-text-primary)] focus:outline-none"
                  style={{ tabSize: 4 }}
                />
              </div>
            </div>
            {/* Inline issue messages below editor lines */}
            {inlineIssues.filter((i) => i.line > 0).length > 0 && (
              <div className="shrink-0 border-t border-[var(--color-bg-tertiary)] bg-[var(--color-bg-secondary)] max-h-32 overflow-y-auto">
                {inlineIssues.filter((i) => i.line > 0).map((issue, idx) => (
                  <div
                    key={idx}
                    className="flex items-center gap-2 px-3 py-1 text-xs cursor-pointer hover:bg-[var(--color-bg-tertiary)]"
                    style={{ color: ISSUE_MARKER[issue.severity].color }}
                    onClick={() => {
                      jumpToLine(issue.line);
                    }}
                  >
                    <span>{ISSUE_MARKER[issue.severity].marker}</span>
                    <span className="min-w-0 flex-1 truncate">Line {issue.line}: {issue.text}</span>
                    {issue.acknowledgeSection && (
                      <button
                        onClick={(event) => {
                          event.stopPropagation();
                          void handleAcknowledgeWarning(issue.acknowledgeSection!, issue.acknowledgeKind ?? 'unknown');
                        }}
                        className="shrink-0 rounded border border-[var(--color-warning)] px-2 py-0.5 text-[10px] font-medium text-[var(--color-warning)] hover:bg-[var(--color-warning)] hover:text-[var(--color-bg-primary)] transition-colors"
                        title={issue.acknowledgeKind === 'duplicate'
                          ? 'Acknowledge this duplicate section warning and stop flagging the save button'
                          : 'Acknowledge this unknown section and hide its warning in future validations'}
                      >
                        Acknowledge
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Apply warning dialog */}
        {/* Removed — text edits apply to the model directly; validation rides
            along and colors the Save button instead of gating anything. */}

        {showReferenceViewer && (
          <ConfigReferenceDialog onClose={() => setShowReferenceViewer(false)} />
        )}
      </div>

      {showSectionsSidebar ? (
        <div className="w-64 shrink-0 flex flex-col bg-[var(--color-bg-secondary)] border-l border-[var(--color-bg-tertiary)]">
          <div className="px-3 py-2 shrink-0 border-b border-[var(--color-bg-tertiary)] flex items-center justify-between gap-2">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-secondary)]">Sections</span>
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-[var(--color-text-secondary)]">{sectionEntries.length}</span>
              <button
                onClick={() => setShowSectionsSidebar(false)}
                title="Collapse sections"
                className="rounded border border-[var(--color-bg-tertiary)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--color-text-secondary)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
              >
                {'>'}
              </button>
            </div>
          </div>
          <div className="flex-1 overflow-y-auto py-1">
            {sectionEntries.map((entry) => {
              const isExpanded = !!expandedSections[entry.id];
              const hasParams = entry.params.length > 0;
              const activeValidation = getFileValidation(activeFile);
              const sectionIssues = (activeValidation?.errors ?? []).filter((e) => e.section === entry.title);
              const hasSecError = sectionIssues.some((e) => e.severity === 'error');
              const hasSecWarning = !hasSecError && sectionIssues.some((e) => e.severity === 'warning');
              const hasSecInfo = !hasSecError && !hasSecWarning && sectionIssues.some((e) => e.severity === 'info');
              return (
                <div key={entry.id} className="px-2 py-0.5">
                  <div className="flex items-start gap-1">
                    <button
                      type="button"
                      disabled={!hasParams}
                      onClick={(event) => {
                        event.stopPropagation();
                        toggleSectionExpanded(entry.id);
                      }}
                      className={`mt-[1px] flex h-5 w-5 shrink-0 items-center justify-center rounded text-[10px] font-semibold ${hasParams ? 'text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-primary)]' : 'cursor-default opacity-0'}`}
                    >
                      {isExpanded ? 'v' : '>'}
                    </button>
                    <button
                      onClick={() => jumpToLine(entry.line)}
                      className={`min-w-0 flex-1 flex items-center gap-2 rounded-md px-2 py-1 text-left text-xs hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-primary)] ${entry.isCommented ? 'text-[var(--color-text-secondary)]/70' : 'text-[var(--color-text-secondary)]'}`}
                    >
                      <span className="shrink-0 font-mono text-[10px] text-[var(--color-accent)]">{entry.line}</span>
                      <span className="min-w-0 flex-1 truncate">{entry.title}</span>
                      {hasSecError ? (
                        <span className="w-2 h-2 rounded-full bg-[var(--color-error)] shrink-0" title="This section has validation errors" />
                      ) : hasSecWarning ? (
                        <span className="w-2 h-2 rounded-full bg-[var(--color-warning)] shrink-0" title="This section has warnings" />
                      ) : hasSecInfo ? (
                        <span className={`${ISSUE_MARKER.info.dotClass} shrink-0`} title="This section has info notes (legal, no action required)" />
                      ) : null}
                    </button>
                  </div>
                  {isExpanded && hasParams && (
                    <div className="ml-6 mt-1 space-y-0.5">
                      {entry.params.map((param) => (
                        <button
                          key={`${entry.id}-${param.key}-${param.line}`}
                          onClick={() => jumpToLine(param.line)}
                          className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[11px] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-primary)]"
                        >
                          <span className="shrink-0 font-mono text-[10px] text-[var(--color-accent)]">{param.line}</span>
                          <span className="truncate">{param.key}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
            {sectionEntries.length === 0 && (
              <div className="px-3 py-3 text-xs text-[var(--color-text-secondary)]">No sections found.</div>
            )}
          </div>
        </div>
      ) : (
        <div className="flex w-10 shrink-0 items-start justify-center border-l border-[var(--color-bg-tertiary)] bg-[var(--color-bg-secondary)] pt-2">
          <button
            onClick={() => setShowSectionsSidebar(true)}
            title="Show sections"
            className="rounded border border-[var(--color-bg-tertiary)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--color-text-secondary)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
          >
            {'<'}
          </button>
        </div>
      )}
    </div>
  );
}

export default TextEditor;

function configToText(config: { header_comments: string[]; includes: string[]; sections: Array<{ section_type: string; full_header: string; is_commented_out?: boolean; params: Array<{ key: string; value: string; comment: string; is_commented_out: boolean }> }> }): string {
  let lines: string[] = [];

  for (const c of config.header_comments) {
    lines.push(c);
  }
  if (config.header_comments.length) lines.push('');

  for (const inc of config.includes) {
    lines.push(`[include ${inc}]`);
  }
  if (config.includes.length) lines.push('');

  for (const sec of config.sections) {
    if (sec.section_type === 'include') continue;
    // Detect suppressed sections: section-level flag or all non-comment params commented out
    const realParams = sec.params.filter((p: { key: string }) => p.key !== '_comment_');
    const isSuppressed = sec.is_commented_out || (realParams.length > 0 && realParams.every((p: { is_commented_out: boolean }) => p.is_commented_out));
    lines.push(isSuppressed ? `#[${sec.full_header}]` : `[${sec.full_header}]`);
    for (const p of sec.params) {
      // _comment_ pseudo-params are standalone comment lines — emit as-is
      if (p.key === '_comment_') {
        lines.push(p.value);
        continue;
      }
      const prefix = p.is_commented_out ? '#' : '';
      const comment = p.comment ? `   # ${p.comment}` : '';
      if (p.value.includes('\n')) {
        const parts = p.value.split('\n');
        lines.push(`${prefix}${p.key}: ${parts[0]}`);
        for (const part of parts.slice(1)) {
          lines.push(`${prefix}    ${part}`);
        }
      } else {
        lines.push(`${prefix}${p.key}: ${p.value}${comment}`);
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function buildHighlightedHtml(text: string): string {
  const lines = text.split('\n');
  return lines.map((line) => {
    const escaped = escapeHtml(line);
    if (/^\s*#/.test(line)) {
      return `<span style="color: var(--color-text-secondary)">${escaped}</span>`;
    }
    const sectionMatch = line.match(/^\s*(#?)\[([^\]]+)\]\s*$/);
    if (sectionMatch) {
      const prefix = sectionMatch[1] ? '<span style="color: var(--color-text-secondary)">#</span>' : '';
      return `${prefix}<span style="color: #22d3ee">[${escapeHtml(sectionMatch[2])}]</span>`;
    }
    const includeMatch = line.match(/^\s*\[include\s+([^\]]+)\]\s*$/i);
    if (includeMatch) {
      return `<span style="color: #a78bfa">[include ${escapeHtml(includeMatch[1])}]</span>`;
    }
    const paramMatch = line.match(/^(\s*)(#?)([A-Za-z0-9_][A-Za-z0-9_\-]*)(\s*[:=]\s*)(.*)$/);
    if (paramMatch) {
      const [, ws, hash, key, sep, rawValue] = paramMatch;
      return `${escapeHtml(ws)}${hash ? '<span style="color: var(--color-text-secondary)">#</span>' : ''}<span style="color: #60a5fa">${escapeHtml(key)}</span><span style="color: var(--color-text-secondary)">${escapeHtml(sep)}</span><span style="color: var(--color-text-primary)">${escapeHtml(rawValue)}</span>`;
    }
    return escaped || ' ';
  }).join('\n');
}
