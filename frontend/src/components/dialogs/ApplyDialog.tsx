import { useState, useEffect, useRef, useCallback } from 'react';
import { createTwoFilesPatch } from 'diff';
import { useConfigStore } from '../../stores/configStore';
import { useNativeStore } from '../../stores/nativeStore';
import * as api from '../../services/api';
import type { ConfigFile } from '../../types/config';

interface ApplyDialogProps {
  onClose: () => void;
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

export default function ApplyDialog({ onClose }: ApplyDialogProps) {
  const storeSnapshot = useRef(useConfigStore.getState());
  const { configFiles, originalTexts } = storeSnapshot.current;
  const { configPath } = useNativeStore();
  const filenames = Object.keys(configFiles);

  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set(filenames));
  const [status, setStatus] = useState<'idle' | 'exporting' | 'applying' | 'success' | 'error'>('idle');
  const [message, setMessage] = useState('');
  const [appliedFiles, setAppliedFiles] = useState<string[]>([]);
  const [restartStatus, setRestartStatus] = useState<'idle' | 'restarting' | 'success' | 'error'>('idle');
  const [restartMessage, setRestartMessage] = useState('');
  const [restartErrors, setRestartErrors] = useState<string[]>([]);
  const [restartLogPath, setRestartLogPath] = useState<string | null>(null);

  // Diff state
  const [currentTexts, setCurrentTexts] = useState<Record<string, string>>({});
  const [diffLoading, setDiffLoading] = useState(true);

  const hasAnyOriginals = filenames.some((fn) => fn in originalTexts);

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

      setStatus('applying');
      setMessage(`Writing ${Object.keys(exportedFiles).length} files to ${configPath}...`);

      const result = await api.applyNativeConfig(exportedFiles, configPath);
      setAppliedFiles(result.files);
      setStatus('success');
      setMessage(`Successfully saved ${result.files.length} file${result.files.length !== 1 ? 's' : ''} to ${result.config_path}`);

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
  }, [selectedFiles, configFiles, configPath, currentTexts]);

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

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="bg-[var(--color-bg-secondary)] rounded-xl shadow-2xl flex flex-col border border-[var(--color-bg-tertiary)] overflow-hidden"
        style={{ width: hasAnyOriginals ? 900 : 480, maxHeight: '85vh' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-[var(--color-bg-tertiary)]">
          <div>
            <h2 className="text-base font-semibold text-[var(--color-text-primary)]">Save to Pi</h2>
            <p className="text-xs text-[var(--color-text-secondary)] mt-0.5">
              Write config files to <span className="font-mono">{configPath}</span>
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
            This will overwrite existing config files on the Pi. Make sure you have a backup.
          </p>
        </div>

        {/* Body */}
        <div className="flex flex-1 overflow-hidden">
          {/* Left: file list */}
          <div className={`flex flex-col ${hasAnyOriginals ? 'w-52 shrink-0 border-r border-[var(--color-bg-tertiary)]' : 'flex-1'}`}>
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
                    className={`flex items-center gap-2 px-2 py-1.5 rounded-md cursor-pointer ${
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
                    <span className="text-xs font-mono text-[var(--color-text-primary)] flex-1">{fn}</span>
                    {appliedFiles.includes(fn) && (
                      <span className="text-xs text-green-400">Saved</span>
                    )}
                  </label>
                ))}
              </div>
            </div>
          </div>

          {/* Right: diff panel (only when originals exist) */}
          {hasAnyOriginals && (
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
              className="px-4 py-1.5 rounded-md text-xs font-medium bg-red-500 text-white hover:bg-red-600 transition-colors disabled:opacity-50"
            >
              {status === 'exporting' ? 'Exporting...' : status === 'applying' ? 'Writing...' : 'Save Changes'}
            </button>
          )}
          {status === 'success' && (
            <button
              onClick={handleFirmwareRestart}
              disabled={restartStatus === 'restarting' || restartStatus === 'success'}
              className="px-4 py-1.5 rounded-md text-xs font-medium bg-amber-500 text-black hover:bg-amber-600 transition-colors disabled:opacity-50"
            >
              {restartStatus === 'restarting'
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
