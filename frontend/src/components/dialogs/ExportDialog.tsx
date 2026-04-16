import { useState, useEffect, useRef, useCallback } from 'react';
import { createTwoFilesPatch } from 'diff';
import { useConfigStore } from '../../stores/configStore';
import * as api from '../../services/api';
import type { ConfigFile } from '../../types/config';

interface ExportDialogProps {
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

export default function ExportDialog({ onClose }: ExportDialogProps) {
  // Snapshot store state once on mount to avoid re-triggering on Zustand updates.
  const storeSnapshot = useRef(useConfigStore.getState());
  const { configFiles, validation, originalTexts } = storeSnapshot.current;
  const filenames = Object.keys(configFiles);

  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set(filenames));
  const [exportStatus, setExportStatus] = useState<'idle' | 'loading' | 'error'>('idle');
  const [exportMessage, setExportMessage] = useState('');

  // Current exported texts (for diffing)
  const [currentTexts, setCurrentTexts] = useState<Record<string, string>>({});
  const [diffLoading, setDiffLoading] = useState(true);

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

  const handleExport = useCallback(async () => {
    setExportStatus('loading');
    try {
      for (const filename of selectedFiles) {
        const cf = configFiles[filename];
        if (!cf) continue;
        const text = currentTexts[filename] ?? await exportConfigText(cf);
        const blob = new Blob([text], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
      }
      setExportStatus('idle');
      onClose();
    } catch (err) {
      setExportStatus('error');
      setExportMessage(err instanceof Error ? err.message : 'Export failed');
    }
  }, [selectedFiles, configFiles, currentTexts, onClose]);

  const hasErrors = Object.entries(validation).some(
    ([fn, v]) => selectedFiles.has(fn) && v.has_errors,
  );

  const hasAnyOriginals = filenames.some((fn) => fn in originalTexts);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="bg-[var(--color-bg-secondary)] rounded-xl border border-[var(--color-bg-tertiary)] shadow-2xl flex flex-col overflow-hidden"
        style={{ width: hasAnyOriginals ? 900 : 420, maxHeight: '85vh' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-[var(--color-bg-tertiary)]">
          <h2 className="text-sm font-semibold">Export Configuration</h2>
          <button onClick={onClose} className="text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]">
            ✕
          </button>
        </div>

        {/* Body */}
        <div className="flex flex-1 overflow-hidden">
          {/* Left: file selection */}
          <div className={`flex flex-col ${hasAnyOriginals ? 'w-52 shrink-0 border-r border-[var(--color-bg-tertiary)]' : 'flex-1'}`}>
            <div className="flex-1 overflow-y-auto p-4">
              {filenames.length === 0 ? (
                <p className="text-xs text-[var(--color-text-secondary)]">No configuration files to export.</p>
              ) : (
                <>
                  <p className="text-xs text-[var(--color-text-secondary)] mb-3">Select files to export:</p>
                  <div className="space-y-1">
                    {filenames.map((fn) => {
                      const v = validation[fn];
                      const errors = v?.errors.filter((e) => e.severity === 'error') ?? [];
                      const warnings = v?.errors.filter((e) => e.severity === 'warning') ?? [];
                      const hasIssues = errors.length > 0 || warnings.length > 0;
                      return (
                        <div key={fn} className="rounded-lg overflow-hidden">
                          <label className="flex items-center gap-2 p-2 hover:bg-[var(--color-bg-primary)] cursor-pointer">
                            <input
                              type="checkbox"
                              checked={selectedFiles.has(fn)}
                              onChange={() => toggleFile(fn)}
                              className="rounded shrink-0"
                            />
                            <span className="text-xs text-[var(--color-text-primary)] break-all">{fn}</span>
                            {errors.length > 0 && (
                              <span className="text-[10px] text-[var(--color-error)] ml-auto shrink-0">
                                {errors.length} err
                              </span>
                            )}
                            {errors.length === 0 && warnings.length > 0 && (
                              <span className="text-[10px] text-[var(--color-warning)] ml-auto shrink-0">
                                {warnings.length} warn
                              </span>
                            )}
                          </label>
                          {hasIssues && (
                            <div className="ml-6 mb-2 space-y-0.5">
                              {errors.map((e, i) => (
                                <div key={i} className="flex gap-1.5 text-[10px] text-[var(--color-error)] leading-tight">
                                  <span className="shrink-0 opacity-60">✕</span>
                                  <span>
                                    {e.section && <span className="opacity-70">[{e.section}]{e.param ? ` ${e.param}: ` : ' '}</span>}
                                    {e.message}
                                  </span>
                                </div>
                              ))}
                              {warnings.map((w, i) => (
                                <div key={i} className="flex gap-1.5 text-[10px] text-[var(--color-warning)] leading-tight">
                                  <span className="shrink-0 opacity-60">⚠</span>
                                  <span>
                                    {w.section && <span className="opacity-70">[{w.section}]{w.param ? ` ${w.param}: ` : ' '}</span>}
                                    {w.message}
                                  </span>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>

                  {hasErrors && (
                    <div className="mt-3 p-2 rounded-lg bg-[var(--color-error)]/10 text-xs text-[var(--color-error)]">
                      ⚠ Some files have validation errors. They will still be exported.
                    </div>
                  )}
                </>
              )}
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
                      const patch = createTwoFilesPatch(fn, fn, original, current, 'imported', 'current', { context: 3 });
                      diffLines = parsePatch(patch);
                      hasChanges = diffLines.some((l) => l.type === 'added' || l.type === 'removed');
                    }

                    return (
                      <div key={fn}>
                        {/* File header */}
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

        {/* Footer */}
        {exportStatus === 'error' && (
          <div className="mx-4 mb-0 mt-0 p-2 rounded-lg bg-[var(--color-error)]/10 text-xs text-[var(--color-error)]">
            {exportMessage}
          </div>
        )}
        <div className="flex justify-end gap-2 p-4 border-t border-[var(--color-bg-tertiary)]">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg text-xs font-medium bg-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] hover:bg-[var(--color-bg-primary)]"
          >
            Cancel
          </button>
          <button
            onClick={handleExport}
            disabled={selectedFiles.size === 0 || exportStatus === 'loading'}
            className="px-4 py-2 rounded-lg text-xs font-medium bg-[var(--color-accent)] text-[var(--color-bg-primary)] hover:bg-[var(--color-accent-hover)] disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {exportStatus === 'loading' ? 'Exporting...' : `Export ${selectedFiles.size} file(s)`}
          </button>
        </div>
      </div>
    </div>
  );
}
