interface ApplyWarningDialogProps {
  issues: Array<{ line: number; text: string; severity: 'error' | 'warning' }>;
  onProceed: () => void;
  onCancel: () => void;
}

export default function ApplyWarningDialog({ issues, onProceed, onCancel }: ApplyWarningDialogProps) {
  const errors = issues.filter((i) => i.severity === 'error');
  const warnings = issues.filter((i) => i.severity === 'warning');

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onCancel}>
      <div
        className="bg-[var(--color-bg-secondary)] rounded-xl border border-[var(--color-bg-tertiary)] shadow-2xl w-[520px] max-h-[80vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-4 border-b border-[var(--color-bg-tertiary)] shrink-0">
          <h2 className="text-sm font-semibold text-[var(--color-text-primary)]">
            {errors.length > 0 ? 'Errors' : 'Warnings'} in Config
          </h2>
          <p className="text-xs text-[var(--color-text-secondary)] mt-1">
            {errors.length > 0 && `${errors.length} error${errors.length !== 1 ? 's' : ''}`}
            {errors.length > 0 && warnings.length > 0 && ' and '}
            {warnings.length > 0 && `${warnings.length} warning${warnings.length !== 1 ? 's' : ''}`}
            {' '}found. You can still apply changes, but they may cause issues.
          </p>
        </div>
        <div className="flex-1 overflow-y-auto p-3 space-y-1">
          {issues.map((issue, i) => (
            <div
              key={i}
              className={`flex items-start gap-2 px-3 py-2 rounded-lg text-xs font-mono ${
                issue.severity === 'error'
                  ? 'bg-[var(--color-error)]/10 border border-[var(--color-error)]/30'
                  : 'bg-[var(--color-warning)]/10 border border-[var(--color-warning)]/30'
              }`}
            >
              <span
                className={`shrink-0 mt-0.5 ${
                  issue.severity === 'error' ? 'text-[var(--color-error)]' : 'text-[var(--color-warning)]'
                }`}
              >
                {issue.severity === 'error' ? '●' : '▲'}
              </span>
              <div className="min-w-0">
                <span className="text-[var(--color-text-secondary)]">Line {issue.line}: </span>
                <span className="text-[var(--color-text-primary)]">{issue.text}</span>
              </div>
            </div>
          ))}
        </div>
        <div className="flex items-center justify-end gap-2 p-3 border-t border-[var(--color-bg-tertiary)] shrink-0">
          <button
            onClick={onCancel}
            className="px-3 py-1.5 rounded-md text-xs font-medium bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)] hover:bg-[var(--color-accent)] hover:text-[var(--color-bg-primary)] transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={onProceed}
            className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
              errors.length > 0
                ? 'bg-[var(--color-error)] text-[var(--color-bg-primary)] hover:opacity-80'
                : 'bg-[var(--color-warning)] text-[var(--color-bg-primary)] hover:opacity-80'
            }`}
          >
            Apply Anyway
          </button>
        </div>
      </div>
    </div>
  );
}
