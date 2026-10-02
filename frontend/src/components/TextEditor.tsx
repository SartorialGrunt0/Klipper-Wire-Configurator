import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { useConfigStore } from '../stores/configStore';
import { useGraphStore } from '../stores/graphStore';
import { useNativeStore } from '../stores/nativeStore';
import { useVisibility } from '../stores/validationSettingsStore';
import * as api from '../services/api';
import ConfigReferenceDialog from './dialogs/ConfigReferenceDialog';
import { buildProjectGraph } from '../utils/graphBuilder';
import { restoreLayoutAfterRebuild } from '../utils/layoutPersistence';
import { acknowledgeableWarning } from '../utils/warningAcknowledgment';
import { resolveIssueLine } from '../utils/issueLine';
import { ISSUE_MARKER } from '../utils/issueMarker';
import { filterFindings } from '../utils/validationVisibility';
import { indentCaret, indentSelection, outdentSelection } from '../utils/textIndent';
import { autoScrollDelta } from '../utils/editorAutoScroll';
import { buildHighlightedHtml, escapeHtml } from '../utils/editorHighlight';
import { lineSeverities, worstSeverity } from '../utils/issueSummary';
import { readIssueStripCollapsed, writeIssueStripCollapsed } from '../utils/editorPrefs';
import { findHits, replaceAll, replaceOne, countHits, type FindHit } from '../utils/findReplace';
import {
  completionsAt,
  acceptAt,
  applyCandidate,
  type CompletionResult,
  type CompletionSources,
} from '../utils/configCompletion';
import { caretLineColumn, measureCaretRect } from '../utils/caretGeometry';
import { useGcodeCommandStore } from '../stores/gcodeCommandStore';
import { sectionAtLine } from '../utils/configOutline';
import EditorIssueStrip from './EditorIssueStrip';
import ConfigTree from './ConfigTree';
import ChatDock from './ChatDock';
import { useUiStore } from '../stores/uiStore';
import { useAiStore } from '../stores/aiStore';
import { useChatReferenceStore } from '../stores/chatReferenceStore';
import { selectionToReference } from '../utils/chatReferences';
import { useMediaQuery, WIDE_VIEWPORT_QUERY } from '../hooks/useMediaQuery';
import type { TextIssue } from '../types/editor';
import type { ExampleConfig, ConfigFile, ConfigSection, ValidationError } from '../types/config';

interface SearchResult {
  file: string;
  line: number;
  lineText: string;
  matchStart: number;
  matchEnd: number;
}

