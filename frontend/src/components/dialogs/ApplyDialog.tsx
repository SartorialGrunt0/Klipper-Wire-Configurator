import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { createTwoFilesPatch } from 'diff';
import { useConfigStore } from '../../stores/configStore';
import { useNativeStore } from '../../stores/nativeStore';
import { getSaveButtonClass } from '../../utils/saveButtonClass';
import { selectSaveGateIssues, warningToBulkAck, type SaveGateFinding } from '../../utils/saveGate';
import * as api from '../../services/api';
import type { ConfigFile } from '../../types/config';
import type { NativeStatus } from '../../services/api';

interface ApplyDialogProps {
  onClose: () => void;
  canAnalyzeWithAi?: boolean;
  onAnalyzeWithAi?: (prompt: string) => void;
  /** Switch the main view to the text editor so a findings click can land on
   *  the file/line (the text editor consumes the store's pending line jump
   *  once its text is loaded). */
  onShowTextView?: () => void;
}

interface DiffLine {
  type: 'added' | 'removed' | 'context' | 'header';
  content: string;
}

function parsePatch(patch: string): DiffLine[] {
  const lines: DiffLine[] = [];
  for (const line of patch.split('\n')) {
    if (line.startsWith('@@')) {
      lines.push({ type: 'header', content: line });
    } else if (line.startsWith('+') && !line.startsWith('+++')) {
      lines.push({ type: 'added', content: line.slice(1) });
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      lines.push({ type: 'removed', content: line.slice(1) });
    } else if (line.startsWith(' ')) {
      lines.push({ type: 'context', content: line.slice(1) });
    }
  }
  return lines;
}

async function exportConfigText(cf: ConfigFile): Promise<string> {
  return api.exportConfig(cf);
}

const ERROR_SECTION_RE = /section ['"]([^'"]+)['"]/i;
const AI_CONTEXT_CHAR_LIMIT = 40_000;

function truncateAiContext(content: string, limit = AI_CONTEXT_CHAR_LIMIT): string {
  if (content.length <= limit) {
    return content;
  }

  return `${content.slice(0, limit)}\n\n# Context truncated after ${limit} characters.`;
}

