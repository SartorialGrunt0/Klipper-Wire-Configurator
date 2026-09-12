import type { ValidationError } from '../types/config';
import type { ValidationStatus } from '../types/graph';

export function combineValidationStatuses(
  statuses: Array<ValidationStatus | null | undefined>,
): ValidationStatus {
  if (statuses.some((status) => status === 'error')) return 'error';
  if (statuses.some((status) => status === 'warning')) return 'warning';
  return 'valid';
}

export function sectionValidationStatus(
  errors: ValidationError[],
  sectionHeader: string,
): ValidationStatus {
  let status: ValidationStatus = 'valid';
  for (const issue of errors) {
    if (issue.section !== sectionHeader) continue;
    if (issue.severity === 'error') return 'error';
    if (issue.severity === 'warning') status = 'warning';
  }
  return status;
}

/**
 * Dot model for graph nodes and list rows: a dot means "there is something
 * to see". A clean (or not-yet-validated) node renders NO dot at all —
 * green used to conflate "valid" with "never checked", and the visibility
 * filter already hides dots rather than turning them green.
 */
export function hasValidationDot(status: ValidationStatus): boolean {
  return status !== 'valid';
}

export function getValidationStatusColor(status: ValidationStatus): string {
  if (status === 'error') return 'var(--color-error)';
  if (status === 'warning') return 'var(--color-warning)';
  return 'var(--color-success)';
}

export function getValidationStatusLabel(status: ValidationStatus): string {
  if (status === 'error') return 'Validation errors';
  if (status === 'warning') return 'Validation warnings';
  return 'No validation issues';
}
