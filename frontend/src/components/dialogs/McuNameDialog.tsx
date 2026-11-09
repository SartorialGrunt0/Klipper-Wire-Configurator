import { useState, useCallback, useEffect, useRef } from 'react';

interface McuNameDialogProps {
  /** Title shown at the top of the dialog. */
  title?: string;
  /** Explanatory message below the title. */
  message?: string;
  /** Initial value for the MCU name field. */
  initialValue?: string;
  /** Called when the user confirms the name. */
  onConfirm: (mcuName: string) => void;
  /** Called when the user cancels. */
  onCancel: () => void;
}

/**
 * Modal dialog that prompts the user to enter an MCU name.
 * Used when adding a non-primary hardware node or when swapping primary.
 */
export default function McuNameDialog({
  title = 'Name this MCU',
  message = 'Non-primary boards need an MCU name. This name is used in section headers (e.g., [mcu EBBCan]) and as a pin prefix (e.g., EBBCan:gpio13).',
  initialValue = '',
  onConfirm,
  onCancel,
}: McuNameDialogProps) {
  const [value, setValue] = useState(initialValue);
  const [error, setError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const validate = useCallback((name: string): string => {
    const trimmed = name.trim();
    if (!trimmed) return 'MCU name is required.';
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(trimmed)) {
      return 'MCU name must start with a letter/underscore and contain only letters, numbers, and underscores.';
    }
    if (trimmed.toLowerCase() === 'mcu') return 'Cannot use "mcu" as a name.';
    return '';
  }, []);

  const handleSubmit = useCallback(() => {
    const trimmed = value.trim();
    const err = validate(trimmed);
    if (err) {
      setError(err);
      return;
    }
    onConfirm(trimmed);
  }, [value, validate, onConfirm]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') handleSubmit();
      if (e.key === 'Escape') onCancel();
    },
    [handleSubmit, onCancel],
  );

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60">
      <div className="bg-[var(--color-bg-secondary)] border border-[var(--color-bg-tertiary)] rounded-lg shadow-xl p-6 w-96 max-w-[90vw]">
        <div className="flex items-start justify-between gap-2 mb-2">
          <h3 className="text-lg font-semibold text-[var(--color-text-primary)]">{title}</h3>
          <button aria-label="Close" onClick={onCancel} className="p-1 rounded hover:bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)]">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>
        <p className="text-sm text-[var(--color-text-secondary)] mb-4">{message}</p>

        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            if (error) setError('');
          }}
          onKeyDown={handleKeyDown}
          placeholder="e.g., EBBCan, SKR_Pico"
          className="w-full px-3 py-2 rounded border bg-[var(--color-bg-primary)] border-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] text-sm placeholder:text-[var(--color-text-tertiary)] focus:border-[var(--color-accent)] focus:outline-none"
        />

        {error && (
          <p className="text-xs text-[var(--color-error)] mt-1">{error}</p>
        )}

        <div className="flex justify-end gap-2 mt-4">
          <button
            onClick={onCancel}
            className="px-4 py-1.5 rounded text-sm text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)] transition"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            className="px-4 py-1.5 rounded text-sm bg-[var(--color-accent)] text-[var(--color-bg-primary)] hover:bg-[var(--color-accent-hover)] transition-colors"
          >
            Confirm
          </button>
        </div>
      </div>
    </div>
  );
}
