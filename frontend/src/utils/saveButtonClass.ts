import type { ValidationResult } from '../types/config';

/**
 * Tailwind class string for the Save button's state color. Shared between the
 * toolbar Save button and the Save (Apply) dialog so both always agree:
 * grey = no unsaved changes, green = valid, yellow = warnings, red = errors.
 */
export function getSaveButtonClass(
  isDirty: boolean,
  validation: Record<string, ValidationResult>,
): string {
  if (!isDirty) {
    // No changes — normal grey
    return 'bg-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] hover:bg-[var(--color-accent)] hover:text-[var(--color-bg-primary)]';
  }
  const hasErrors = Object.values(validation).some((v) =>
    v.errors.some((e) => e.severity === 'error'),
  );
  const hasWarnings = Object.values(validation).some((v) =>
    v.errors.some((e) => e.severity === 'warning'),
  );
  if (hasErrors) {
    return 'bg-red-600 text-white hover:bg-red-700';
  }
  if (hasWarnings) {
    return 'bg-[var(--color-warning)] text-[var(--color-bg-primary)] hover:opacity-90';
  }
  // Valid changes
  return 'bg-green-600 text-white hover:bg-green-700';
}