/** A pasted line is not something to complete. */
const MAX_COMPLETION_LINE = 200;

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
    revalidateAll,
    pendingLineJump,
  } = useConfigStore();
  const isDirty = useConfigStore((s) => s.isDirty);
  const parseError = useConfigStore((s) => s.textParseErrors[activeFile]);
  const validationText = useConfigStore((s) => s.validationText);
  const visibility = useVisibility();

  const config = configFiles[activeFile];
  const filenames = Object.keys(configFiles);

  const [editText, setEditText] = useState('');
  // Which file the textarea text currently belongs to. Cross-file jumps must
  // not consume against another file's text: on a file switch the export is
  // async, so editText lags activeFile until it lands. Kept in sync by the
  // export effect (sets it when a file's text lands) and the switch reset
  // (clears it so a stale jump re-attempts after the new text arrives).
  const [editTextFile, setEditTextFile] = useState(activeFile);

  // ── Docked chat panel ───────────────────────────────────────────
  // A real flex column on the right that pushes the editor's width — not an
  // overlay. Text view only, and only when there is room: below `lg` the
  // toolbar button opens the modal instead. The fold flag is remembered
  // either way.
  const showChatDock = useUiStore((s) => s.showChatDock);
  const setShowChatDock = useUiStore((s) => s.setShowChatDock);
  const registerDockHost = useUiStore((s) => s.setDockHost);
  const aiConfigured = useAiStore((s) => s.isConfigured());
  const wideViewport = useMediaQuery(WIDE_VIEWPORT_QUERY);
  const dockAvailable = isActive && wideViewport;
  // Which tree row is currently the dock's preview, so it can highlight it.
  const previewReferenceId = useChatReferenceStore((s) => s.preview?.id ?? null);

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
      setEditTextFile('');
      return;
    }
    const requestId = ++exportTextRef.current;
    exportingRef.current = true;
    exportConfigText(config).then(({ text, usedFallback }) => {
      if (requestId === exportTextRef.current) {
        setEditText(text);
        setEditTextFile(activeFile);
        markFallbackExport(activeFile, usedFallback);
      }
    });
  }, [isActive, activeFile, config, exportConfigText, markFallbackExport]);

  const [showSearch, setShowSearch] = useState(false);
  const [showReplace, setShowReplace] = useState(false);
  const [replaceQuery, setReplaceQuery] = useState('');
  const [matchCase, setMatchCase] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [replaceScope, setReplaceScope] = useState<'file' | 'all'>('file');
  const [selectedResult, setSelectedResult] = useState<number | null>(null);
  const [confirmReplace, setConfirmReplace] = useState<{
    perFile: Array<{ file: string; count: number }>;
    hitCount: number;
  } | null>(null);
  const [replaceNotice, setReplaceNotice] = useState<string | null>(null);
  // ── completion ──────────────────────────────────────────────────────────
  const [completion, setCompletion] = useState<CompletionResult | null>(null);
  const [completionListOpen, setCompletionListOpen] = useState(false);
  /** The token the user dismissed with Esc (line + the token's start column).
   *  Keyed to the token rather than to the caret offset: moving inside the word
   *  keeps it dismissed, typing or deleting in it brings the ghost back. */
  const [completionDismissed, setCompletionDismissed] = useState<{
    line: number;
    column: number;
  } | null>(null);
  /** True while an IME candidate window owns the keyboard. */
  const composingRef = useRef(false);
  const [caret, setCaret] = useState(0);
  const [showFileSidebar, setShowFileSidebar] = useState(true);
  const [issueStripCollapsed, setIssueStripCollapsed] = useState(() => readIssueStripCollapsed());
  const [showReferenceViewer, setShowReferenceViewer] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
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

  // The gutter and the overlay are separate scrolled elements kept in step by
  // copying the textarea's scrollTop on 'scroll'. Any layout change that resizes
  // the editor — the findings strip folding/unfolding, the search panel or the
  // parse banner appearing, a window resize, browser zoom — makes the browser
  // CLAMP the textarea's scrollTop without emitting a scroll event, which leaves
  // the gutter showing different line numbers than the code beside it. Re-sync
  // whenever the textarea's box actually changes.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      // After layout, not during it.
      requestAnimationFrame(syncLineNumbersScroll);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [syncLineNumbersScroll]);

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
    const allErrors = validation[activeFile]?.errors ?? [];
    // Settings > Validation: hide findings of disabled severities (master
    // off hides everything). Gutter + issue list both derive from this memo.
    const errors = filterFindings(allErrors, visibility);
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
          acknowledgeSection: ack && ack.kind !== 'registry'
            ? activeSections.find((section) => section.full_header === err.section)
            : undefined,
          acknowledgeKind: ack ? ack.kind : undefined,
          acknowledgeCode: ack ? err.code : undefined,
          acknowledgeExtra: ack ? err.extra : undefined,
        });
      }
    }
    return issues;
  }, [validation, validationText, activeFile, editText, configFiles, visibility]);

  const handleAcknowledgeWarning = useCallback(async (
    section: ConfigSection | undefined,
    kind: 'unknown' | 'duplicate' | 'registry' = 'unknown',
    identity?: { file: string; code: string; section: string; param: string; extra?: string },
  ) => {
    if (kind === 'registry') {
      // Per-command ack via the bulk identity endpoint — same identity the
      // save gate's "Acknowledge all" sends, so both paths agree.
      if (!identity) return;
      await api.acknowledgeWarningsBulk([identity]);
      void revalidateFile(activeFile);
      return;
    }
    if (!section) return;
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

  // Worst severity per line → the overlay's row tints (error red, warning
  // yellow, info none).
  const issueLineSeverities = useMemo(() => lineSeverities(inlineIssues), [inlineIssues]);

  const toggleIssueStrip = useCallback(() => {
    setIssueStripCollapsed((prev) => {
      writeIssueStripCollapsed(!prev);
      return !prev;
    });
  }, []);

  const handleStripAcknowledge = useCallback((issue: TextIssue) => {
    void handleAcknowledgeWarning(
      issue.acknowledgeSection,
      issue.acknowledgeKind ?? 'unknown',
      issue.acknowledgeCode
        ? {
            file: activeFile,
            code: issue.acknowledgeCode,
            section: issue.section ?? '',
            param: issue.param ?? '',
            extra: issue.acknowledgeExtra ?? '',
          }
        : undefined,
    );
  }, [activeFile, handleAcknowledgeWarning]);

  // Gutter numbers as ONE text block (see the editor gutter comment): one
  // line per row, severity glyph + number, sharing the textarea's continuous
  // line rhythm so alignment holds at any zoom / device scaling. Inline
  // per-line spans keep the hover title without creating per-row layout boxes.
  const gutterHtml = useMemo(() => {
    const escapeAttr = (value: string) => escapeHtml(value).replace(/"/g, '&quot;');
    const lines = editText.split('\n');
    return lines
      .map((_line, idx) => {
        const lineNum = idx + 1;
        const lineIssues = issuesByLine.get(lineNum);
        if (!lineIssues?.length) return String(lineNum);
        const severity = worstSeverity(lineIssues.map((i) => i.severity)) ?? 'info';
        const spec = ISSUE_MARKER[severity];
        const title = escapeAttr(lineIssues.map((i) => i.text).join('\n'));
        return `<span title="${title}"><span style="color:${spec.color}">${spec.marker}</span> ${lineNum}</span>`;
      })
      .join('\n');
  }, [editText, issuesByLine]);

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

  // The textarea's text only becomes `activeFile`'s once the async export lands
  // (editTextFile tracks the owner). Until then `editText` still holds the
  // PREVIOUS file's content, so anything that means "the active file's text"
  // must fall back to the stored/exported text — that fallback is what stops the
  // tree and search from flashing the old file's sections during a switch.
  const textForFile = useCallback((fn: string): string => {
    if (fn === activeFile && editTextFile === activeFile) return editText;
    return configFiles[fn]?.raw_text ?? allFilesText[fn] ?? '';
  }, [activeFile, editTextFile, editText, configFiles, allFilesText]);

  // Text the search/replace acts on (the active file's live textarea text once
  // it belongs to that file, otherwise the stored text).
  const scopedTexts = useMemo((): Record<string, string> => {
    const files = replaceScope === 'all' ? Object.keys(configFiles) : [activeFile];
    const out: Record<string, string> = {};
    for (const fn of files) {
      if (!fn) continue;
      out[fn] = textForFile(fn);
    }
    return out;
  }, [replaceScope, configFiles, activeFile, textForFile]);

  const findOptions = useMemo(
    () => ({ caseSensitive: matchCase, wholeWord }),
    [matchCase, wholeWord],
  );

  // Current text for every file — the navigation tree's outline source.
  const outlineTexts = useMemo((): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const fn of Object.keys(configFiles)) {
      out[fn] = textForFile(fn);
    }
    return out;
  }, [configFiles, textForFile]);

  // Search results across the scope. Every occurrence on a line is its own row
  // (the previous implementation reported the first match per line only).
  const searchResults = useMemo((): SearchResult[] => {
    if (!searchQuery.trim()) return [];
    const results: SearchResult[] = [];
    for (const [fn, fileText] of Object.entries(scopedTexts)) {
      const lines = fileText.split('\n');
      for (const hit of findHits(fileText, searchQuery, findOptions)) {
        results.push({
          file: fn,
          line: hit.line,
          lineText: lines[hit.line - 1] ?? '',
          matchStart: hit.start,
          matchEnd: hit.end,
        });
        if (results.length >= 200) return results;
      }
    }
    return results;
  }, [searchQuery, scopedTexts, findOptions]);


  // Syntax markup + inline severity tints. Findings never restructure the text
  // (see editorHighlight): a tint is an inline span around the line's own
  // markup, so it is painted by the same line box as the characters.
  // The inline ghost draws what the candidate adds to the token. It is anchored
  // to the END OF THE TOKEN, not to the caret, so the suggestion shows while the
  // word is still being typed — `mi|c` offers `microsteps` exactly as `mic|`
  // does, the way Konsole offers `pwd` with the cursor between `p` and `w`.
  // Which token, and what it adds, is decided in the pure layer.
  const ghost = useMemo(() => {
    if (!completion || !completion.ghostText) return null;
    const { lineIndex, column } = caretLineColumn(editText, completion.context.tokenEnd);
    return { line: lineIndex + 1, column, text: completion.ghostText };
  }, [completion, editText]);

  const highlightedHtml = useMemo(
    () => buildHighlightedHtml(editText, { lineSeverities: issueLineSeverities, ghost }),
    [editText, issueLineSeverities, ghost],
  );

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
    // Editing the token revives a suggestion that Esc dismissed.
    setCompletionDismissed(null);
    setEditText(newText);
  };

  // ── completion sources ──────────────────────────────────────────────────
  const schemas = useConfigStore((s) => s.schemas);
  const gcodeCommands = useGcodeCommandStore((s) => s.commands);
  const loadGcodeCommands = useGcodeCommandStore((s) => s.load);
  useEffect(() => {
    void loadGcodeCommands();
  }, [loadGcodeCommands]);

  // Everything completion can offer, from the project as it is right now.
  const completionSources = useMemo((): CompletionSources => {
    const includePaths = new Set<string>();
    const macroNames = new Set<string>();
    const usedSectionTypes = new Set<string>();
    for (const [filename, file] of Object.entries(configFiles)) {
      includePaths.add(filename);
      for (const include of file.includes ?? []) includePaths.add(include);
      for (const section of file.sections ?? []) {
        if (section.section_type) usedSectionTypes.add(section.section_type);
        if (section.section_type === 'gcode_macro' && section.section_name) {
          macroNames.add(section.section_name);
        }
      }
    }
    return {
      schemas,
      includePaths: Array.from(includePaths).sort(),
      macroNames: Array.from(macroNames).sort(),
      gcodeCommands,
      usedSectionTypes: Array.from(usedSectionTypes),
    };
  }, [configFiles, schemas, gcodeCommands]);

  // Params the enclosing section already defines — listed, ranked last, never
  // ghosted. Resolved from the text at the caret each time rather than memoized:
  // completion now runs on the keystroke, so it must see the text as it is at
  // that instant (0.7ms on a 723-line file).
  const usedParamKeysAt = useCallback((text: string, at: number): string[] => {
    const { lineIndex } = caretLineColumn(text, at);
    const section = sectionAtLine(text, lineIndex);
    return section ? section.params.map((param) => param.key) : [];
  }, []);

  /**
   * Compute the suggestion for the caret as the DOM has it right now.
   *
   * There is deliberately no idle delay. The whole lookup costs ~0.5µs on a
   * 723-line file, and debouncing it made the ghost lag the typing: measured at
   * a 150ms cadence the ghost trailed ~2 keystrokes behind, and at a 60ms
   * cadence it never appeared at all until the typing stopped.
   */
  const updateCompletion = useCallback((el: HTMLTextAreaElement | null) => {
    if (!isActive || !el || composingRef.current || el.selectionStart !== el.selectionEnd) {
      setCompletion(null);
      return;
    }
    const at = el.selectionStart;
    const lineStart = el.value.lastIndexOf('\n', at - 1) + 1;
    const newline = el.value.indexOf('\n', at);
    const lineEnd = newline === -1 ? el.value.length : newline;
    if (lineEnd - lineStart > MAX_COMPLETION_LINE) {
      setCompletion(null);
      return;
    }
    const result = completionsAt(el.value, at, {
      ...completionSources,
      usedParamKeys: usedParamKeysAt(el.value, at),
    });
    if (!result) {
      setCompletion(null);
      return;
    }
    const dismissed = caretLineColumn(el.value, result.context.replaceStart);
    if (completionDismissed?.line === dismissed.lineIndex && completionDismissed?.column === dismissed.column) {
      setCompletion(null);
      return;
    }
    setCompletion(result);
  }, [isActive, completionSources, usedParamKeysAt, completionDismissed]);

  /** Caret bookkeeping shared by the textarea's key/click/select handlers. */
  const syncCaret = useCallback((el: HTMLTextAreaElement) => {
    setCaret(el.selectionStart);
    updateCompletion(el);
  }, [updateCompletion]);

  // ── Editor selection → chat reference ───────────────────────────
  // Highlighting lines IS the act of pointing at them, so the dock's
  // selection slot is fed straight from the textarea rather than asking the
  // user to attach what they already selected. The store no-ops on an
  // unchanged value, so publishing on every click/keyup is cheap.
  const publishSelectionReference = useCallback((el: HTMLTextAreaElement) => {
    const { selectionStart, selectionEnd } = el;
    if (selectionStart === selectionEnd) {
      useChatReferenceStore.getState().setSelection(null);
      return;
    }
    const value = el.value;
    const startLine = value.slice(0, selectionStart).split('\n').length;
    // A selection ending exactly on a newline stops at the end of the
    // PREVIOUS line — counting the character after it would over-claim a
    // line the user never highlighted.
    const endsOnBoundary = value[selectionEnd - 1] === '\n';
    const endLine = value.slice(0, selectionEnd).split('\n').length - (endsOnBoundary ? 1 : 0);
    useChatReferenceStore.getState().setSelection(
      selectionToReference(value, editTextFile, startLine, endLine),
    );
  }, [editTextFile]);

  // Any change to the text — typing, an accepted suggestion, undo/redo, or the
  // model's own export landing after the debounced parse — invalidates what was
  // computed for the previous text. A programmatic replacement moves the caret
  // without firing a key or select event, so without this the ghost could stay
  // on screen for a line that no longer exists.
  useEffect(() => {
    updateCompletion(textareaRef.current);
  }, [editText, updateCompletion]);

  // Caret/selection to restore after a programmatic text rewrite (indent,
  // completion). React state is applied on the next render, so the selection
  // has to be re-applied in an effect — setting it inline would be undone by
  // the re-render overwriting `value`.
  const pendingSelectionRef = useRef<[number, number] | null>(null);

  const applyTextEdit = useCallback((edit: { text: string; start: number; end: number }) => {
    exportingRef.current = false; // a real user edit, not a model export echo
    pendingSelectionRef.current = [edit.start, edit.end];
    // Keep the completion's caret in step with the programmatic edit: a
    // setSelectionRange fires no `select` event, so without this the next
    // suggestion is computed for the old caret position (which is why nothing
    // followed an accepted name until you typed or clicked again).
    setCaret(edit.start);
    setEditText(edit.text);
  }, []);

  useEffect(() => {
    const pending = pendingSelectionRef.current;
    const el = textareaRef.current;
    if (!pending || !el) return;
    pendingSelectionRef.current = null;
    el.setSelectionRange(pending[0], pending[1]);
    syncLineNumbersScroll();
    // The caret moved by the accepted suggestion: show what is next (accepting a
    // param leaves the caret after `key: `, where the value default belongs).
    updateCompletion(el);
  }, [editText, syncLineNumbersScroll, updateCompletion]);


  // Clear suggestions when the file changes under us.
  useEffect(() => {
    setCompletion(null);
    setCompletionListOpen(false);
    setCompletionDismissed(null);
  }, [activeFile]);

  const acceptCompletion = useCallback((index?: number) => {
    if (!completion) return;
    const candidate = completion.candidates[index ?? completion.index];
    if (!candidate) return;
    const applied = applyCandidate(editText, completion.context, candidate);
    applyTextEdit({ text: applied.text, start: applied.caret, end: applied.caret });
    setCompletion(null);
    setCompletionListOpen(false);
    setCompletionDismissed(null);
  }, [completion, editText, applyTextEdit]);

  const dismissCompletion = useCallback(() => {
    if (completion) {
      const { lineIndex, column } = caretLineColumn(editText, completion.context.replaceStart);
      setCompletionDismissed({ line: lineIndex, column });
    }
    setCompletion(null);
    setCompletionListOpen(false);
  }, [completion, editText]);

  // Popup anchor, measured only while the list is open.
  const completionAnchor = useMemo(() => {
    if (!completionListOpen || !completion) return null;
    const el = textareaRef.current;
    // The DOM caret, not the `caret` state: that lags a render behind while typing.
    return el ? measureCaretRect(el, el.selectionStart) : null;
  }, [completionListOpen, completion, caret, editText]);

  // Tab / Shift+Tab indentation. The textarea had no key handler at all, so Tab
  // moved focus out of the editor and there was no way to indent a block.
  const handleEditorKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Accepting is the RIGHT ARROW or End (Tab keeps its single meaning: indent),
    // and only when the caret sits at the end of the token with nothing after it
    // on the line, so the arrow never swallows a normal cursor move.
    //
    // Computed at the key press rather than read from state: accepting a param
    // leaves the caret after `key: `, and the next press has to see the value
    // suggestion with no keystroke, re-render or delay in between.
    if (
      (e.key === 'ArrowRight' || e.key === 'End') &&
      !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey
    ) {
      const el = e.currentTarget;
      const applied = acceptAt(el.value, el.selectionStart, {
        ...completionSources,
        usedParamKeys: usedParamKeysAt(el.value, el.selectionStart),
      });
      if (applied) {
        e.preventDefault();
        applyTextEdit({ text: applied.text, start: applied.caret, end: applied.caret });
        setCompletion(null);
        setCompletionListOpen(false);
        setCompletionDismissed(null);
        setCaret(applied.caret);
        return;
      }
    }
    if (completion) {
      if (e.key === 'Enter' && completionListOpen) {
        e.preventDefault();
        acceptCompletion();
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        dismissCompletion();
        return;
      }
      if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && completionListOpen) {
        e.preventDefault();
        setCompletion((current) => {
          if (!current) return current;
          const delta = e.key === 'ArrowDown' ? 1 : -1;
          const count = current.candidates.length;
          return { ...current, index: (current.index + delta + count) % count };
        });
        return;
      }
    }
    if (e.ctrlKey && e.key === ' ') {
      // Explicit request: compute now (past the idle delay and any Esc) and
      // show the whole list rather than just the top ghost.
      e.preventDefault();
      const result = completionsAt(editText, caret, {
        ...completionSources,
        usedParamKeys: usedParamKeysAt(editText, caret),
      });
      if (result) {
        setCompletion(result);
        setCompletionListOpen(true);
        setCompletionDismissed(null);
      }
      return;
    }
    if (e.key !== 'Tab' || e.ctrlKey || e.metaKey || e.altKey) return;
    setCompletionListOpen(false);
    const el = e.currentTarget;
    const { selectionStart, selectionEnd } = el;
    const value = el.value;
    // Keep focus in the editor: preventDefault must happen before the edit.
    e.preventDefault();
    if (e.shiftKey) {
      applyTextEdit(outdentSelection(value, selectionStart, selectionEnd));
      return;
    }
    applyTextEdit(
      selectionStart === selectionEnd
        ? indentCaret(value, selectionStart)
        : indentSelection(value, selectionStart, selectionEnd),
    );
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

  // --- Drag auto-scroll -----------------------------------------------------
  // Chromium/Firefox move a selected block of text natively, but nothing
  // scrolls the editor when the pointer leaves the visible area, so a block
  // could only be dropped on a line that was already on screen. While a drag
  // is in flight a rAF loop nudges scrollTop from the pointer's Y position.
  const dragScrollRef = useRef<{ clientY: number; raf: number | null }>({ clientY: 0, raf: null });

  const stopDragAutoScroll = useCallback(() => {
    const { raf, clientY } = dragScrollRef.current;
    if (raf != null) cancelAnimationFrame(raf);
    dragScrollRef.current = { clientY, raf: null };
  }, []);

  const dragAutoScrollLoop = useCallback(function loop() {
    const el = textareaRef.current;
    if (!el || dragScrollRef.current.raf == null) return;
    const rect = el.getBoundingClientRect();
    const delta = autoScrollDelta(dragScrollRef.current.clientY, rect.top, rect.bottom);
    if (delta !== 0) {
      const before = el.scrollTop;
      el.scrollTop = Math.max(0, before + delta);
      // Keep the gutter + highlight overlay locked to the new scroll position.
      if (el.scrollTop !== before) syncLineNumbersScroll();
    }
    dragScrollRef.current.raf = requestAnimationFrame(loop);
  }, [syncLineNumbersScroll]);

  const startDragAutoScroll = useCallback((e: React.DragEvent<HTMLTextAreaElement>) => {
    if (dragScrollRef.current.raf != null) return; // already running
    dragScrollRef.current = { clientY: e.clientY, raf: requestAnimationFrame(dragAutoScrollLoop) };
  }, [dragAutoScrollLoop]);

  // The pointer position is tracked from document-level drag events: during a
  // native drag the pointer is captured by the drag operation and the
  // interesting Y often sits outside the textarea (over the gutter, or past the
  // window edge entirely). Deliberately no preventDefault on dragover — the
  // textarea must stay a valid drop target for its own selection.
  useEffect(() => {
    const track = (e: DragEvent) => {
      if (dragScrollRef.current.raf == null) return;
      dragScrollRef.current.clientY = e.clientY;
    };
    const stop = () => stopDragAutoScroll();
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') stopDragAutoScroll();
    };
    document.addEventListener('dragover', track, true);
    document.addEventListener('dragend', stop, true);
    document.addEventListener('drop', stop, true);
    window.addEventListener('blur', stop);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('dragover', track, true);
      document.removeEventListener('dragend', stop, true);
      document.removeEventListener('drop', stop, true);
      window.removeEventListener('blur', stop);
      window.removeEventListener('keydown', onKeyDown);
      stopDragAutoScroll();
    };
  }, [stopDragAutoScroll]);

  // Consume one-shot line-jump requests (save dialog findings list → the
  // editor). The target file may need switching first; the switch re-exports
  // the file's text asynchronously, so re-attempt until the target file's
  // text is actually in the textarea (editTextFile tracks the text's owner —
  // a stale jump must never land on another file's layout).
  useEffect(() => {
    if (!pendingLineJump || !isActive) return;
    if (pendingLineJump.file !== activeFile) {
      setActiveFile(pendingLineJump.file);
      setEditTextFile(''); // export is async — text is stale until it lands
      return; // re-runs after the switch
    }
    if (editTextFile !== activeFile || !editText) {
      return; // target file's text still in flight — re-runs when it lands
    }
    const line = pendingLineJump.line;
    useConfigStore.getState().consumeLineJump();
    setTimeout(() => jumpToLine(line), 0);
  }, [pendingLineJump, activeFile, editText, editTextFile, isActive, jumpToLine, setActiveFile]);

  const handleSearchResultClick = (file: string, line: number) => {
    if (file !== activeFile) {
      setActiveFile(file);
    }
    // Select the matching line after state settles
    setTimeout(() => {
      jumpToLine(line);
    }, 0);
  };

  // Write replaced text back through the same paths a normal edit takes: the
  // active file rides the debounced parse → store → graph pipeline, other files
  // are parsed up front and applied directly (never written blind).
  const applyReplacedText = async (file: string, nextText: string): Promise<boolean> => {
    if (file === activeFile) {
      handleTextChange(nextText);
      return true;
    }
    try {
      const result = await api.parseConfigText(nextText, file);
      updateConfigFile(file, { ...result.config, raw_text: nextText });
      setTextParseError(file, null);
      return true;
    } catch {
      return false;
    }
  };

  const handleReplaceCurrent = () => {
    if (!searchQuery) return;
    const target = searchResults[selectedResult ?? 0];
    if (!target) return;
    const source = scopedTexts[target.file] ?? '';
    const result = replaceOne(source, searchQuery, replaceQuery, findOptions, {
      line: target.line,
      start: target.matchStart,
      end: target.matchEnd,
    });
    if (result.count === 0) {
      setReplaceNotice('That match moved — search again.');
      return;
    }
    void applyReplacedText(target.file, result.text).then((ok) => {
      setReplaceNotice(
        ok
          ? `Replaced 1 match in ${target.file}.`
          : `Could not parse ${target.file} — nothing was changed.`,
      );
    });
  };

  const handleReplaceAllRequest = () => {
    if (!searchQuery) return;
    const perFile = Object.entries(scopedTexts)
      .map(([file, text]) => ({ file, count: countHits(text, searchQuery, findOptions) }))
      .filter((entry) => entry.count > 0);
    const hitCount = perFile.reduce((sum, entry) => sum + entry.count, 0);
    if (hitCount === 0) {
      setReplaceNotice('No matches to replace.');
      return;
    }
    setConfirmReplace({ perFile, hitCount });
  };

  const applyReplaceAll = async () => {
    const plan = confirmReplace;
    setConfirmReplace(null);
    if (!plan || !searchQuery) return;

    // One undo entry for the batch: Replace All is a single user action.
    useGraphStore.getState().pushHistory();
    let replaced = 0;
    const failed: string[] = [];
    for (const entry of plan.perFile) {
      const source = scopedTexts[entry.file] ?? '';
      const result = replaceAll(source, searchQuery, replaceQuery, findOptions);
      replaced += result.count;
      const ok = await applyReplacedText(entry.file, result.text);
      if (!ok) failed.push(entry.file);
    }
    // Project-level revalidation so cross-file findings survive the rewrite.
    void revalidateAll();
    setSelectedResult(null);
    setReplaceNotice(
      `Replaced ${replaced} match${replaced === 1 ? '' : 'es'} in ${plan.perFile.length} file${
        plan.perFile.length === 1 ? '' : 's'
      }.${failed.length ? ` Could not parse: ${failed.join(', ')}.` : ''}`,
    );
  };

  const toggleSearch = () => {
    setShowSearch((prev) => {
      if (prev) setSearchQuery('');
      return !prev;
    });
  };

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
      {/* One navigation tree: folder (when present) -> file -> section -> param.
          Replaces the old files sidebar + right-hand sections sidebar. */}
      <ConfigTree
        filenames={filenames}
        texts={outlineTexts}
        activeFile={activeFile}
        validation={validation}
        visibility={visibility}
        collapsed={!showFileSidebar}
        onToggleCollapsed={() => setShowFileSidebar((prev) => !prev)}
        onSelectFile={handleFileSwitch}
        onFileContextMenu={handleFileContextMenu}
        onJumpToLine={jumpToLine}
        onAddConfig={() => { setShowAddConfig(true); setAddConfigStep('choose'); setFileError(''); }}
        onReferenceNode={(reference) => useChatReferenceStore.getState().setPreview(reference)}
        previewReferenceId={previewReferenceId}
      />

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

        {/* Search / replace panel */}
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
                onChange={(e) => { setSearchQuery(e.target.value); setSelectedResult(null); setReplaceNotice(null); }}
                onKeyDown={(e) => { if (e.key === 'Escape') toggleSearch(); }}
                className="flex-1 bg-[var(--color-bg-primary)] text-[var(--color-text-primary)] text-xs font-mono px-2 py-1 rounded border border-[var(--color-bg-tertiary)] focus:outline-none focus:border-[var(--color-accent)]"
              />
              {searchQuery.trim() && (
                <span className="text-[10px] text-[var(--color-text-secondary)] shrink-0">
                  {searchResults.length}{searchResults.length === 200 ? '+' : ''} match{searchResults.length !== 1 ? 'es' : ''}
                </span>
              )}
              <button
                onClick={() => setShowReplace((prev) => !prev)}
                title="Show find and replace"
                className={`shrink-0 px-2 py-1 rounded text-[10px] font-medium transition-colors ${
                  showReplace
                    ? 'bg-[var(--color-accent)] text-[var(--color-bg-primary)]'
                    : 'bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'
                }`}
              >
                Replace
              </button>
            </div>

            {showReplace && (
              <div className="flex flex-wrap items-center gap-2 px-3 pb-2">
                <input
                  type="text"
                  placeholder="Replace with…"
                  value={replaceQuery}
                  onChange={(e) => setReplaceQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') setShowReplace(false);
                    if (e.key === 'Enter') handleReplaceAllRequest();
                  }}
                  className="flex-1 min-w-[10rem] bg-[var(--color-bg-primary)] text-[var(--color-text-primary)] text-xs font-mono px-2 py-1 rounded border border-[var(--color-bg-tertiary)] focus:outline-none focus:border-[var(--color-accent)]"
                />
                <button
                  onClick={handleReplaceCurrent}
                  disabled={!searchQuery || searchResults.length === 0}
                  className="shrink-0 px-2 py-1 rounded text-[10px] font-medium bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Replace
                </button>
                <button
                  onClick={handleReplaceAllRequest}
                  disabled={!searchQuery}
                  className="shrink-0 px-2 py-1 rounded text-[10px] font-medium bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Replace All
                </button>
                <label className="flex shrink-0 items-center gap-1 text-[10px] text-[var(--color-text-secondary)] cursor-pointer">
                  <input type="checkbox" checked={matchCase} onChange={(e) => setMatchCase(e.target.checked)} />
                  Match case
                </label>
                <label className="flex shrink-0 items-center gap-1 text-[10px] text-[var(--color-text-secondary)] cursor-pointer">
                  <input type="checkbox" checked={wholeWord} onChange={(e) => setWholeWord(e.target.checked)} />
                  Whole word
                </label>
                <select
                  value={replaceScope}
                  onChange={(e) => setReplaceScope(e.target.value as 'file' | 'all')}
                  title="Which files the search and replace act on"
                  className="shrink-0 bg-[var(--color-bg-primary)] text-[var(--color-text-primary)] text-[10px] px-1 py-1 rounded border border-[var(--color-bg-tertiary)] focus:outline-none"
                >
                  <option value="file">This file</option>
                  <option value="all">All files</option>
                </select>
              </div>
            )}

            {replaceNotice && (
              <p className="px-3 pb-2 text-[10px] text-[var(--color-text-secondary)]">{replaceNotice}</p>
            )}

            {searchResults.length > 0 && (
              <div className="max-h-52 overflow-y-auto border-t border-[var(--color-bg-tertiary)]">
                {searchResults.map((r, i) => (
                  <button
                    key={i}
                    onClick={() => {
                      setSelectedResult(i);
                      handleSearchResultClick(r.file, r.line);
                    }}
                    className={`w-full text-left px-3 py-1.5 text-xs flex items-baseline gap-2 transition-colors ${
                      selectedResult === i ? 'bg-[var(--color-bg-tertiary)]' : 'hover:bg-[var(--color-bg-tertiary)]'
                    }`}
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

        {/* Replace All confirmation — a project-wide rewrite is destructive. */}
        {confirmReplace && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setConfirmReplace(null)}>
            <div
              className="bg-[var(--color-bg-secondary)] rounded-xl border border-[var(--color-bg-tertiary)] shadow-2xl p-5 w-96"
              onClick={(e) => e.stopPropagation()}
            >
              <h3 className="text-sm font-semibold text-[var(--color-text-primary)] mb-2">Replace All</h3>
              <p className="text-xs text-[var(--color-text-secondary)] mb-3">
                Replace <span className="font-mono text-[var(--color-text-primary)]">{confirmReplace.hitCount}</span>{' '}
                match{confirmReplace.hitCount === 1 ? '' : 'es'} of{' '}
                <span className="font-mono text-[var(--color-text-primary)]">{searchQuery}</span> with{' '}
                <span className="font-mono text-[var(--color-text-primary)]">{replaceQuery || '(nothing)'}</span>
                {wholeWord ? ' (whole word)' : ''}{matchCase ? ' (match case)' : ''}?
              </p>
              <ul className="mb-4 max-h-40 overflow-y-auto text-xs text-[var(--color-text-secondary)]">
                {confirmReplace.perFile.map((entry) => (
                  <li key={entry.file} className="flex justify-between gap-3 py-0.5">
                    <span className="font-mono truncate">{entry.file}</span>
                    <span className="shrink-0">{entry.count}</span>
                  </li>
                ))}
              </ul>
              <div className="flex justify-end gap-2">
                <button
                  onClick={() => setConfirmReplace(null)}
                  className="px-3 py-1.5 rounded text-xs bg-[var(--color-bg-tertiary)] text-[var(--color-text-primary)]"
                >
                  Cancel
                </button>
                <button
                  onClick={() => void applyReplaceAll()}
                  className="px-3 py-1.5 rounded text-xs bg-[var(--color-accent)] text-[var(--color-bg-primary)]"
                >
                  Replace All
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Editor with line numbers and inline issues */}
        <div className="flex-1 flex overflow-hidden">
          <div className="flex flex-col flex-1 min-w-0 relative">
            <div className="flex-1 flex overflow-hidden" ref={editorScrollRef}>
              {/* Line numbers + issue indicators.
                  Rendered as ONE text block (like the textarea's own lines)
                  instead of per-row divs: 700+ flex rows round their offsets
                  independently of the textarea's line boxes, so the numbers
                  drift ±~1px vs the text and the offset flips with browser
                  zoom / device scaling. A single block shares the textarea's
                  exact line rhythm (same font-size/line-height/font/padding),
                  so every number snaps to its text line at any zoom. */}
              <div
                ref={lineNumbersRef}
                className="shrink-0 overflow-hidden bg-[var(--color-bg-secondary)] select-none pl-2 pr-2 pt-4 pb-4 border-r border-[var(--color-bg-tertiary)]"
                style={{ minWidth: '3rem' }}
              >
                <pre
                  aria-hidden
                  className="m-0 font-mono text-sm leading-relaxed text-right text-[var(--color-text-secondary)]"
                  style={{ tabSize: 4 }}
                  dangerouslySetInnerHTML={{ __html: gutterHtml }}
                />
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
                {/* Candidate list, anchored at the caret. Fixed positioning so
                    the editor's overflow can't clip it; rows take their own
                    index so a click accepts what it points at. */}
                {completionListOpen && completion && completionAnchor && (
                  <div
                    className="fixed z-40 max-h-64 w-80 overflow-y-auto rounded-lg border border-[var(--color-bg-tertiary)] bg-[var(--color-bg-secondary)] shadow-2xl"
                    style={{
                      left: Math.max(8, completionAnchor.x),
                      top: Math.min(
                        completionAnchor.y + completionAnchor.height,
                        Math.max(8, window.innerHeight - 280),
                      ),
                    }}
                  >
                    <div className="border-b border-[var(--color-bg-tertiary)] px-2 py-1 text-[10px] uppercase tracking-wider text-[var(--color-text-secondary)]">
                      {completion.context.kind.replace('-', ' ')}
                      {completion.context.prefix ? ` · ${completion.context.prefix}` : ''}
                      <span className="float-right normal-case tracking-normal opacity-70">
                        → / End or Enter · Esc
                      </span>
                    </div>
                    {completion.candidates.map((candidate, index) => (
                      <button
                        key={`${candidate.kind}-${candidate.label}`}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => acceptCompletion(index)}
                        className={`flex w-full items-baseline gap-2 px-2 py-1 text-left text-xs transition-colors ${
                          index === completion.index
                            ? 'bg-[var(--color-bg-tertiary)] text-[var(--color-text-primary)]'
                            : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)]'
                        }`}
                      >
                        <span className="shrink-0 font-mono">{candidate.label}</span>
                        {candidate.detail && (
                          <span className="min-w-0 flex-1 truncate text-[10px] text-[var(--color-text-secondary)]">
                            {candidate.detail}
                          </span>
                        )}
                      </button>
                    ))}
                  </div>
                )}

                <textarea
                  ref={textareaRef}
                  aria-label="Configuration text editor with syntax highlighting overlay"
                  value={editText}
                  onChange={(e) => handleTextChange(e.target.value)}
                  onKeyDown={handleEditorKeyDown}
                  onKeyUp={(e) => { syncCaret(e.currentTarget); publishSelectionReference(e.currentTarget); }}
                  onClick={(e) => { syncCaret(e.currentTarget); publishSelectionReference(e.currentTarget); }}
                  onSelect={(e) => { syncCaret(e.currentTarget); publishSelectionReference(e.currentTarget); }}
                  onCompositionStart={() => { composingRef.current = true; }}
                  onCompositionEnd={(e) => { composingRef.current = false; syncCaret(e.currentTarget); }}
                  onBlur={() => { setCompletion(null); setCompletionListOpen(false); }}
                  onDragStart={startDragAutoScroll}
                  onScroll={syncLineNumbersScroll}
                  spellCheck={false}
                  wrap="off"
                  // Text is intentionally transparent; syntax-highlighted text is rendered in the overlay <pre>.
                  className="absolute inset-0 w-full resize-none overflow-auto bg-transparent p-4 font-mono text-sm leading-relaxed text-transparent caret-[var(--color-text-primary)] focus:outline-none"
                  style={{ tabSize: 4 }}
                />
              </div>
            </div>
            {/* Findings strip. Collapsed to a severity summary by default —
                hover a dot for its status messages; expanding lists every
                finding with its Acknowledge action. */}
            <EditorIssueStrip
              issues={inlineIssues}
              collapsed={issueStripCollapsed}
              onToggleCollapsed={toggleIssueStrip}
              onJump={jumpToLine}
              onAcknowledge={handleStripAcknowledge}
            />
          </div>
        </div>

        {/* Apply warning dialog */}
        {/* Removed — text edits apply to the model directly; validation rides
            along and colors the Save button instead of gating anything. */}

        {showReferenceViewer && (
          <ConfigReferenceDialog onClose={() => setShowReferenceViewer(false)} />
        )}
      </div>

      {/* Docked AI chat — the third column in this row. `Toolbar` owns the
          single ChatDialog instance and portals its content into the host
          element published here, so folding the panel never disturbs an
          in-flight request. */}
      {dockAvailable && (
        <ChatDock
          collapsed={!showChatDock}
          configured={aiConfigured}
          onToggle={() => setShowChatDock(!showChatDock)}
          onRegisterHost={registerDockHost}
        />
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
