interface UnsavedChangesDialogProps {
  onApply: () => void;
  onDiscard: () => void;
  onCancel: () => void;
  error?: string;
}

export default function UnsavedChangesDialog({ onApply, onDiscard, onCancel, error }: UnsavedChangesDialogProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onCancel}>
      <div
        className="bg-[var(--color-bg-secondary)] rounded-xl border border-[var(--color-bg-tertiary)] shadow-2xl w-[420px] overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-4 border-b border-[var(--color-bg-tertiary)]">
          <h2 className="text-sm font-semibold text-[var(--color-text-primary)]">Unsaved Changes</h2>
          <p className="text-xs text-[var(--color-text-secondary)] mt-1">
            You have un-applied changes in the text editor. Would you like to apply them before switching views?
          </p>
        </div>
        {error && (
          <p className="px-4 pt-3 text-xs text-[var(--color-error)]">{error}</p>
        )}
        <div className="flex items-center justify-end gap-2 p-3">
          <button
            onClick={onDiscard}
            className="px-3 py-1.5 rounded-md text-xs font-medium bg-[var(--color-bg-tertiary)] text-[var(--color-error)] hover:bg-[var(--color-error)] hover:text-[var(--color-bg-primary)] transition-colors"
          >
            Discard Changes
          </button>
          <button
            onClick={onCancel}
            className="px-3 py-1.5 rounded-md text-xs font-medium bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)] hover:bg-[var(--color-accent)] hover:text-[var(--color-bg-primary)] transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={onApply}
            className="px-3 py-1.5 rounded-md text-xs font-medium bg-[var(--color-accent)] text-[var(--color-bg-primary)] hover:bg-[var(--color-accent-hover)] transition-colors"
          >
            Apply Changes
          </button>
        </div>
      </div>
    </div>
  );
}
