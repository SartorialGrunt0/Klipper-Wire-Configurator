import { useMemo, useEffect } from 'react';
import type { AssistantDraftChange } from '../../utils/assistantDraftMerge';
import { createConfigPatch, parsePatch } from '../../utils/configDiff';

interface AiDraftPreviewFile {
  filename: string;
  originalText: string;
  mergedText: string;
}

interface AiDraftPreviewDialogProps {
  filePreviews: AiDraftPreviewFile[];
  changes: AssistantDraftChange[];
  selectedChangeIds: string[];
  previewUpdating: boolean;
  /** Macro section headers whose trailing Jinja closers were auto-appended. */
  repairedSections?: string[];
  onSelectionChange: (selectedChangeIds: string[]) => void;
  onAccept: () => void;
  onClose: () => void;
}

export default function AiDraftPreviewDialog({
  filePreviews,
  changes,
  selectedChangeIds,
  previewUpdating,
  repairedSections = [],
  onSelectionChange,
  onAccept,
  onClose,
}: AiDraftPreviewDialogProps) {
  // ── Debug logging ────────────────────────────────────────────────
  useEffect(() => {
    console.group('[AIDraft] Preview dialog opened / updated');
    console.debug('File previews:', filePreviews.map(f => ({
      filename: f.filename,
      originalLength: f.originalText.length,
      mergedLength: f.mergedText.length,
      sizeDiff: f.mergedText.length - f.originalText.length,
    })));
    console.debug('Changes from assistant:', changes.map(c => ({
      id: c.id,
      mode: c.mode,
      filename: c.filename,
      fullHeader: c.fullHeader,
    })));
    console.debug('Selected change IDs:', selectedChangeIds);
    console.debug('Preview updating:', previewUpdating);
    console.groupEnd();
  }, [filePreviews, changes, selectedChangeIds, previewUpdating]);

  const selectedIdSet = useMemo(() => new Set(selectedChangeIds), [selectedChangeIds]);
  const selectedCount = selectedChangeIds.length;
  const fileDiffs = useMemo(
    () => filePreviews.map((filePreview) => {
      const patch = createConfigPatch(
        filePreview.filename,
        filePreview.originalText,
        filePreview.mergedText,
        'current draft',
        'assistant merge',
        3,
      );
      const diffLines = parsePatch(patch);

      return {
        ...filePreview,
        diffLines,
        changedLineCount: diffLines.filter(
          (line) => line.type === 'added' || line.type === 'removed',
        ).length,
        isNewFile: !filePreview.originalText.trim(),
      };
    }),
    [filePreviews],
  );
  const changedLineCount = useMemo(
    () => fileDiffs.reduce((total, fileDiff) => total + fileDiff.changedLineCount, 0),
    [fileDiffs],
  );
  const hasChanges = fileDiffs.some((fileDiff) => fileDiff.changedLineCount > 0);
  const fileSummary = filePreviews.length === 1
    ? filePreviews[0]?.filename ?? 'the selected config file'
    : `${filePreviews.length} files`;

  const toggleChange = (changeId: string) => {
    if (selectedIdSet.has(changeId)) {
      onSelectionChange(selectedChangeIds.filter((id) => id !== changeId));
      return;
    }

    onSelectionChange([...selectedChangeIds, changeId]);
  };

  const selectAll = () => {
    onSelectionChange(changes.map((change) => change.id));
  };

  const clearAll = () => {
    onSelectionChange([]);
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="flex max-h-[85vh] w-[980px] flex-col overflow-hidden rounded-xl border border-[var(--color-bg-tertiary)] bg-[var(--color-bg-secondary)] shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-[var(--color-bg-tertiary)] p-4">
          <div>
            <h2 className="text-sm font-semibold text-[var(--color-text-primary)]">Review AI Draft Changes</h2>
            <p className="mt-1 text-xs text-[var(--color-text-secondary)]">
              The assistant sections will be merged into {fileSummary} before the config is applied.
            </p>
            {filePreviews.length > 1 && (
              <p className="mt-1 text-[11px] text-[var(--color-text-secondary)]">
                {filePreviews.map((filePreview) => filePreview.filename).join(', ')}
              </p>
            )}
          </div>
          <button
            onClick={onClose}
            className="rounded-md p-1 text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-primary)]"
            aria-label="Close review dialog"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        {repairedSections.length > 0 && (
          <div className="border-b border-[var(--color-bg-tertiary)] bg-[var(--color-bg-tertiary)]/40 px-4 py-2 text-[11px] text-[var(--color-text-secondary)]">
            Auto-repaired missing Jinja closers in:{' '}
            {repairedSections.map((header) => `[${header}]`).join(', ')} — the closing tags were
            appended at the end of the gcode body. Review the green additions in the diff below.
          </div>
        )}

        <div className="border-b border-[var(--color-bg-tertiary)] px-4 py-3">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <span className="text-xs font-medium text-[var(--color-text-primary)]">Sections from the assistant</span>
            <span className="rounded-full bg-[var(--color-accent)]/15 px-2 py-0.5 text-[10px] font-semibold text-[var(--color-accent)]">
              {changes.length} section{changes.length === 1 ? '' : 's'}
            </span>
            <span className="rounded-full bg-[var(--color-bg-primary)] px-2 py-0.5 text-[10px] font-semibold text-[var(--color-text-secondary)]">
              {selectedCount} selected
            </span>
            {hasChanges && (
              <span className="rounded-full bg-green-500/15 px-2 py-0.5 text-[10px] font-semibold text-green-400">
                {changedLineCount} diff line{changedLineCount === 1 ? '' : 's'}
              </span>
            )}
            {previewUpdating && (
              <span className="rounded-full bg-blue-500/10 px-2 py-0.5 text-[10px] font-semibold text-blue-400">
                Updating preview...
              </span>
            )}
            <div className="ml-auto flex items-center gap-2">
              <button
                onClick={selectAll}
                disabled={selectedCount === changes.length || previewUpdating}
                className="rounded-md border border-[var(--color-bg-tertiary)] px-2 py-1 text-[10px] font-medium text-[var(--color-text-primary)] transition-colors hover:bg-[var(--color-bg-primary)] disabled:cursor-not-allowed disabled:opacity-50"
              >
                Select All
              </button>
              <button
                onClick={clearAll}
                disabled={selectedCount === 0 || previewUpdating}
                className="rounded-md border border-[var(--color-bg-tertiary)] px-2 py-1 text-[10px] font-medium text-[var(--color-text-primary)] transition-colors hover:bg-[var(--color-bg-primary)] disabled:cursor-not-allowed disabled:opacity-50"
              >
                Clear All
              </button>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {changes.map((change) => {
              const selected = selectedIdSet.has(change.id);

              return (
              <button
                key={change.id}
                type="button"
                onClick={() => toggleChange(change.id)}
                disabled={previewUpdating}
                className={`inline-flex items-center gap-2 rounded-full border px-2 py-1 text-[10px] font-medium transition-colors disabled:cursor-not-allowed ${
                  selected
                    ? 'border-[var(--color-accent)] bg-[var(--color-accent)]/10 text-[var(--color-text-primary)]'
                    : 'border-[var(--color-bg-tertiary)] bg-[var(--color-bg-primary)] text-[var(--color-text-secondary)] opacity-75'
                }`}
                aria-pressed={selected}
              >
                <span className={`flex h-3 w-3 items-center justify-center rounded-full border ${
                  selected ? 'border-[var(--color-accent)] bg-[var(--color-accent)] text-white' : 'border-[var(--color-bg-tertiary)]'
                }`}>
                  {selected ? '✓' : ''}
                </span>
                <span
                  className={
                    change.mode === 'add' ? 'text-green-400' :
                    change.mode === 'delete' ? 'text-red-400' :
                    'text-[var(--color-accent)]'
                  }
                >
                  {change.mode === 'add' ? 'new' : change.mode === 'delete' ? 'delete' : 'update'}
                </span>
                <span className="text-[var(--color-text-secondary)]">{change.filename}</span>
                <span>{change.fullHeader}</span>
              </button>
              );
            })}
          </div>
        </div>

        <div className="flex-1 overflow-auto p-4">
          {previewUpdating ? (
            <p className="py-8 text-center text-xs text-[var(--color-text-secondary)]">
              Updating the merged preview...
            </p>
          ) : selectedCount === 0 ? (
            <p className="py-8 text-center text-xs text-[var(--color-text-secondary)]">
              No sections selected. The current draft will remain unchanged.
            </p>
          ) : !hasChanges ? (
            <p className="py-8 text-center text-xs text-[var(--color-text-secondary)]">
              The assistant output does not change the current draft.
            </p>
          ) : (
            <div className="space-y-4">
              {fileDiffs.map((fileDiff) => (
                <div
                  key={fileDiff.filename}
                  className="overflow-hidden rounded-lg border border-[var(--color-bg-tertiary)]"
                >
                  <div className="flex items-center justify-between border-b border-[var(--color-bg-tertiary)] bg-[var(--color-bg-primary)] px-3 py-2">
                    <span className="flex items-center gap-2 text-[11px] font-semibold text-[var(--color-text-primary)]">
                      {fileDiff.filename}
                      {fileDiff.isNewFile && (
                        <span className="rounded-full bg-green-500/20 px-1.5 py-0.5 text-[10px] font-medium text-green-400">
                          New file
                        </span>
                      )}
                    </span>
                    <span className="text-[10px] text-[var(--color-text-secondary)]">
                      {fileDiff.changedLineCount > 0
                        ? `${fileDiff.changedLineCount} diff line${fileDiff.changedLineCount === 1 ? '' : 's'}`
                        : 'No selected changes for this file'}
                    </span>
                  </div>
                  {fileDiff.changedLineCount === 0 ? (
                    <p className="px-3 py-4 text-xs text-[var(--color-text-secondary)]">
                      No selected changes remain for this file.
                    </p>
                  ) : (
                    <pre className="overflow-x-auto text-xs leading-5 font-mono">
                      {fileDiff.diffLines.map((line, index) => (
                        <div
                          key={`${fileDiff.filename}_${index}`}
                          className={
                            line.type === 'added'
                              ? 'w-max min-w-full bg-green-500/15 px-3 text-green-400'
                              : line.type === 'removed'
                                ? 'w-max min-w-full bg-red-500/15 px-3 text-red-400'
                                : line.type === 'header'
                                  ? 'w-max min-w-full bg-blue-500/10 px-3 py-0.5 text-blue-400'
                                  : 'w-max min-w-full px-3 text-[var(--color-text-secondary)]'
                          }
                        >
                          <span className="mr-2 select-none opacity-40">
                            {line.type === 'added' ? '+' : line.type === 'removed' ? '-' : ' '}
                          </span>
                          {line.content || '\u00A0'}
                        </div>
                      ))}
                    </pre>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between border-t border-[var(--color-bg-tertiary)] p-4">
          <p className="text-xs text-[var(--color-text-secondary)]">
            Accepting applies the selected updates immediately and makes them ready for Save to Pi.
          </p>
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="rounded-lg border border-[var(--color-bg-tertiary)] px-4 py-2 text-xs font-medium text-[var(--color-text-primary)] transition-colors hover:bg-[var(--color-bg-primary)]"
            >
              Decline
            </button>
            <button
              onClick={onAccept}
              disabled={!hasChanges || selectedCount === 0 || previewUpdating}
              className="rounded-lg bg-[var(--color-accent)] px-4 py-2 text-xs font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Accept Selected Sections
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}