function normalizeSectionHeader(value: string): string {
  return value
    .trim()
    .replace(/^\[/, '')
    .replace(/\]$/, '')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function findPrinterConfigFilename(filenames: string[]): string | null {
  return filenames.find((filename) => filename.toLowerCase() === 'printer.cfg')
    ?? filenames.find((filename) => filename.toLowerCase().endsWith('/printer.cfg'))
    ?? null;
}

function extractSectionNameFromRestartFailure(restartMessage: string, restartErrors: string[]): string | null {
  for (const candidate of [restartMessage, ...restartErrors]) {
    const match = ERROR_SECTION_RE.exec(candidate);
    if (match?.[1]) {
      return match[1].trim();
    }
  }

  return null;
}

function findSectionLocation(
  configFiles: Record<string, ConfigFile>,
  sectionName: string,
): { filename: string; sectionIndex: number } | null {
  const normalizedTarget = normalizeSectionHeader(sectionName);

  for (const [filename, configFile] of Object.entries(configFiles)) {
    for (let sectionIndex = 0; sectionIndex < configFile.sections.length; sectionIndex += 1) {
      const section = configFile.sections[sectionIndex];
      const normalizedCandidates = [
        section.full_header,
        `[${section.full_header}]`,
        section.section_name ? `${section.section_type} ${section.section_name}` : section.section_type,
      ].map(normalizeSectionHeader);

      if (normalizedCandidates.includes(normalizedTarget)) {
        return { filename, sectionIndex };
      }
    }
  }

  return null;
}

function extractSectionSnippet(fileText: string, configFile: ConfigFile, sectionIndex: number): string | null {
  const section = configFile.sections[sectionIndex];
  if (!section) {
    return null;
  }

  const lines = fileText.split(/\r?\n/);
  const startLine = Math.max(section.line_number - 1, 0);
  const nextSection = configFile.sections[sectionIndex + 1];
  const endLine = nextSection
    ? Math.max(nextSection.line_number - 1, startLine + 1)
    : lines.length;
  const snippet = lines.slice(startLine, endLine).join('\n').trim();

  return snippet || null;
}

function buildRestartAnalysisPrompt(args: {
  restartMessage: string;
  restartErrors: string[];
  logPath: string | null;
  logExcerpt: string;
  printerConfigFilename: string | null;
  printerConfigText: string | null;
  sectionName: string | null;
  sectionFilename: string | null;
  sectionText: string | null;
}): string {
  const sections: string[] = [
    'A Klipper FIRMWARE_RESTART failed immediately after saving the current config. Diagnose the root cause and provide the minimal config fix.',
    'Return only the changed Klipper sections inside fenced cfg code blocks. If the fix belongs in a file other than printer.cfg, start that cfg block with a first comment line exactly like "# file: <filename>". After the cfg block, briefly explain the fix.',
    `Restart result:\n${args.restartMessage}`,
  ];

  if (args.restartErrors.length > 0) {
    sections.push([
      'Recent Klipper error lines:',
      '```text',
      args.restartErrors.join('\n'),
      '```',
    ].join('\n'));
  }

  if (args.logExcerpt.trim()) {
    sections.push([
      `Relevant klippy.log excerpt${args.logPath ? ` from ${args.logPath}` : ''}:`,
      '```text',
      args.logExcerpt,
      '```',
    ].join('\n'));
  }

  if (args.printerConfigFilename && args.printerConfigText) {
    sections.push([
      `Current ${args.printerConfigFilename}:`,
      '```cfg',
      truncateAiContext(args.printerConfigText),
      '```',
    ].join('\n'));
  }

  if (args.sectionName && args.sectionText) {
    sections.push([
      `Config section mentioned by the error${args.sectionFilename ? ` in ${args.sectionFilename}` : ''}:`,
      '```cfg',
      args.sectionText,
      '```',
    ].join('\n'));
  }

  return sections.join('\n\n');
}

export default function ApplyDialog({ onClose, canAnalyzeWithAi = false, onAnalyzeWithAi, onShowTextView }: ApplyDialogProps) {
  const storeSnapshot = useRef(useConfigStore.getState());
  const { configFiles, originalTexts } = storeSnapshot.current;
  const { configPath } = useNativeStore();
  // Live state for the Save-button color — matches the toolbar button so the
  // dialog's actions always agree with it (grey/green/yellow/red).
  const isDirty = useConfigStore((s) => s.isDirty);
  const validation = useConfigStore((s) => s.validation);
  const hasTextParseError = Object.keys(useConfigStore((s) => s.textParseErrors)).length > 0;
  const saveButtonClass = getSaveButtonClass(isDirty, validation, hasTextParseError);
  // A file deleted since import is gone from configFiles but its original text
  // survives in originalTexts — union both so deletions show up in the diff
  // and are actually removed from disk on save.
  const filenames = Array.from(new Set([...Object.keys(configFiles), ...Object.keys(originalTexts)]));
  const deletedFilenames = filenames.filter((fn) => !(fn in configFiles) && fn in originalTexts);

  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set(filenames));
  const [status, setStatus] = useState<'idle' | 'exporting' | 'applying' | 'success' | 'error'>('idle');
  const [message, setMessage] = useState('');
  const [appliedFiles, setAppliedFiles] = useState<string[]>([]);
  const [restartStatus, setRestartStatus] = useState<'idle' | 'restarting' | 'success' | 'error'>('idle');
  const [restartMessage, setRestartMessage] = useState('');
  const [restartErrors, setRestartErrors] = useState<string[]>([]);
  const [restartLogPath, setRestartLogPath] = useState<string | null>(null);
  const [aiAnalyzeLoading, setAiAnalyzeLoading] = useState(false);
  const [printerStatusLoading, setPrinterStatusLoading] = useState(false);
  const [printerIsPrinting, setPrinterIsPrinting] = useState(false);
  const [printerPrintState, setPrinterPrintState] = useState<string | null>(null);
  const [printerPrintFilename, setPrinterPrintFilename] = useState<string | null>(null);

  // Determine save mode
  const isNativeMode = useNativeStore((s) => s.isNative);
  const isLocalMode = isNativeMode === false || isNativeMode === null;

  /* ── Phase 4 save gate: findings for the selected files ─────────────
     Errors + warnings, never info (info is order-dependent context and
     can't be fixed by acknowledging). Computed from the LIVE store state —
     not the mount snapshot — so the gate reflects current validation. */
  const textParseErrors = useConfigStore((s) => s.textParseErrors);
  const gateIssues = useMemo(() => {
    const selected = Array.from(selectedFiles);
    return selectSaveGateIssues(validation, selected, textParseErrors);
  }, [validation, selectedFiles, textParseErrors]);
  const hasGateErrors = gateIssues.hasErrors;
  const hasGateWarnings = gateIssues.hasWarnings;

  // Confirmation flow: clicking Save with gate findings opens a single
  // overlay (errors OR warnings, never both stacked — errors dominate).
  // The checkbox acknowledges every listed warning in one bulk call.
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [ackAllChecked, setAckAllChecked] = useState(false);
  const [ackBusy, setAckBusy] = useState(false);
  const [ackError, setAckError] = useState('');

  useEffect(() => {
    // Reset the checkbox + errors every time the overlay reopens.
    if (!confirmOpen) {
      setAckAllChecked(false);
      setAckError('');
      setAckBusy(false);
    }
  }, [confirmOpen]);

  const openConfirm = () => {
    setConfirmOpen(true);
  };

  const handleFindingClick = (finding: SaveGateFinding) => {
    if (finding.line_number < 1) return; // nothing to jump to
    onShowTextView?.();
    useConfigStore.getState().requestLineJump(finding.file, finding.line_number);
    onClose(); // reveal the editor; the dialog's findings can be re-opened
  };

  const ackAllWarnings = async (): Promise<boolean> => {
    setAckError('');
    try {
      await api.acknowledgeWarningsBulk(gateIssues.warnings.map(warningToBulkAck));
      // Re-run PROJECT validation so the acknowledged warnings clear from
      // the gutter, the save button, and this gate (one call revalidates
      // the whole project for multi-file projects).
      const firstFile = Array.from(selectedFiles)[0];
      if (firstFile) void useConfigStore.getState().revalidateFile(firstFile);
      return true;
    } catch (err) {
      setAckError(err instanceof Error ? err.message : 'Could not acknowledge warnings');
      return false;
    }
  };

  const handleAckAndSave = async () => {
    if (!ackAllChecked || gateIssues.warnings.length === 0) return;
    setAckBusy(true);
    const ok = await ackAllWarnings();
    setAckBusy(false);
    if (!ok) return;
    setConfirmOpen(false);
    void handleApply();
  };

  const handleSaveWithoutAck = () => {
    setConfirmOpen(false);
    void handleApply();
  };

  // Errors-present path: "Continue saving anyway" — errors are never
  // acknowledged; the user fixes them first (warnings can be bulk-acked
  // on the next save, once the errors are gone).
  const handleContinueAnyway = () => {
    setConfirmOpen(false);
    void handleApply();
  };

  const handleSaveClick = () => {
    // Hard block first (spec): unparseable text in a selected file shows the
    // existing inline error, no overlay.
    if (gateIssues.blocked.length > 0) {
      void handleApply();
      return;
    }
    if (hasGateErrors || hasGateWarnings) {
      openConfirm();
      return;
    }
    void handleApply();
  };

  // One findings row (shared by the dialog list and the confirm overlay).
  const renderFindingRow = (f: SaveGateFinding, kind: 'error' | 'warning', key: string) => (
    <button
      key={key}
      type="button"
      onClick={() => {
        setConfirmOpen(false);
        handleFindingClick(f);
      }}
      disabled={f.line_number < 1}
      className="w-full flex items-start gap-2 px-2 py-1.5 text-left rounded-md hover:bg-[var(--color-bg-primary)] disabled:cursor-default disabled:opacity-60"
    >
      <span
        className={`mt-1 w-2 h-2 rounded-full shrink-0 ${kind === 'error' ? 'bg-red-500' : 'bg-[var(--color-warning)]'}`}
      />
      <span className="flex-1 min-w-0">
        <span className="block text-xs text-[var(--color-text-primary)] truncate">{f.message}</span>
        <span className="block text-[10px] font-mono text-[var(--color-text-secondary)] truncate">
          {f.file}{f.line_number > 0 ? `:${f.line_number}` : ''}{f.section ? ` · [${f.section}]` : ''}
        </span>
      </span>
    </button>
  );

  // Diff state
  const [currentTexts, setCurrentTexts] = useState<Record<string, string>>({});
  const [diffLoading, setDiffLoading] = useState(true);

  const hasAnyOriginals = filenames.some((fn) => fn in originalTexts);
  // New files (imported but never saved/Pi-loaded) have no original — show
  // them with a "new file" badge in the diff panel instead of hiding it.
  const hasAnyNewFiles = filenames.some((fn) => !(fn in originalTexts));
  const showDiffPanel = hasAnyOriginals || hasAnyNewFiles;

  // Export all configs once on mount to get current text for diff.
  useEffect(() => {
    let cancelled = false;
    async function fetchTexts() {
      const texts: Record<string, string> = {};
      try {
        for (const fn of filenames) {
          const cf = configFiles[fn];
          if (!cf) continue;
          texts[fn] = await exportConfigText(cf);
          if (cancelled) return;
        }
        setCurrentTexts(texts);
      } catch { /* diff just won't show */ } finally {
        if (!cancelled) setDiffLoading(false);
      }
    }
    fetchTexts();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // intentionally empty — snapshot via ref

  useEffect(() => {
    if (status !== 'success') {
      setPrinterStatusLoading(false);
      setPrinterIsPrinting(false);
      setPrinterPrintState(null);
      setPrinterPrintFilename(null);
      return;
    }

    let cancelled = false;

    async function fetchPrinterActivity() {
      setPrinterStatusLoading(true);
      try {
        const printerStatus = await api.getKlipperStatus();
        if (cancelled) {
          return;
        }
        setPrinterIsPrinting(printerStatus.is_printing);
        setPrinterPrintState(printerStatus.print_state);
        setPrinterPrintFilename(printerStatus.print_filename);
      } catch {
        if (cancelled) {
          return;
        }
        setPrinterIsPrinting(false);
        setPrinterPrintState(null);
        setPrinterPrintFilename(null);
      } finally {
        if (!cancelled) {
          setPrinterStatusLoading(false);
        }
      }
    }

    void fetchPrinterActivity();

    return () => {
      cancelled = true;
    };
  }, [status]);

  const toggleFile = (fn: string) => {
    setSelectedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(fn)) next.delete(fn);
      else next.add(fn);
      return next;
    });
  };

  const handleApply = useCallback(async () => {
    const files = Array.from(selectedFiles);
    if (files.length === 0) {
      setStatus('error');
      setMessage('No files selected.');
      return;
    }

    // Text view holds the last-good model while a file fails to parse — block
    // saving so the user's latest (unparseable) text can't be silently dropped.
    const parseErrors = useConfigStore.getState().textParseErrors;
    const blockedFile = files.find((fn) => parseErrors[fn]);
    if (blockedFile) {
      setStatus('error');
      setMessage(`Cannot save "${blockedFile}": the text in the editor can't be parsed. Fix it in the text view first.`);
      return;
    }

    setStatus('exporting');
    setRestartStatus('idle');
    setRestartMessage('');
    setRestartErrors([]);
    setRestartLogPath(null);
    setMessage('Exporting config files...');

    try {
      // Export each config file to text
      const exportedFiles: Record<string, string> = {};
      for (const fn of files) {
        const cf = configFiles[fn];
        if (!cf) continue;
        const text = currentTexts[fn] ?? await api.exportConfig(cf);
        exportedFiles[fn] = text;
      }

      // Files selected that exist in the model are written; files selected
      // that were deleted from the model are removed from storage.
      const deleted = files.filter((fn) => !(fn in configFiles));

      if (isLocalMode) {
        // Non-native mode: save to local config storage
        setStatus('applying');
        setMessage(`Saving ${Object.keys(exportedFiles).length} file${Object.keys(exportedFiles).length !== 1 ? 's' : ''} locally...`);
        const result = await api.saveConfigsToLocal(exportedFiles, deleted);
        setAppliedFiles(result.saved);
        setStatus('success');
        setMessage(`Successfully saved ${result.saved.length} file${result.saved.length !== 1 ? 's' : ''} locally${result.removed.length ? `, removed ${result.removed.length} file${result.removed.length !== 1 ? 's' : ''}` : ''}`);
      } else {
        // Native mode: save to Pi config path
        setStatus('applying');
        setMessage(`Writing ${Object.keys(exportedFiles).length} files to ${configPath}...`);
        const result = await api.applyNativeConfig(exportedFiles, configPath, deleted);
        setAppliedFiles(result.files);
        setStatus('success');
        setMessage(`Successfully saved ${result.files.length} file${result.files.length !== 1 ? 's' : ''} to ${result.config_path}${result.removed.length ? `, removed ${result.removed.length} file${result.removed.length !== 1 ? 's' : ''}` : ''}`);
      }

      // Update originalTexts to match what was saved, so diff resets
      const configStore = useConfigStore.getState();
      for (const [fn, text] of Object.entries(exportedFiles)) {
        configStore.setOriginalText(fn, text);
      }
      // Deleted files no longer have an original — drop them so the diff
      // doesn't keep showing them as deleted forever.
      configStore.removeOriginalTexts(deleted);
      configStore.markClean();
    } catch (err) {
      setStatus('error');
      setMessage(err instanceof Error ? err.message : 'Save failed');
    }
  }, [selectedFiles, configFiles, configPath, currentTexts, isLocalMode]);

  const pollKlipperStatusAfterRestart = useCallback(async () => {
    const maxAttempts = 24;
    const delayMs = 1500;
    let lastErrorMessage = '';

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        const statusResult = await api.getKlipperStatus();
        const state = statusResult.state.toLowerCase();

        if (state === 'ready') {
          setRestartErrors([]);
          setRestartLogPath(statusResult.log_path);
          return {
            ok: true,
            statusResult,
          };
        }

        if (state === 'shutdown' || state === 'error') {
          setRestartErrors(statusResult.recent_errors ?? []);
          setRestartLogPath(statusResult.log_path);
          return {
            ok: false,
            statusResult,
          };
        }
      } catch (err) {
        lastErrorMessage = err instanceof Error ? err.message : 'Unable to query Klipper status';
      }

      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }

    throw new Error(lastErrorMessage || 'Timed out waiting for Klipper to report status after restart');
  }, []);

  const handleFirmwareRestart = useCallback(async () => {
    setRestartErrors([]);
    setRestartLogPath(null);
    setAiAnalyzeLoading(false);
    setRestartStatus('restarting');
    setRestartMessage('Sending FIRMWARE_RESTART to Klipper...');
    try {
      const result = await api.firmwareRestartKlipper();
      setRestartMessage(`Klipper restart requested via ${result.socket_path}. Waiting for status...`);

      const polled = await pollKlipperStatusAfterRestart();
      if (polled.ok) {
        setRestartStatus('success');
        const readyMessage = polled.statusResult.state_message || 'Printer is ready';
        setRestartMessage(`Klipper restarted successfully: ${readyMessage}`);
        return;
      }

      setRestartStatus('error');
      const errorMessage = polled.statusResult.state_message || 'Klipper reported an error state after restart';
      setRestartMessage(`Restart failed: ${errorMessage}`);
    } catch (err) {
      setRestartStatus('error');
      setRestartMessage(err instanceof Error ? err.message : 'Firmware restart failed');
    }
  }, [pollKlipperStatusAfterRestart]);

  const handleAiAnalyze = useCallback(async () => {
    if (!canAnalyzeWithAi || !onAnalyzeWithAi) {
      return;
    }

    setAiAnalyzeLoading(true);
    try {
      const readConfigText = async (filename: string | null): Promise<string | null> => {
        if (!filename) {
          return null;
        }

        const existingText = currentTexts[filename];
        if (typeof existingText === 'string') {
          return existingText;
        }

        const configFile = configFiles[filename];
        if (!configFile) {
          return null;
        }

        return exportConfigText(configFile);
      };

      const sectionName = extractSectionNameFromRestartFailure(restartMessage, restartErrors);
      const printerConfigFilename = findPrinterConfigFilename(filenames);
      const printerConfigText = await readConfigText(printerConfigFilename);
      const sectionLocation = sectionName ? findSectionLocation(configFiles, sectionName) : null;
      const sectionFile = sectionLocation ? configFiles[sectionLocation.filename] : null;
      const sectionFileText = sectionLocation ? await readConfigText(sectionLocation.filename) : null;
      const sectionText = sectionLocation && sectionFile && sectionFileText
        ? extractSectionSnippet(sectionFileText, sectionFile, sectionLocation.sectionIndex)
        : null;

      let logExcerpt = restartErrors.join('\n');
      let logPath = restartLogPath;
      try {
        const excerptResult = await api.getKlippyLogExcerpt(
          sectionName ?? undefined,
          [restartMessage, ...restartErrors].filter(Boolean).join('\n'),
          20,
        );
        if (excerptResult.excerpt.trim()) {
          logExcerpt = excerptResult.excerpt;
          logPath = excerptResult.log_path;
        }
      } catch {
        // Fall back to the already-fetched recent error lines.
      }

      onAnalyzeWithAi(buildRestartAnalysisPrompt({
        restartMessage,
        restartErrors,
        logPath,
        logExcerpt,
        printerConfigFilename,
        printerConfigText,
        sectionName,
        sectionFilename: sectionLocation?.filename ?? null,
        sectionText,
      }));
    } finally {
      setAiAnalyzeLoading(false);
    }
  }, [canAnalyzeWithAi, configFiles, currentTexts, filenames, onAnalyzeWithAi, restartErrors, restartLogPath, restartMessage]);

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="bg-[var(--color-bg-secondary)] rounded-xl shadow-2xl flex flex-col border border-[var(--color-bg-tertiary)] overflow-hidden"
        style={{ width: showDiffPanel ? 900 : 480, maxHeight: '85vh' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-[var(--color-bg-tertiary)]">
          <div>
            <h2 className="text-base font-semibold text-[var(--color-text-primary)]">
              {isLocalMode ? 'Save Config Files' : 'Save to Pi'}
            </h2>
            <p className="text-xs text-[var(--color-text-secondary)] mt-0.5">
              {isLocalMode
                ? 'Persist config changes to local storage'
                : <>Write config files to <span className="font-mono">{configPath}</span></>
              }
            </p>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)]">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        {/* Warning */}
        <div className="mx-4 mt-3 px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/30">
          <p className="text-xs text-amber-400">
            {isLocalMode
              ? 'This will overwrite the previously imported config files in local storage.'
              : 'This will overwrite existing config files on the Pi. Make sure you have a backup.'
            }
          </p>
        </div>

        {/* Save gate: validation findings for the selected files (errors →
            warnings; info never shown — it's order-dependent context). Click
            a row to jump to it in the text view. */}
        {(hasGateErrors || hasGateWarnings) && (
          <div className="mx-4 mt-3 rounded-lg border border-[var(--color-bg-tertiary)] overflow-hidden">
            <div className="flex items-center justify-between px-3 py-1.5 bg-[var(--color-bg-primary)]">
              <span className="text-xs font-semibold text-[var(--color-text-primary)]">
                Validation findings ({gateIssues.errors.length + gateIssues.warnings.length})
              </span>
              <span className="text-[10px] text-[var(--color-text-secondary)]">
                click a finding to jump to it
              </span>
            </div>
            <div className="max-h-48 overflow-y-auto p-1.5">
              {gateIssues.errors.map((f, i) => renderFindingRow(f, 'error', `e-${i}`))}
              {gateIssues.warnings.map((f, i) => renderFindingRow(f, 'warning', `w-${i}`))}
            </div>
          </div>
        )}

        {/* Body */}
        <div className="flex flex-1 overflow-hidden">
          {/* Left: file list */}
          <div className={`flex flex-col ${showDiffPanel ? 'w-52 shrink-0 border-r border-[var(--color-bg-tertiary)]' : 'flex-1'}`}>
            <div className="flex-1 overflow-y-auto p-4">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs text-[var(--color-text-secondary)]">
                  {selectedFiles.size} of {filenames.length} files selected
                </span>
              </div>
              <div className="space-y-1">
                {filenames.map((fn) => {
                  const isDeleted = fn in originalTexts && !(fn in configFiles);
                  return (
                    <label
                      key={fn}
                      className={`group flex items-center gap-2 px-2 py-1.5 rounded-md cursor-pointer ${
                        appliedFiles.includes(fn) ? 'bg-green-500/10' : 'hover:bg-[var(--color-bg-primary)]'
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={selectedFiles.has(fn)}
                        onChange={() => toggleFile(fn)}
                        disabled={status === 'applying' || status === 'success'}
                        className="rounded"
                      />
                      <div className="kwc-marquee-shell flex-1 min-w-0">
                        <div className="kwc-marquee-track">
                          <span className="kwc-marquee-text text-xs font-mono text-[var(--color-text-primary)]">{fn}</span>
                          <span aria-hidden="true" className="kwc-marquee-text text-xs font-mono text-[var(--color-text-primary)]">{fn}</span>
                        </div>
                      </div>
                      {isDeleted && (
                        <span className="shrink-0 text-[10px] font-semibold text-[var(--color-error)]">deleted</span>
                      )}
                      {appliedFiles.includes(fn) && (
                        <span className="w-11 shrink-0 text-right text-xs text-green-400">Saved</span>
                      )}
                    </label>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Right: diff panel (when originals exist or files are new) */}
          {showDiffPanel && (
            <div className="flex-1 overflow-auto p-4 space-y-4">
              {diffLoading ? (
                <p className="text-xs text-[var(--color-text-secondary)] text-center py-8">Generating diff...</p>
              ) : (
                filenames
                  .filter((fn) => selectedFiles.has(fn))
                  .map((fn) => {
                    const original = originalTexts[fn];
                    const current = currentTexts[fn];
                    const hasOriginal = fn in originalTexts;
                    const isDeleted = hasOriginal && !(fn in configFiles);

                    let diffLines: DiffLine[] = [];
                    let hasChanges = false;
                    if (current !== undefined || isDeleted) {
                      // Deleted files have no current text — diff against empty
                      // so every original line shows as removed. New files have
                      // no original — diff against empty so every line shows as
                      // added (moved sub-components/features stay visible).
                      const patch = createTwoFilesPatch(fn, fn, original ?? '', current ?? '', 'saved', isDeleted ? 'deleted' : 'current', { context: 3 });
                      diffLines = parsePatch(patch);
                      hasChanges = diffLines.some((l) => l.type === 'added' || l.type === 'removed');
                    }

                    return (
                      <div key={fn}>
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-xs font-semibold text-[var(--color-text-primary)]">{fn}</span>
                          {isDeleted && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-[var(--color-error)]/20 text-[var(--color-error)]">deleted</span>
                          )}
                          {!hasOriginal && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-[var(--color-warning)]/20 text-[var(--color-warning)]">new file</span>
                          )}
                          {hasOriginal && !isDeleted && !hasChanges && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)]">unchanged</span>
                          )}
                          {hasOriginal && !isDeleted && hasChanges && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-[var(--color-accent)]/20 text-[var(--color-accent)]">
                              {diffLines.filter((l) => l.type === 'added' || l.type === 'removed').length} lines changed
                            </span>
                          )}
                          {isDeleted && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-[var(--color-error)]/20 text-[var(--color-error)]">
                              {diffLines.filter((l) => l.type === 'removed').length} lines removed
                            </span>
                          )}
                        </div>

                        {hasChanges && (
                          <div className="rounded-lg border border-[var(--color-bg-tertiary)] overflow-hidden">
                            <pre className="text-xs leading-5 font-mono overflow-x-auto">
                              {diffLines.map((line, i) => (
                                <div
                                  key={i}
                                  className={
                                    line.type === 'added'
                                      ? 'w-max min-w-full bg-green-500/15 text-green-400 px-3'
                                      : line.type === 'removed'
                                        ? 'w-max min-w-full bg-red-500/15 text-red-400 px-3'
                                        : line.type === 'header'
                                          ? 'w-max min-w-full bg-blue-500/10 text-blue-400 px-3 py-0.5'
                                          : 'w-max min-w-full text-[var(--color-text-secondary)] px-3'
                                  }
                                >
                                  <span className="select-none opacity-40 mr-2">
                                    {line.type === 'added' ? '+' : line.type === 'removed' ? '-' : ' '}
                                  </span>
                                  {line.content || '\u00A0'}
                                </div>
                              ))}
                            </pre>
                          </div>
                        )}
                      </div>
                    );
                  })
              )}

              {!diffLoading && filenames.filter((fn) => selectedFiles.has(fn) && fn in originalTexts).length === 0 && (
                <p className="text-xs text-[var(--color-text-secondary)] text-center py-8">
                  No original versions available to compare.
                </p>
              )}
            </div>
          )}
        </div>

        {/* Status */}
        {message && (
          <div className={`px-4 py-2 text-xs ${
            status === 'error' ? 'text-red-400' :
            status === 'success' ? 'text-green-400' :
            'text-[var(--color-text-secondary)]'
          }`}>
            {message}
          </div>
        )}

        {restartMessage && (
          <div className={`px-4 pb-2 text-xs ${
            restartStatus === 'error' ? 'text-red-400' :
            restartStatus === 'success' ? 'text-green-400' :
            'text-[var(--color-text-secondary)]'
          }`}>
            {restartMessage}
          </div>
        )}

        {status === 'success' && printerIsPrinting && (
          <div className="px-4 pb-2 text-xs text-amber-300">
            Moonraker reports an active print job{printerPrintState ? ` (${printerPrintState})` : ''}
            {printerPrintFilename ? ` for ${printerPrintFilename}` : ''}. Firmware restart is disabled until it finishes.
          </div>
        )}

        {restartErrors.length > 0 && (
          <div className="mx-4 mb-3 p-3 rounded-lg border border-red-500/30 bg-red-500/10">
            <p className="text-xs text-red-300 mb-2">
              Recent Klipper errors{restartLogPath ? ` from ${restartLogPath}` : ''}:
            </p>
            <div className="max-h-40 overflow-y-auto rounded bg-black/30 p-2">
              <pre className="text-[11px] leading-5 text-red-200 whitespace-pre-wrap break-words font-mono">
                {restartErrors.join('\n')}
              </pre>
            </div>
          </div>
        )}

        {/* Footer */}
        <div className="p-4 border-t border-[var(--color-bg-tertiary)] flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-4 py-1.5 rounded-md text-xs font-medium bg-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] hover:bg-[var(--color-bg-primary)] transition-colors"
          >
            {status === 'success' ? 'Done' : 'Cancel'}
          </button>
          {status !== 'success' && (
            <button
              onClick={handleSaveClick}
              disabled={status === 'exporting' || status === 'applying' || selectedFiles.size === 0}
              className={`px-4 py-1.5 rounded-md text-xs font-medium transition-colors disabled:opacity-50 ${saveButtonClass}`}
            >
              {status === 'exporting' ? 'Exporting...' : status === 'applying' ? 'Writing...' : 'Save Changes'}
            </button>
          )}
          {status === 'success' && (
            canAnalyzeWithAi && restartStatus === 'error' && (
              <button
                onClick={() => {
                  void handleAiAnalyze();
                }}
                disabled={aiAnalyzeLoading}
                className="px-4 py-1.5 rounded-md text-xs font-medium bg-[var(--color-accent)] text-white hover:opacity-90 transition-opacity disabled:opacity-50"
              >
                {aiAnalyzeLoading ? 'Analyzing...' : 'AI Analyze'}
              </button>
            )
          )}
          {status === 'success' && !isLocalMode && (
            <button
              onClick={handleFirmwareRestart}
              disabled={restartStatus === 'restarting' || restartStatus === 'success' || printerStatusLoading || printerIsPrinting}
              className={`px-4 py-1.5 rounded-md text-xs font-medium transition-colors disabled:opacity-50 ${saveButtonClass}`}
            >
              {printerStatusLoading
                ? 'Checking printer...'
                : printerIsPrinting
                  ? 'Firmware Restart Disabled'
                  : restartStatus === 'restarting'
                ? 'Restarting...'
                : restartStatus === 'success'
                  ? 'Restart Sent'
                  : 'Firmware Restart'}
            </button>
          )}
        </div>
      </div>

      {/* Save-gate confirmation — a single overlay above the dialog (z-[60],
          the app's nested-dialog pattern). Warnings-only → "Save with
          warnings?" + optional bulk-ack checkbox; errors present →
          "Active errors" + startup-failure line, never acked. */}
      {confirmOpen && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60"
          onClick={() => setConfirmOpen(false)}
        >
          <div
            className="bg-[var(--color-bg-secondary)] rounded-xl shadow-2xl flex flex-col border border-[var(--color-bg-tertiary)] overflow-hidden"
            style={{ width: 520, maxHeight: '85vh' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="p-4 border-b border-[var(--color-bg-tertiary)]">
              <h3 className="text-sm font-semibold text-[var(--color-text-primary)]">
                {hasGateErrors
                  ? 'Active errors'
                  : `Save with ${gateIssues.warnings.length} warning${gateIssues.warnings.length !== 1 ? 's' : ''}?`}
              </h3>
              {hasGateErrors ? (
                <p className="text-xs text-red-300 mt-1">
                  These errors will likely prevent Klipper from starting after a restart.
                  {gateIssues.warnings.length > 0 && ` The ${gateIssues.warnings.length} listed warning${gateIssues.warnings.length !== 1 ? 's are' : ' is'} not acknowledged — fix the errors first.`}
                </p>
              ) : (
                <p className="text-xs text-[var(--color-text-secondary)] mt-1">
                  The warnings don't block the save. Check the box to acknowledge all of
                  them at once so they stop flagging the save button.
                </p>
              )}
            </div>

            <div className="flex-1 overflow-y-auto p-2">
              {gateIssues.errors.map((f, i) => renderFindingRow(f, 'error', `ce-${i}`))}
              {gateIssues.warnings.map((f, i) => renderFindingRow(f, 'warning', `cw-${i}`))}
            </div>

            {ackError && (
              <p className="px-4 pb-1 text-xs text-red-400">{ackError}</p>
            )}

            <div className="p-4 border-t border-[var(--color-bg-tertiary)] flex items-center justify-between gap-2">
              {!hasGateErrors && gateIssues.warnings.length > 0 ? (
                <label className="flex items-center gap-2 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={ackAllChecked}
                    onChange={(e) => setAckAllChecked(e.target.checked)}
                    disabled={ackBusy}
                    className="rounded"
                  />
                  <span className="text-xs text-[var(--color-text-primary)]">Acknowledge all</span>
                </label>
              ) : (
                <span />
              )}
              <div className="flex gap-2">
                <button
                  onClick={() => setConfirmOpen(false)}
                  className="px-4 py-1.5 rounded-md text-xs font-medium bg-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] hover:bg-[var(--color-bg-primary)] transition-colors"
                >
                  Cancel
                </button>
                {hasGateErrors ? (
                  <button
                    onClick={handleContinueAnyway}
                    className="px-4 py-1.5 rounded-md text-xs font-medium bg-red-600 text-white hover:bg-red-700 transition-colors"
                  >
                    Continue saving anyway
                  </button>
                ) : (
                  <>
                    <button
                      onClick={handleSaveWithoutAck}
                      className="px-4 py-1.5 rounded-md text-xs font-medium bg-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] hover:bg-[var(--color-bg-primary)] transition-colors"
                    >
                      Save without acknowledging
                    </button>
                    <button
                      onClick={() => void handleAckAndSave()}
                      disabled={!ackAllChecked || ackBusy}
                      className="px-4 py-1.5 rounded-md text-xs font-medium bg-green-600 text-white hover:bg-green-700 transition-colors disabled:opacity-50"
                    >
                      {ackBusy ? 'Acknowledging...' : 'Acknowledge & Save'}
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
