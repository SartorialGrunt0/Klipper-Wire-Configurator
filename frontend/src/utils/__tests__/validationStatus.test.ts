import { describe, expect, it } from 'vitest';
import {
  combineValidationStatuses,
  getValidationStatusColor,
  getValidationStatusLabel,
  sectionValidationStatus,
} from '@/utils/validationStatus';
import type { ValidationError } from '@/types/config';
import type { ValidationStatus } from '@/types/graph';

function issue(overrides: Partial<ValidationError> = {}): ValidationError {
  return {
    severity: 'error',
    section: 'mcu',
    param: '',
    message: 'problem',
    line_number: 1,
    ...overrides,
  };
}

describe('combineValidationStatuses', () => {
  it('error wins over everything', () => {
    expect(combineValidationStatuses(['valid', 'warning', 'error'])).toBe('error');
    expect(combineValidationStatuses(['error'])).toBe('error');
  });

  it('warning beats valid', () => {
    expect(combineValidationStatuses(['valid', 'warning'])).toBe('warning');
    expect(combineValidationStatuses(['valid', null, undefined])).toBe('valid');
  });

  it('returns valid for empty or all-null inputs', () => {
    expect(combineValidationStatuses([])).toBe('valid');
    expect(combineValidationStatuses([null, undefined])).toBe('valid');
  });

  it('excludes null/undefined from the result', () => {
    const status: ValidationStatus = combineValidationStatuses(['warning', null]);
    expect(status).toBe('warning');
  });
});

describe('sectionValidationStatus', () => {
  it('returns valid with no matching errors', () => {
    expect(sectionValidationStatus([], 'mcu')).toBe('valid');
  });

  it('ignores issues for other sections', () => {
    const errors = [issue({ section: 'extruder' })];
    expect(sectionValidationStatus(errors, 'mcu')).toBe('valid');
  });

  it('returns error for a matching error', () => {
    const errors = [issue({ section: 'mcu' })];
    expect(sectionValidationStatus(errors, 'mcu')).toBe('error');
  });

  it('returns warning when only warnings match', () => {
    const errors = [issue({ section: 'mcu', severity: 'warning' })];
    expect(sectionValidationStatus(errors, 'mcu')).toBe('warning');
  });

  it('error takes priority over warning in the same section', () => {
    const errors = [
      issue({ section: 'mcu', severity: 'warning' }),
      issue({ section: 'mcu', severity: 'error' }),
    ];
    expect(sectionValidationStatus(errors, 'mcu')).toBe('error');
  });
});

describe('getValidationStatusColor', () => {
  it('maps statuses to CSS variables', () => {
    expect(getValidationStatusColor('error')).toBe('var(--color-error)');
    expect(getValidationStatusColor('warning')).toBe('var(--color-warning)');
    expect(getValidationStatusColor('valid')).toBe('var(--color-success)');
  });
});

describe('getValidationStatusLabel', () => {
  it('maps statuses to labels', () => {
    expect(getValidationStatusLabel('error')).toBe('Validation errors');
    expect(getValidationStatusLabel('warning')).toBe('Validation warnings');
    expect(getValidationStatusLabel('valid')).toBe('No validation issues');
  });
});
