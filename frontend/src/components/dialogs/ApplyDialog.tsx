import { useState, useEffect, useRef, useCallback } from 'react';
import { createTwoFilesPatch } from 'diff';
import { useConfigStore } from '../../stores/configStore';
import { useNativeStore } from '../../stores/nativeStore';
import { getSaveButtonClass } from '../../utils/saveButtonClass';
import * as api from '../../services/api';
import type { ConfigFile } from '../../types/config';
import type { NativeStatus } from '../../services/api';

interface ApplyDialogProps {
  onClose: () => void;
  canAnalyzeWithAi?: boolean;
  onAnalyzeWithAi?: (prompt: string) => void;
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

export default function ApplyDialog({ onClose, canAnalyzeWithAi = false, onAnalyzeWithAi }: ApplyDialogProps) {
  const storeSnapshot = useRef(useConfigStore.getState());
  const { configFiles, originalTexts } = storeSnapshot.current;
  const { configPath } = useNativeStore();
  // Live state for the Save-button color — matches the toolbar button so the
  // dialog's actions always agree with it (grey/green/yellow/red).
  const isDirty = useConfigStore((s) => s.isDirty);
  const validation = useConfigStore((s) => s.validation);
  const saveButtonClass = getSaveButtonClass(isDirty, validation);
  const filenames = Object.keys(configFiles);

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

      if (isLocalMode) {
        // Non-native mode: save to local config storage
        setStatus('applying');
        setMessage(`Saving ${Object.keys(exportedFiles).length} files locally...`);
        const result = await api.saveConfigsToLocal(exportedFiles);
        setAppliedFiles(result.saved);
        setStatus('success');
        setMessage(`Successfully saved ${result.saved.length} file${result.saved.length !== 1 ? 's' : ''} locally`);
      } else {
        // Native mode: save to Pi config path
        setStatus('applying');
        setMessage(`Writing ${Object.keys(exportedFiles).length} files to ${configPath}...`);
        const result = await api.applyNativeConfig(exportedFiles, configPath);
        setAppliedFiles(result.files);
        setStatus('success');
        setMessage(`Successfully saved ${result.files.length} file${result.files.length !== 1 ? 's' : ''} to ${result.config_path}`);
      }

      // Update originalTexts to match what was saved, so diff resets
      const configStore = useConfigStore.getState();
      for (const [fn, text] of Object.entries(exportedFiles)) {
        configStore.setOriginalText(fn, text);
      }
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
                {filenames.map((fn) => (
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
                    {appliedFiles.includes(fn) && (
                      <span className="w-11 shrink-0 text-right text-xs text-green-400">Saved</span>
                    )}
                  </label>
                ))}
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

                    let diffLines: DiffLine[] = [];
                    let hasChanges = false;
                    if (hasOriginal && current !== undefined) {
                      const patch = createTwoFilesPatch(fn, fn, original, current, 'saved', 'current', { context: 3 });
                      diffLines = parsePatch(patch);
                      hasChanges = diffLines.some((l) => l.type === 'added' || l.type === 'removed');
                    }

                    return (
                      <div key={fn}>
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-xs font-semibold text-[var(--color-text-primary)]">{fn}</span>
                          {!hasOriginal && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-[var(--color-warning)]/20 text-[var(--color-warning)]">new file</span>
                          )}
                          {hasOriginal && !hasChanges && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)]">unchanged</span>
                          )}
                          {hasOriginal && hasChanges && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-[var(--color-accent)]/20 text-[var(--color-accent)]">
                              {diffLines.filter((l) => l.type === 'added' || l.type === 'removed').length} lines changed
                            </span>
                          )}
                        </div>

                        {hasOriginal && hasChanges && (
                          <div className="rounded-lg border border-[var(--color-bg-tertiary)] overflow-hidden">
                            <pre className="text-xs leading-5 font-mono overflow-x-auto">
                              {diffLines.map((line, i) => (
                                <div
                                  key={i}
                                  className={
                                    line.type === 'added'
                                      ? 'bg-green-500/15 text-green-400 px-3'
                                      : line.type === 'removed'
                                        ? 'bg-red-500/15 text-red-400 px-3'
                                        : line.type === 'header'
                                          ? 'bg-blue-500/10 text-blue-400 px-3 py-0.5'
                                          : 'text-[var(--color-text-secondary)] px-3'
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
              onClick={handleApply}
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
    </div>
  );
}
