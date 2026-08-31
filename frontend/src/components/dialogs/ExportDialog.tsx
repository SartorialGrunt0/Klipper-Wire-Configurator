import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { createTwoFilesPatch } from 'diff';
import JSZip from 'jszip';
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

const FileListItem = ({
  fn,
  s,
  findingCount,
  exportedOnce,
  selectedFiles,
  toggleFile,
  exportStatus,
}: {
  fn: string;
  s: { hasOriginal: boolean; hasChanges: boolean };
  findingCount: number;
  exportedOnce: boolean;
  selectedFiles: Set<string>;
  toggleFile: (fn: string) => void;
  exportStatus: string;
}) => (
  <label
    className={`group flex items-center gap-2 px-2 py-1.5 rounded-md cursor-pointer ${
      exportedOnce && selectedFiles.has(fn) ? 'bg-green-500/10' : 'hover:bg-[var(--color-bg-primary)]'
    }`}
  >
    <input
      type="checkbox"
      checked={selectedFiles.has(fn)}
      onChange={() => toggleFile(fn)}
      disabled={exportStatus === 'loading'}
      className="rounded"
    />
    <div className="kwc-marquee-shell flex-1 min-w-0">
      <div className="kwc-marquee-track">
        <span className="kwc-marquee-text text-xs font-mono text-[var(--color-text-primary)]">{fn}</span>
        <span aria-hidden="true" className="kwc-marquee-text text-xs font-mono text-[var(--color-text-primary)]">{fn}</span>
      </div>
    </div>
    {!s.hasOriginal && (
      <span className="shrink-0 text-[10px] font-semibold text-[var(--color-warning)]">new</span>
    )}
    {findingCount > 0 && (
      <span className="shrink-0 text-[10px] font-semibold text-[var(--color-text-secondary)]" title={`${findingCount} validation finding${findingCount !== 1 ? 's' : ''}`}>
        {findingCount}
      </span>
    )}
  </label>
);

