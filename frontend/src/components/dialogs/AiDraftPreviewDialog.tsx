import { useMemo } from 'react';
import type { AssistantDraftChange } from '../../utils/assistantDraftMerge';
import { createConfigPatch, parsePatch } from '../../utils/configDiff';

interface AiDraftPreviewDialogProps {
  filename: string;
  originalText: string;
  mergedText: string;
  changes: AssistantDraftChange[];
  selectedChangeIds: string[];
  previewUpdating: boolean;
  onSelectionChange: (selectedChangeIds: string[]) => void;
  onAccept: () => void;
  onClose: () => void;
}

export default function AiDraftPreviewDialog({
  filename,
  originalText,
  mergedText,
  changes,
  selectedChangeIds,
  previewUpdating,
  onSelectionChange,
  onAccept,
  onClose,
}: AiDraftPreviewDialogProps) {
  const selectedIdSet = useMemo(() => new Set(selectedChangeIds), [selectedChangeIds]);
  const selectedCount = selectedChangeIds.length;
  const patch = useMemo(
    () => createConfigPatch(filename, originalText, mergedText, 'current draft', 'assistant merge', 3),
    [filename, mergedText, originalText],
  );
  const diffLines = useMemo(() => parsePatch(patch), [patch]);
  const changedLineCount = useMemo(
    () => diffLines.filter((line) => line.type === 'added' || line.type === 'removed').length,
    [diffLines],
  );
  const hasChanges = changedLineCount > 0;

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
              The assistant sections will be merged into {filename} before the draft is updated.
            </p>
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
                  className={change.mode === 'add' ? 'text-green-400' : 'text-[var(--color-accent)]'}
                >
                  {change.mode === 'add' ? 'new' : 'update'}
                </span>
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
            <div className="overflow-hidden rounded-lg border border-[var(--color-bg-tertiary)]">
              <pre className="overflow-x-auto text-xs leading-5 font-mono">
                {diffLines.map((line, index) => (
                  <div
                    key={index}
                    className={
                      line.type === 'added'
                        ? 'bg-green-500/15 px-3 text-green-400'
                        : line.type === 'removed'
                          ? 'bg-red-500/15 px-3 text-red-400'
                          : line.type === 'header'
                            ? 'bg-blue-500/10 px-3 py-0.5 text-blue-400'
                            : 'px-3 text-[var(--color-text-secondary)]'
                    }
                  >
                    <span className="mr-2 select-none opacity-40">
                      {line.type === 'added' ? '+' : line.type === 'removed' ? '-' : ' '}
                    </span>
                    {line.content || '\u00A0'}
                  </div>
                ))}
              </pre>
            </div>
          )}
        </div>

        <div className="flex items-center justify-between border-t border-[var(--color-bg-tertiary)] p-4">
          <p className="text-xs text-[var(--color-text-secondary)]">
            Accepting updates the text draft only. You can still review or apply it from the editor afterward.
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