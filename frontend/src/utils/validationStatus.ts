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
