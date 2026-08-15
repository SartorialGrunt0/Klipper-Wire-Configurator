import { useState, useEffect, useRef } from 'react';
import { useConfigStore } from '../../stores/configStore';
import * as api from '../../services/api';
import type { ConfigFile } from '../../types/config';
import { countChangedLines, createConfigPatch, parsePatch } from '../../utils/configDiff';

interface DiffDialogProps {
  onClose: () => void;
}

async function exportConfigText(cf: ConfigFile): Promise<string> {
  return api.exportConfig(cf);
}

export default function DiffDialog({ onClose }: DiffDialogProps) {
  // Snapshot store state once on mount — avoids re-running export on every Zustand update.
  const storeSnapshot = useRef(useConfigStore.getState());
  const { configFiles, originalTexts } = storeSnapshot.current;
  // A file deleted since import is gone from configFiles but its original text
  // survives in originalTexts — include it so deletions show up in the diff.
  const filenames = Array.from(new Set([...Object.keys(configFiles), ...Object.keys(originalTexts)]));

  const [activeFile, setActiveFile] = useState(filenames[0] || '');
  const [currentTexts, setCurrentTexts] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Export all snapshotted configs exactly once on mount.
  useEffect(() => {
    let cancelled = false;
    async function exportAll() {
      const texts: Record<string, string> = {};
      try {
        for (const filename of filenames) {
          const cf = configFiles[filename];
          if (!cf) continue;
          texts[filename] = await exportConfigText(cf);
          if (cancelled) return;
        }
        setCurrentTexts(texts);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to export configs');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    exportAll();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // intentionally empty — snapshot is captured via ref

  const original = originalTexts[activeFile] || '';
  const current = currentTexts[activeFile] || '';
  const hasOriginal = activeFile in originalTexts;

  const patch = hasOriginal && !loading
    ? createConfigPatch(activeFile, original, current, 'imported', 'current', 3)
    : '';
  const diffLines = parsePatch(patch);
  const hasChanges = diffLines.some((l) => l.type === 'added' || l.type === 'removed');

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="bg-[var(--color-bg-secondary)] rounded-xl border border-[var(--color-bg-tertiary)] shadow-2xl w-[900px] max-h-[80vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-[var(--color-bg-tertiary)]">
          <h2 className="text-sm font-semibold">Changes Since Import</h2>
          <button onClick={onClose} className="text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]">
            ✕
          </button>
        </div>

        {/* Body: sidebar + diff panel */}
        <div className="flex flex-1 overflow-hidden">
          {/* File list sidebar */}
          <div className="w-48 shrink-0 border-r border-[var(--color-bg-tertiary)] overflow-y-auto py-2">
            {filenames.map((fn) => {
              const hasCurrent = fn in currentTexts;
              const hasOrig = fn in originalTexts;
              const isDeleted = hasOrig && !hasCurrent;
              let badge: 'changed' | 'unchanged' | 'new' | 'deleted' | 'loading' = 'loading';
              let changeCount = 0;
              if (!loading) {
                if (isDeleted) {
                  badge = 'deleted';
                  const p = createConfigPatch(fn, originalTexts[fn] || '', '', '', '', 0);
                  changeCount = countChangedLines(p);
                } else if (hasCurrent) {
                  if (!hasOrig) {
                    badge = 'new';
                  } else {
                    const p = createConfigPatch(fn, originalTexts[fn] || '', currentTexts[fn] || '', '', '', 0);
                    changeCount = countChangedLines(p);
                    badge = changeCount > 0 ? 'changed' : 'unchanged';
                  }
                }
              }
              return (
                <button
                  key={fn}
                  onClick={() => setActiveFile(fn)}
                  className={`w-full flex items-start gap-2 px-3 py-2 text-left transition-colors ${
                    activeFile === fn
                      ? 'bg-[var(--color-bg-primary)] text-[var(--color-text-primary)]'
                      : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-primary)]/50 hover:text-[var(--color-text-primary)]'
                  }`}
                >
                  <span className="text-xs font-medium break-all leading-tight">{fn}</span>
                  <span className="ml-auto shrink-0 mt-0.5">
                    {badge === 'loading' && (
                      <span className="block w-2 h-2 rounded-full bg-[var(--color-bg-tertiary)]" />
                    )}
                    {badge === 'changed' && (
                      <span className="text-[10px] font-semibold text-[var(--color-accent)]">
                        {changeCount}
                      </span>
                    )}
                    {badge === 'deleted' && (
                      <span className="text-[10px] font-semibold text-[var(--color-error)]">
                        deleted
                      </span>
                    )}
                    {badge === 'unchanged' && (
                      <span className="block w-1.5 h-1.5 rounded-full bg-[var(--color-text-secondary)]/30" />
                    )}
                    {badge === 'new' && (
                      <span className="text-[10px] font-semibold text-[var(--color-warning)]">new</span>
                    )}
                  </span>
                </button>
              );
            })}
          </div>

          {/* Diff content */}
          <div className="flex-1 overflow-auto p-4">
            {loading ? (
              <p className="text-xs text-[var(--color-text-secondary)] text-center py-8">
                Generating diff...
              </p>
            ) : error ? (
              <div className="p-3 rounded-lg bg-[var(--color-error)]/10 text-xs text-[var(--color-error)]">
                {error}
              </div>
            ) : !hasOriginal ? (
              <p className="text-xs text-[var(--color-text-secondary)] text-center py-8">
                No original version available — this file was added after import.
              </p>
            ) : !hasChanges ? (
              <p className="text-xs text-[var(--color-text-secondary)] text-center py-8">
                No changes — identical to the imported version.
              </p>
            ) : (
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
                              ? 'bg-blue-500/10 text-blue-400 px-3 py-1'
                              : 'text-[var(--color-text-secondary)] px-3'
                      }
                    >
                      <span className="select-none opacity-50 mr-2">
                        {line.type === 'added' ? '+' : line.type === 'removed' ? '-' : line.type === 'header' ? '' : ' '}
                      </span>
                      {line.content || '\u00A0'}
                    </div>
                  ))}
                </pre>
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex justify-end p-4 border-t border-[var(--color-bg-tertiary)]">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg text-xs font-medium bg-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] hover:bg-[var(--color-bg-primary)]"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
