import { useState, useCallback, useMemo, useRef, useEffect, useImperativeHandle, forwardRef } from 'react';
import { useConfigStore } from '../stores/configStore';
import { useGraphStore } from '../stores/graphStore';
import * as api from '../services/api';
import ApplyWarningDialog from './dialogs/ApplyWarningDialog';
import type { ExampleConfig, HardwareType, CommunicationType } from '../types/config';
import { getBoardTypeMarker } from '../utils/boardTypeMarker';

interface SearchResult {
  file: string;
  line: number;
  lineText: string;
  matchStart: number;
  matchEnd: number;
}

export interface TextEditorHandle {
  isDirty: () => boolean;
  applyChanges: () => Promise<void>;
}

interface TextIssue {
  line: number;
  text: string;
  severity: 'error' | 'warning';
}

interface ConfigSectionEntry {
  title: string;
  line: number;
}

const TextEditor = forwardRef<TextEditorHandle>(function TextEditor(_props, ref) {
  const { configFiles, activeFile, setActiveFile, setConfigFile, setValidation, renameConfigFile, copyConfigFile, removeConfigFile } = useConfigStore();

  const config = configFiles[activeFile];
  const filenames = Object.keys(configFiles);

  const [editText, setEditText] = useState('');
  const [isDirty, setIsDirty] = useState(false);

  // Helper: export config text via backend (preserves comments, whitespace, #*# markers)
  const exportTextRef = useRef<number>(0);
  const exportConfigText = useCallback(async (cf: typeof config): Promise<string> => {
    if (!cf) return '';
    try {
      return await api.exportConfig(cf);
    } catch {
      return configToText(cf);
    }
  }, []);

  // When config changes and text is not dirty, re-export via backend
  useEffect(() => {
    if (!config || isDirty) return;
    const requestId = ++exportTextRef.current;
    exportConfigText(config).then((text) => {
      if (requestId === exportTextRef.current) {
        setEditText(text);
      }
    });
  }, [config, isDirty, exportConfigText]);
  const [showSearch, setShowSearch] = useState(false);
  const [showFileSidebar, setShowFileSidebar] = useState(true);
  const [showSectionsSidebar, setShowSectionsSidebar] = useState(true);
  const [showReferenceViewer, setShowReferenceViewer] = useState(false);
  const [configReferenceText, setConfigReferenceText] = useState('');
  const [configReferenceError, setConfigReferenceError] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [showApplyWarning, setShowApplyWarning] = useState(false);
  const [liveValidation, setLiveValidation] = useState<Array<{ severity: string; section: string; param: string; message: string }>>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const lineNumbersRef = useRef<HTMLDivElement>(null);
  const highlightRef = useRef<HTMLPreElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const editorScrollRef = useRef<HTMLDivElement>(null);
  const liveValidateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // File management state
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; file: string } | null>(null);
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

  // Debounced live validation: parse the current text and validate it as the user types
  useEffect(() => {
    if (liveValidateTimerRef.current) clearTimeout(liveValidateTimerRef.current);
    liveValidateTimerRef.current = setTimeout(async () => {
      try {
        const result = await api.parseConfigText(editText, activeFile);
        setLiveValidation(result.validation.errors || []);
      } catch {
        // Parse failed — don't update validation
      }
    }, 800);
    return () => {
      if (liveValidateTimerRef.current) clearTimeout(liveValidateTimerRef.current);
    };
  }, [editText, activeFile]);

  // Collect inline issues from live validation of the current text
  const inlineIssues = useMemo((): TextIssue[] => {
    const errors = liveValidation;
    if (!errors || errors.length === 0) return [];
    const issues: TextIssue[] = [];
    for (const err of errors) {
      if (err.severity === 'error' || err.severity === 'warning') {
        // Find the line in the text that corresponds to this error
        const lines = editText.split('\n');
        let lineNum = 0;
        if (err.section) {
          // Find the section header line (may be commented out with #)
          const sectionIdx = lines.findIndex((l) => {
            const trimmed = l.trim();
            return trimmed === `[${err.section}]` || trimmed === `#[${err.section}]`;
          });
          if (sectionIdx !== -1) {
            if (err.param) {
              // Find the param within the section
              for (let i = sectionIdx + 1; i < lines.length; i++) {
                if (lines[i].trim().startsWith('[') && lines[i].trim().endsWith(']')) break;
                const trimmed = lines[i].replace(/^#/, '').trim();
                if (trimmed.startsWith(err.param + ':') || trimmed.startsWith(err.param + ' ') || trimmed.startsWith(err.param + '=')) {
                  lineNum = i + 1;
                  break;
                }
              }
            }
            if (!lineNum) lineNum = sectionIdx + 1;
          }
        }
        issues.push({
          line: lineNum,
          text: err.message,
          severity: err.severity as 'error' | 'warning',
        });
      }
    }
    return issues;
  }, [liveValidation, editText]);

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
        try {
          result[fn] = await api.exportConfig(cf);
        } catch {
          result[fn] = configToText(cf);
        }
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
    lines.forEach((line, idx) => {
      const match = line.match(/^\s*#?\[([^\]]+)\]\s*$/);
      if (match) {
        sections.push({ title: match[1], line: idx + 1 });
      }
    });
    return sections;
  }, [editText]);

  const highlightedHtml = useMemo(() => buildHighlightedHtml(editText), [editText]);

  // Focus search input when panel opens
  useEffect(() => {
    if (showSearch && searchInputRef.current) {
      searchInputRef.current.focus();
    }
  }, [showSearch]);

  useEffect(() => {
    if (!showReferenceViewer || configReferenceText) return;
    api.getConfigReference()
      .then((res) => {
        const text = res.content;
        setConfigReferenceText(text);
        setConfigReferenceError('');
      })
      .catch(async () => {
        try {
          const res = await fetch('/reference/docs/Config_Reference.md');
          if (!res.ok) throw new Error('missing');
          const text = await res.text();
          setConfigReferenceText(text);
          setConfigReferenceError('');
        } catch {
          setConfigReferenceError('Config reference could not be loaded.');
        }
      });
  }, [configReferenceText, showReferenceViewer]);

  // Sync when switching files
  const handleFileSwitch = useCallback(async (filename: string) => {
    setActiveFile(filename);
    const cf = configFiles[filename];
    if (cf) {
      const text = await exportConfigText(cf);
      setEditText(text);
      setIsDirty(false);
    }
  }, [configFiles, setActiveFile, exportConfigText]);

  const handleTextChange = (newText: string) => {
    setEditText(newText);
    setIsDirty(true);
  };

  const doApply = useCallback(async () => {
    try {
      const result = await api.parseConfigText(editText, activeFile);
      setConfigFile(activeFile, result.config);
      setValidation(activeFile, result.validation);
      setIsDirty(false);
      // Sync the graph with the updated config
      useGraphStore.getState().syncGraphWithConfig(activeFile);
    } catch (err) {
      console.error('Parse error:', err);
    }
  }, [editText, activeFile, setConfigFile, setValidation]);

  const handleApply = useCallback(async () => {
    // Check for active issues
    if (inlineIssues.length > 0) {
      setShowApplyWarning(true);
      return;
    }
    await doApply();
  }, [inlineIssues, doApply]);

  const handleApplyAnyway = useCallback(async () => {
    setShowApplyWarning(false);
    await doApply();
  }, [doApply]);

  // Expose isDirty and applyChanges to parent
  useImperativeHandle(ref, () => ({
    isDirty: () => isDirty,
    applyChanges: doApply,
  }), [isDirty, doApply]);

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
    // Approximate scroll to bring line into view
    const approxLineHeight = 21;
    textareaRef.current.scrollTop = Math.max(0, (line - 5) * approxLineHeight);
    syncLineNumbersScroll();
  }, [syncLineNumbersScroll]);

  const handleSearchResultClick = async (file: string, line: number) => {
    const cf = configFiles[file];
    if (!cf) return;
    if (file !== activeFile) {
      const fileText = await exportConfigText(cf);
      setActiveFile(file);
      setEditText(fileText);
      setIsDirty(false);
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
    if (activeFile === renameDialog.file) {
      const cf = useConfigStore.getState().configFiles[newName];
      if (cf) setEditText(await exportConfigText(cf));
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
    const cf = useConfigStore.getState().configFiles[copyName];
    if (cf) setEditText(await exportConfigText(cf));
    setIsDirty(false);
    setContextMenu(null);
  };

  const handleDeleteFile = async () => {
    if (!contextMenu) return;
    if (contextMenu.file === 'printer.cfg') return; // Cannot delete printer.cfg
    const fileToDelete = contextMenu.file;
    setContextMenu(null);
    // Remove graph nodes associated with this file
    const graphState = useGraphStore.getState();
    const nodesToRemove = graphState.nodes.filter(
      (n) => (n.data as Record<string, unknown>).configFile === fileToDelete,
    );
    for (const n of nodesToRemove) {
      graphState.removeNode(n.id);
    }
    removeConfigFile(fileToDelete);
    // Switch to another file
    const remaining = Object.keys(useConfigStore.getState().configFiles);
    if (remaining.length > 0) {
      const next = remaining[0];
      setActiveFile(next);
      const cf = useConfigStore.getState().configFiles[next];
      if (cf) setEditText(await exportConfigText(cf));
      setIsDirty(false);
    }
  };

  // Add Configuration handlers
  const handleAddConfigBlank = () => {
    const name = ensureCfgExtension(newFileName);
    if (!name) return;
    if (isDuplicateFileName(name)) {
      setFileError(`"${name}" already exists. Choose a different name.`);
      return;
    }
    setConfigFile(name, {
      filename: name,
      sections: [],
      includes: [],
      header_comments: [],
    });
    setActiveFile(name);
    setEditText('');
    setIsDirty(false);
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

  // Feature section types (same as graphBuilder/graphStore)
  const FEAT_TYPES = new Set([
    'bed_mesh', 'z_tilt', 'quad_gantry_level', 'screws_tilt_adjust',
    'bed_screws', 'bed_tilt', 'skew_correction', 'axis_twist_compensation',
    'safe_z_home', 'homing_override', 'endstop_phase',
    'input_shaper', 'resonance_tester',
    'virtual_sdcard', 'pause_resume', 'firmware_retraction', 'force_move',
    'idle_timeout', 'gcode_macro', 'delayed_gcode', 'gcode_arcs',
    'respond', 'exclude_object', 'save_variables', 'display_status',
  ]);

  /**
   * Create graph nodes (hardware + children + edges) for a newly-added config file.
   * Detects MCU sections to classify the hardware type and creates communication
   * edges back to the SBC node.
   */
  const buildGraphForNewFile = (filename: string, sections: Array<{ section_type: string; section_name: string; full_header: string; header_comments?: string[]; params: Array<{ key: string; value: string; is_commented_out: boolean }> }>) => {
    const graphStore = useGraphStore.getState();
    const schemas = useConfigStore.getState().schemas;

    // Detect MCU sections
    const mcuSections = sections.filter((s) => s.section_type === 'mcu');
    const hasMcu = mcuSections.length > 0;

    // If no MCU section, this file doesn't define a hardware node
    if (!hasMcu) return;

    // Classify hardware type from MCU name
    const primaryMcu = mcuSections[0];
    const mcuName = primaryMcu.section_name || '';
    let hwType: HardwareType = getBoardTypeMarker(primaryMcu.header_comments) || 'mainboard';
    if (hwType === 'mainboard' && mcuName) {
      const lower = mcuName.toLowerCase();
      if (lower.includes('host') || lower.includes('rpi') || lower.includes('cb1') || lower.includes('linux')) {
        hwType = 'sbc';
      } else if (lower.includes('ebb') || lower.includes('toolhead') || lower.includes('th')) {
        hwType = 'toolhead';
      } else {
        hwType = 'expander';
      }
    }

    // Detect communication type from MCU params
    let commType: CommunicationType = 'usb';
    for (const param of primaryMcu.params) {
      if (param.is_commented_out) continue;
      if (param.key === 'canbus_uuid' || param.key === 'canbus_interface') { commType = 'canbus'; break; }
      if (param.key === 'serial') {
        const val = param.value || '';
        if (val.includes('/dev/serial/by-id/usb-')) { commType = 'usb'; break; }
        if (/\/dev\/tty(S|AMA|ACM|USB)/.test(val)) { commType = 'uart'; break; }
      }
    }

    // Check if a hardware node already exists for this file
    const existingHwNode = graphStore.nodes.find(
      (n) => n.type === 'hardware' && (n.data as Record<string, unknown>).configFile === filename,
    );
    if (existingHwNode) return;

    // Determine label
    const label = mcuName || filename.replace(/\.cfg$/, '');

    // Check if this should be primary (no existing primary mainboard)
    const hasPrimary = graphStore.nodes.some(
      (n) => n.type === 'hardware' && !!(n.data as Record<string, unknown>).isPrimary,
    );
    const isPrimary = hwType === 'mainboard' && !hasPrimary;

    // Create hardware node
    const nodeId = graphStore.addHardwareNode(hwType, label, filename, undefined, mcuName);
    if (isPrimary) {
      graphStore.updateNodeData(nodeId, { isPrimary: true });
    }

    // Create sub-component/feature child nodes
    for (const sec of sections) {
      if (sec.section_type === 'include') continue;
      const schema = schemas[sec.section_type];
      const displayName = schema?.display_name || sec.section_type;
      const sLabel = sec.section_name ? `${displayName}: ${sec.section_name}` : displayName;
      if (FEAT_TYPES.has(sec.section_type)) {
        graphStore.addFeatureNode(nodeId, sec.section_type, sLabel, sec.full_header);
      } else {
        graphStore.addSubComponentNode(nodeId, sec.section_type, sLabel, sec.full_header);
      }
    }

    // Ensure SBC node exists
    let sbcNode = graphStore.nodes.find(
      (n) => n.type === 'hardware' && (n.data as Record<string, unknown>).hardwareType === 'sbc',
    );
    if (!sbcNode && hwType !== 'sbc') {
      const sbcId = graphStore.addHardwareNode('sbc', 'SBC', '', undefined, 'host_mcu');
      sbcNode = graphStore.nodes.find((n) => n.id === sbcId)!;
    }

    // Add communication edge from SBC to hardware
    if (sbcNode && hwType !== 'sbc') {
      graphStore.addCommunicationEdge(sbcNode.id, nodeId, commType);
    }

    // Collapse the hardware node by default (matches import behavior)
    graphStore.toggleHardwareCollapse(nodeId);

    // Auto-arrange so everything is visible
    graphStore.autoArrange();
  };

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
      setConfigFile(name, {
        filename: name,
        sections: res.config.sections,
        includes: res.config.includes || [],
        header_comments: res.config.header_comments || [],
      });
      setActiveFile(name);
      const cf = useConfigStore.getState().configFiles[name];
      if (cf) setEditText(await exportConfigText(cf));
      setIsDirty(false);

      // Build graph nodes for the newly added config file
      buildGraphForNewFile(name, res.config.sections);
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
          <button
            onClick={() => { setShowAddConfig(true); setAddConfigStep('choose'); setFileError(''); }}
            title="Add Configuration"
            className="text-[var(--color-text-secondary)] hover:text-[var(--color-accent)] transition-colors"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
            </svg>
          </button>
        </div>
        <div className="flex-1 overflow-y-auto py-1">
          {filenames.map((fn) => (
            <button
              key={fn}
              onClick={() => handleFileSwitch(fn)}
              onContextMenu={(e) => handleFileContextMenu(e, fn)}
              title={fn}
              className={`w-full text-left px-3 py-1.5 text-xs font-medium transition-colors truncate ${
                fn === activeFile
                  ? 'bg-[var(--color-accent)] text-[var(--color-bg-primary)]'
                  : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-primary)]'
              }`}
            >
              {fn}
            </button>
          ))}
        </div>
      </div>
      )}

      {showSectionsSidebar && (
        <div className="w-60 shrink-0 flex flex-col bg-[var(--color-bg-secondary)] border-r border-[var(--color-bg-tertiary)]">
          <div className="px-3 py-2 shrink-0 border-b border-[var(--color-bg-tertiary)] flex items-center justify-between">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-secondary)]">Sections</span>
            <span className="text-[10px] text-[var(--color-text-secondary)]">{sectionEntries.length}</span>
          </div>
          <div className="flex-1 overflow-y-auto py-1">
            {sectionEntries.map((entry, idx) => (
              <button
                key={`${entry.title}-${idx}`}
                onClick={() => jumpToLine(entry.line)}
                className="w-full text-left px-3 py-1.5 text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-primary)]"
              >
                <span className="font-mono text-[10px] text-[var(--color-accent)] mr-1">{entry.line}</span>
                {entry.title}
              </button>
            ))}
            {sectionEntries.length === 0 && (
              <div className="px-3 py-3 text-xs text-[var(--color-text-secondary)]">No sections found.</div>
            )}
          </div>
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
            onClick={handleDeleteFile}
            disabled={contextMenu.file === 'printer.cfg'}
            className="w-full text-left px-3 py-1.5 text-xs text-[var(--color-error)] hover:bg-[var(--color-bg-tertiary)] transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          >
            Delete
          </button>
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
              onClick={() => setShowFileSidebar((prev) => !prev)}
              className="px-2 py-1 rounded text-xs font-medium bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)] hover:bg-[var(--color-accent)] hover:text-[var(--color-bg-primary)]"
            >
              {showFileSidebar ? 'Hide files' : 'Show files'}
            </button>
            <button
              onClick={() => setShowSectionsSidebar((prev) => !prev)}
              className="px-2 py-1 rounded text-xs font-medium bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)] hover:bg-[var(--color-accent)] hover:text-[var(--color-bg-primary)]"
            >
              {showSectionsSidebar ? 'Hide sections' : 'Show sections'}
            </button>
            <button
              onClick={() => setShowReferenceViewer(true)}
              className="px-2 py-1 rounded text-xs font-medium bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)] hover:bg-[var(--color-accent)] hover:text-[var(--color-bg-primary)]"
            >
              Config ref
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
            <button
              onClick={handleApply}
              disabled={!isDirty}
              className={`px-3 py-1 rounded text-xs font-medium transition-colors ${
                isDirty
                  ? 'bg-[var(--color-accent)] text-[var(--color-bg-primary)] hover:bg-[var(--color-accent-hover)]'
                  : 'bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)] cursor-not-allowed'
              }`}
            >
              Apply Changes
            </button>
          </div>
        </div>

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
                className="shrink-0 overflow-hidden bg-[var(--color-bg-secondary)] text-right select-none pr-2 pl-2 pt-4 font-mono text-sm leading-relaxed text-[var(--color-text-secondary)] border-r border-[var(--color-bg-tertiary)]"
                style={{ minWidth: '3rem' }}
              >
                {editText.split('\n').map((_line, idx) => {
                  const lineNum = idx + 1;
                  const lineIssues = issuesByLine.get(lineNum);
                  const hasError = lineIssues?.some((i) => i.severity === 'error');
                  const hasWarning = lineIssues?.some((i) => i.severity === 'warning');
                  return (
                    <div
                      key={lineNum}
                      className="h-[1.625em] flex items-center justify-end"
                      title={lineIssues?.map((i) => i.text).join('\n')}
                    >
                      {hasError && <span className="w-2 h-2 rounded-full bg-[var(--color-error)] mr-1 shrink-0" />}
                      {!hasError && hasWarning && <span className="w-2 h-2 rounded-full bg-[var(--color-warning)] mr-1 shrink-0" />}
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
                    className={`flex items-center gap-2 px-3 py-1 text-xs cursor-pointer hover:bg-[var(--color-bg-tertiary)] ${
                      issue.severity === 'error' ? 'text-[var(--color-error)]' : 'text-[var(--color-warning)]'
                    }`}
                    onClick={() => {
                      jumpToLine(issue.line);
                    }}
                  >
                    <span>{issue.severity === 'error' ? '●' : '▲'}</span>
                    <span>Line {issue.line}: {issue.text}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Apply warning dialog */}
        {showApplyWarning && (
          <ApplyWarningDialog
            issues={inlineIssues}
            onProceed={handleApplyAnyway}
            onCancel={() => setShowApplyWarning(false)}
          />
        )}

        {showReferenceViewer && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setShowReferenceViewer(false)}>
            <div className="h-[80vh] w-[80vw] max-w-[1100px] rounded-xl border border-[var(--color-bg-tertiary)] bg-[var(--color-bg-secondary)] p-4 shadow-2xl" onClick={(e) => e.stopPropagation()}>
              <div className="mb-3 flex items-center justify-between">
                <h3 className="text-sm font-semibold text-[var(--color-text-primary)]">Config_Reference.md</h3>
                <button onClick={() => setShowReferenceViewer(false)} className="rounded-md border border-[var(--color-bg-tertiary)] px-2 py-1 text-xs text-[var(--color-text-primary)]">Close</button>
              </div>
              <div className="h-[calc(100%-44px)] overflow-auto rounded-lg border border-[var(--color-bg-tertiary)] bg-[var(--color-bg-primary)] p-4">
                {configReferenceError && <div className="text-xs text-[var(--color-error)]">{configReferenceError}</div>}
                {!configReferenceError && !configReferenceText && <div className="text-xs text-[var(--color-text-secondary)]">Loading…</div>}
                {!!configReferenceText && (
                  <div
                    className="prose prose-invert max-w-none text-xs leading-5 text-[var(--color-text-primary)]"
                    dangerouslySetInnerHTML={{ __html: renderSimpleMarkdown(configReferenceText) }}
                  />
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
});

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

function renderSimpleMarkdown(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const html: string[] = [];
  let inCode = false;
  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (line.startsWith('```')) {
      if (!inCode) {
        html.push('<pre><code>');
      } else {
        html.push('</code></pre>');
      }
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      html.push(`${escapeHtml(rawLine)}\n`);
      continue;
    }
    if (/^###\s+/.test(line)) {
      html.push(`<h3>${escapeHtml(line.replace(/^###\s+/, ''))}</h3>`);
      continue;
    }
    if (/^##\s+/.test(line)) {
      html.push(`<h2>${escapeHtml(line.replace(/^##\s+/, ''))}</h2>`);
      continue;
    }
    if (/^#\s+/.test(line)) {
      html.push(`<h1>${escapeHtml(line.replace(/^#\s+/, ''))}</h1>`);
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      html.push(`<div>• ${escapeHtml(line.replace(/^\s*[-*]\s+/, ''))}</div>`);
      continue;
    }
    if (!line) {
      html.push('<br/>');
      continue;
    }
    html.push(`<div>${escapeHtml(line)}</div>`);
  }
  if (inCode) {
    html.push('</code></pre>');
  }
  return html.join('');
}