const ReviewItem = ({
  fn,
  s,
  diffLines,
  changedCount,
}: {
  fn: string;
  s: { hasOriginal: boolean; hasChanges: boolean };
  diffLines: DiffLine[];
  changedCount: number;
}) => (
  <div>
    <div className="flex items-center gap-2 mb-1">
      <span className="text-xs font-semibold text-[var(--color-text-primary)]">{fn}</span>
      {!s.hasOriginal && (
        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-[var(--color-warning)]/20 text-[var(--color-warning)]">new file</span>
      )}
      {s.hasOriginal && !s.hasChanges && (
        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)]">unchanged</span>
      )}
      {s.hasOriginal && s.hasChanges && (
        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-[var(--color-accent)]/20 text-[var(--color-accent)]">
          {changedCount} lines changed
        </span>
      )}
    </div>
    {s.hasChanges && (
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

export default function ExportDialog({ onClose }: ExportDialogProps) {
  const storeSnapshot = useRef(useConfigStore.getState());
  const { configFiles, validation, originalTexts } = storeSnapshot.current;

  const filenames = useMemo(
    () => Object.keys(configFiles),
    [configFiles],
  );

  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set(filenames));
  const [exportStatus, setExportStatus] = useState<'idle' | 'loading' | 'error'>('idle');
  const [exportMessage, setExportMessage] = useState('');
  const [exportFormat, setExportFormat] = useState<'files' | 'zip'>('zip');
  const [exportedOnce, setExportedOnce] = useState(false);

  const [currentTexts, setCurrentTexts] = useState<Record<string, string>>({});
  const [diffLoading, setDiffLoading] = useState(true);

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
  }, []);

  const fileStatus = useMemo(() => {
    const map: Record<string, { hasOriginal: boolean; hasChanges: boolean }> = {};
    for (const fn of filenames) {
      const hasOriginal = fn in originalTexts;
      const current = currentTexts[fn];
      let hasChanges = false;
      if (current !== undefined) {
        const patch = createTwoFilesPatch(fn, fn, originalTexts[fn] ?? '', current, 'saved', 'current', { context: 3 });
        hasChanges = parsePatch(patch).some((l) => l.type === 'added' || l.type === 'removed');
      }
      map[fn] = { hasOriginal, hasChanges };
    }
    return map;
  }, [filenames, originalTexts, currentTexts]);

  const showReviewPanel = diffLoading || filenames.length > 0;
  const reviewFiles = useMemo(
    () => filenames.filter((fn) => selectedFiles.has(fn)),
    [filenames, selectedFiles],
  );

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
      const exportedFiles: Array<{ filename: string; text: string }> = [];
      for (const filename of selectedFiles) {
        const cf = configFiles[filename];
        if (!cf) continue;
        const text = currentTexts[filename] ?? await exportConfigText(cf);
        exportedFiles.push({ filename, text });
      }
      if (exportFormat === 'zip') {
        const zip = new JSZip();
        for (const file of exportedFiles) {
          zip.file(file.filename, file.text);
        }
        const zipBlob = await zip.generateAsync({ type: 'blob' });
        const zipUrl = URL.createObjectURL(zipBlob);
        const a = document.createElement('a');
        a.href = zipUrl;
        a.download = 'klipper-config-export.zip';
        a.click();
        URL.revokeObjectURL(zipUrl);
      } else {
        for (const file of exportedFiles) {
          const blob = new Blob([file.text], { type: 'text/plain' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = file.filename;
          a.click();
          URL.revokeObjectURL(url);
        }
      }
      setExportedOnce(true);
      setExportStatus('idle');
      onClose();
    } catch (err) {
      setExportStatus('error');
      setExportMessage(err instanceof Error ? err.message : 'Export failed');
    }
  }, [selectedFiles, configFiles, currentTexts, exportFormat, onClose]);

  const hasErrors = Object.entries(validation).some(
    ([fn, v]) => selectedFiles.has(fn) && v.has_errors,
  );
  const exportableCount = filenames.filter((fn) => fn in configFiles).length;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="bg-[var(--color-bg-secondary)] rounded-xl shadow-2xl flex flex-col border border-[var(--color-bg-tertiary)] overflow-hidden"
        style={{ width: showReviewPanel ? 900 : 480, maxHeight: '85vh' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-4 border-b border-[var(--color-bg-tertiary)]">
          <div>
            <h2 className="text-base font-semibold text-[var(--color-text-primary)]">Export Configuration</h2>
            <p className="text-xs text-[var(--color-text-secondary)] mt-0.5">
              Download config files to your computer
            </p>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)]">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>
        <div className="flex flex-1 overflow-hidden">
          <div className={`flex flex-col ${showReviewPanel ? 'w-52 shrink-0 border-r border-[var(--color-bg-tertiary)]' : 'flex-1'}`}>
            <div className="flex-1 overflow-y-auto p-4">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs text-[var(--color-text-secondary)]">
                  {selectedFiles.size} of {filenames.length} files selected
                </span>
              </div>
              {filenames.length === 0 ? (
                <p className="text-xs text-[var(--color-text-secondary)]">No configuration files to export.</p>
              ) : (
                <div className="space-y-1">
                  {filenames.map((fn) => {
                    const s = fileStatus[fn];
                    const v = validation[fn];
                    const errorCount = v?.errors.filter((e) => e.severity === 'error').length ?? 0;
                    const warningCount = v?.errors.filter((e) => e.severity === 'warning').length ?? 0;
                    const findingCount = errorCount + warningCount;
                    return (
                      <FileListItem
                        key={fn}
                        fn={fn}
                        s={s}
                        findingCount={findingCount}
                        exportedOnce={exportedOnce}
                        selectedFiles={selectedFiles}
                        toggleFile={toggleFile}
                        exportStatus={exportStatus}
                      />
                    );
                  })}
                </div>
              )}
              {hasErrors && (
                <div className="mt-3 p-2 rounded-lg bg-[var(--color-error)]/10 text-xs text-[var(--color-error)]">
                  ⚠ Some files have validation errors. They will still be exported.
                </div>
              )}
            </div>
          </div>
          {showReviewPanel && (
            <div className="flex-1 overflow-auto p-4 space-y-4">
              {diffLoading ? (
                <p className="text-xs text-[var(--color-text-secondary)] text-center py-8">Generating diff...</p>
              ) : reviewFiles.length === 0 ? (
                <p className="text-xs text-[var(--color-text-secondary)] text-center py-8">
                  All files are deselected — tick them in the file list to review.
                </p>
              ) : (
                reviewFiles.map((fn) => {
                  const s = fileStatus[fn];
                  const current = currentTexts[fn];
                  let diffLines: DiffLine[] = [];
                  if (current !== undefined) {
                    const patch = createTwoFilesPatch(fn, fn, originalTexts[fn] ?? '', current, 'saved', 'current', { context: 3 });
                    diffLines = parsePatch(patch);
                  }
                  const changedCount = diffLines.filter((l) => l.type === 'added' || l.type === 'removed').length;

                  return (
                    <ReviewItem
                      key={fn}
                      fn={fn}
                      s={s}
                      diffLines={diffLines}
                      changedCount={changedCount}
                    />
                  );
                })
              )}
            </div>
          )}
        </div>
        {exportStatus === 'error' && (
          <div className="px-4 py-2 text-xs text-red-400">
            {exportMessage}
          </div>
        )}
        <div className="p-4 border-t border-[var(--color-bg-tertiary)] flex justify-end gap-2">
          <div className="mr-auto flex items-center gap-2">
            <label htmlFor="export-format" className="text-xs text-[var(--color-text-secondary)]">
              Format:
            </label>
            <select
              id="export-format"
              value={exportFormat}
              onChange={(e) => setExportFormat(e.target.value as 'files' | 'zip')}
              className="px-2 py-1 rounded-md text-xs bg-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] border border-[var(--color-bg-primary)]"
            >
              <option value="files">Individual files (.cfg)</option>
              <option value="zip">ZIP archive (.zip)</option>
            </select>
          </div>
          <button
            onClick={onClose}
            className="px-4 py-1.5 rounded-md text-xs font-medium bg-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] hover:bg-[var(--color-bg-primary)] transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleExport}
            disabled={exportableCount === 0 || selectedFiles.size === 0 || exportStatus === 'loading'}
            className="px-4 py-1.5 rounded-md text-xs font-medium bg-[var(--color-accent)] text-[var(--color-bg-primary)] hover:bg-[var(--color-accent-hover)] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {exportStatus === 'loading'
              ? 'Exporting...'
              : exportFormat === 'zip'
                ? `Export ZIP (${selectedFiles.size} file${selectedFiles.size !== 1 ? 's' : ''})`
                : `Export ${selectedFiles.size} file${selectedFiles.size !== 1 ? 's' : ''}`}
          </button>
        </div>
      </div>
    </div>
  );
}
