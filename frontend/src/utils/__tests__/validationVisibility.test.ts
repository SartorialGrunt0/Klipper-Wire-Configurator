import { describe, expect, it } from 'vitest';
import {
  ALL_VISIBLE,
  filterFindings,
  filterValidationMap,
  severityVisible,
  validationDotsVisible,
  type SeverityVisibility,
} from '../validationVisibility';
import type { ValidationResult } from '../../types/config';

const settings = (over: Partial<SeverityVisibility> = {}): SeverityVisibility => ({
  ...ALL_VISIBLE,
  ...over,
});

const finding = (severity: 'error' | 'warning' | 'info') => ({ severity });
const result = (severities: Array<'error' | 'warning' | 'info'>): ValidationResult => ({
  has_errors: severities.includes('error'),
  has_warnings: severities.includes('warning'),
  errors: severities.map((severity) => ({
    severity,
    section: 'stepper_x',
    param: '',
    message: `${severity} message`,
    line_number: 1,
  })) as ValidationResult['errors'],
});

describe('severityVisible', () => {
  it('shows everything with defaults', () => {
    expect(severityVisible('error', settings())).toBe(true);
    expect(severityVisible('warning', settings())).toBe(true);
    expect(severityVisible('info', settings())).toBe(true);
  });

  it('hides the toggled-off tier only', () => {
    expect(severityVisible('info', settings({ showInfo: false }))).toBe(false);
    expect(severityVisible('warning', settings({ showInfo: false }))).toBe(true);
    expect(severityVisible('error', settings({ showError: false }))).toBe(false);
    expect(severityVisible('warning', settings({ showWarning: false }))).toBe(false);
  });

  it('master-off hides every tier', () => {
    const off = settings({ enabled: false });
    expect(severityVisible('error', off)).toBe(false);
    expect(severityVisible('warning', off)).toBe(false);
    expect(severityVisible('info', off)).toBe(false);
  });
});

describe('filterFindings / filterValidationMap', () => {
  it('filters per severity', () => {
    const kept = filterFindings(
      [finding('error'), finding('warning'), finding('info')],
      settings({ showWarning: false }),
    );
    expect(kept.map((f) => f.severity)).toEqual(['error', 'info']);
  });

  it('returns an empty map when validation is disabled', () => {
    const map = filterValidationMap(
      { 'printer.cfg': result(['error', 'warning', 'info']) },
      settings({ enabled: false }),
    );
    expect(map).toEqual({});
  });

  it('keeps the same map object when nothing is filtered', () => {
    const input = { 'printer.cfg': result(['warning']) };
    expect(filterValidationMap(input, settings())).toBe(input);
  });

  it('preserves has_errors-independent consumers by rebuilding entries', () => {
    const map = filterValidationMap(
      { 'printer.cfg': result(['error', 'info']) },
      settings({ showError: false }),
    );
    expect(map['printer.cfg'].errors.map((e) => e.severity)).toEqual(['info']);
    // Original untouched (shared store state must never be mutated).
    expect(result(['error', 'info']).errors).toHaveLength(2);
  });
});

describe('validationDotsVisible', () => {
  it('visible by default', () => {
    expect(validationDotsVisible(settings())).toBe(true);
  });

  it('hidden when validation is disabled', () => {
    expect(validationDotsVisible(settings({ enabled: false }))).toBe(false);
  });

  it('hidden only when BOTH error and warning tiers are hidden', () => {
    expect(validationDotsVisible(settings({ showError: false }))).toBe(true);
    expect(validationDotsVisible(settings({ showWarning: false }))).toBe(true);
    expect(
      validationDotsVisible(settings({ showError: false, showWarning: false })),
    ).toBe(false);
  });
});
