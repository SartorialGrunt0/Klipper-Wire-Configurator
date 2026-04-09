import { useState, useCallback } from 'react';
import { useConfigStore } from '../../stores/configStore';
import * as api from '../../services/api';

interface ExportDialogProps {
  onClose: () => void;
}

export default function ExportDialog({ onClose }: ExportDialogProps) {
  const { configFiles, validation } = useConfigStore();
  const filenames = Object.keys(configFiles);
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set(filenames));
  const [status, setStatus] = useState<'idle' | 'loading' | 'error'>('idle');
  const [message, setMessage] = useState('');

  const toggleFile = (fn: string) => {
    setSelectedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(fn)) next.delete(fn);
      else next.add(fn);
      return next;
    });
  };

  const handleExport = useCallback(async () => {
    setStatus('loading');
    try {
      for (const filename of selectedFiles) {
        const cf = configFiles[filename];
        if (!cf) continue;

        const text = await api.exportConfig({
          filename: cf.filename,
          sections: cf.sections.map((s) => ({
            full_header: s.full_header,
            section_type: s.section_type,
            section_name: s.section_name,
            params: s.params.map((p) => ({
              key: p.key,
              value: p.value,
              is_commented_out: p.is_commented_out,
            })),
          })),
          includes: cf.includes,
          header_comments: cf.header_comments,
        });

        // Download the file
        const blob = new Blob([text], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
      }
      setStatus('idle');
      onClose();
    } catch (err) {
      setStatus('error');
      setMessage(err instanceof Error ? err.message : 'Export failed');
    }
  }, [selectedFiles, configFiles, onClose]);

  const hasErrors = Object.entries(validation).some(
    ([fn, v]) => selectedFiles.has(fn) && v.has_errors,
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="bg-[var(--color-bg-secondary)] rounded-xl border border-[var(--color-bg-tertiary)] shadow-2xl w-[420px] overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-4 border-b border-[var(--color-bg-tertiary)]">
          <h2 className="text-sm font-semibold">Export Configuration</h2>
          <button onClick={onClose} className="text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]">
            ✕
          </button>
        </div>

        <div className="p-4">
          {filenames.length === 0 ? (
            <p className="text-sm text-[var(--color-text-secondary)]">No configuration files to export.</p>
          ) : (
            <>
              <p className="text-xs text-[var(--color-text-secondary)] mb-3">
                Select files to export:
              </p>
              <div className="space-y-2">
                {filenames.map((fn) => {
                  const v = validation[fn];
                  return (
                    <label
                      key={fn}
                      className="flex items-center gap-3 p-2 rounded-lg hover:bg-[var(--color-bg-primary)] cursor-pointer"
                    >
                      <input
                        type="checkbox"
                        checked={selectedFiles.has(fn)}
                        onChange={() => toggleFile(fn)}
                        className="rounded"
                      />
                      <span className="text-sm text-[var(--color-text-primary)]">{fn}</span>
                      {v?.has_errors && (
                        <span className="text-[10px] text-[var(--color-error)] ml-auto">
                          {v.errors.filter((e) => e.severity === 'error').length} errors
                        </span>
                      )}
                      {v && !v.has_errors && v.has_warnings && (
                        <span className="text-[10px] text-[var(--color-warning)] ml-auto">
                          {v.errors.filter((e) => e.severity === 'warning').length} warnings
                        </span>
                      )}
                    </label>
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

          {status === 'error' && (
            <div className="mt-3 p-2 rounded-lg bg-[var(--color-error)]/10 text-xs text-[var(--color-error)]">
              {message}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 p-4 border-t border-[var(--color-bg-tertiary)]">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg text-xs font-medium bg-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] hover:bg-[var(--color-bg-primary)]"
          >
            Cancel
          </button>
          <button
            onClick={handleExport}
            disabled={selectedFiles.size === 0 || status === 'loading'}
            className="px-4 py-2 rounded-lg text-xs font-medium bg-[var(--color-accent)] text-[var(--color-bg-primary)] hover:bg-[var(--color-accent-hover)] disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {status === 'loading' ? 'Exporting...' : `Export ${selectedFiles.size} file(s)`}
          </button>
        </div>
      </div>
    </div>
  );
}
