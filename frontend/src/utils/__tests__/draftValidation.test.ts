import { describe, expect, it } from 'vitest';
import {
  MAX_ASSISTANT_DRAFT_VALIDATION_ATTEMPTS,
  buildAssistantDraftValidationErrorMessage,
  buildAssistantDraftValidationFeedback,
  buildValidationErrorKey,
  collectNewValidationErrors,
  formatAssistantDraftValidationIssues,
  hasOnlyRetryExemptAssistantValidationIssues,
  isBlockingAssistantValidationIssue,
  isRetryExemptAssistantValidationIssue,
} from '@/utils/draftValidation';
import type { ValidationError } from '@/types/config';

const error = (overrides: Partial<ValidationError> = {}): ValidationError => ({
  severity: 'error',
  section: 'mcu',
  param: 'serial',
  message: 'missing serial',
  line_number: 1,
  ...overrides,
});

describe('issue classification', () => {
  it('treats errors and warnings as blocking', () => {
    expect(isBlockingAssistantValidationIssue(error({ severity: 'error' }))).toBe(true);
    expect(isBlockingAssistantValidationIssue(error({ severity: 'warning' }))).toBe(true);
    expect(isBlockingAssistantValidationIssue(error({ severity: 'info' }))).toBe(false);
  });

  it('recognizes retry-exempt duplicate-section and shared-pin messages', () => {
    expect(isRetryExemptAssistantValidationIssue(error({
      message: 'Section [extruder] can only be defined once across active included config files.',
    }))).toBe(true);
    expect(isRetryExemptAssistantValidationIssue(error({
      message: "Pin 'PA0' is used by multiple sections: [heater_bed], [extruder]",
    }))).toBe(true);
    expect(isRetryExemptAssistantValidationIssue(error({
      message: 'missing serial',
    }))).toBe(false);
  });

  it('hasOnlyRetryExempt returns true when all issues are exempt', () => {
    expect(hasOnlyRetryExemptAssistantValidationIssues([
      { filename: 'a.cfg', errors: [error({ message: 'Section [x] can only be defined once.' })] },
    ])).toBe(true);
    expect(hasOnlyRetryExemptAssistantValidationIssues([
      { filename: 'a.cfg', errors: [error({ message: 'Section [x] can only be defined once.' }), error()] },
    ])).toBe(false);
    expect(hasOnlyRetryExemptAssistantValidationIssues([])).toBe(false);
  });
});

describe('collectNewValidationErrors', () => {
  it('returns only errors not already in the baseline', () => {
    const baseline = {
      'printer.cfg': {
        has_errors: true,
        has_warnings: false,
        errors: [error({ section: 'mcu', param: 'serial', message: 'missing serial' })],
      },
    };
    const candidate = {
      'printer.cfg': {
        has_errors: true,
        has_warnings: false,
        errors: [
          error({ section: 'mcu', param: 'serial', message: 'missing serial' }),
          error({ section: 'extruder', param: 'heater_pin', message: 'missing heater_pin' }),
        ],
      },
    };
    const groups = collectNewValidationErrors(baseline, candidate);
    expect(groups).toHaveLength(1);
    expect(groups[0].filename).toBe('printer.cfg');
    expect(groups[0].errors.map((e) => e.message)).toEqual(['missing heater_pin']);
  });

  it('ignores info-severity errors entirely', () => {
    const candidate = {
      'printer.cfg': {
        has_errors: false,
        has_warnings: false,
        errors: [error({ severity: 'info', message: 'minor' })],
      },
    };
    expect(collectNewValidationErrors({}, candidate)).toEqual([]);
  });

  it('returns empty when nothing new appears', () => {
    const result = {
      'printer.cfg': { has_errors: true, has_warnings: false, errors: [error()] },
    };
    expect(collectNewValidationErrors(result, result)).toEqual([]);
  });
});

describe('buildValidationErrorKey', () => {
  it('joins filename and error fields', () => {
    expect(buildValidationErrorKey('printer.cfg', error())).toBe(
      'printer.cfg::error::mcu::serial::missing serial',
    );
  });
});

describe('formatting', () => {
  it('formats issues with file and location', () => {
    const text = formatAssistantDraftValidationIssues([
      { filename: 'a.cfg', errors: [error({ param: 'serial' })] },
    ], 'boom');
    expect(text).toContain('- boom');
    expect(text).toContain('File: a.cfg');
    expect(text).toContain('- [mcu] serial: missing serial');
  });

  it('builds feedback WITHOUT quoting the invalid content (Phase 4 anti-copy)', () => {
    const feedback = buildAssistantDraftValidationFeedback(
      [{ filename: 'a.cfg', errors: [error()] }],
      '[mcu]\nserial: x\n',
      null,
    );
    expect(feedback).toContain('Your cfg changes failed validation');
    expect(feedback).toContain('[mcu] serial: missing serial');
    // The broken draft must NOT be echoed back — models copy it verbatim.
    expect(feedback).not.toContain('serial: x');
    expect(feedback).not.toContain('Previous invalid reply');
    expect(feedback).toContain('Do NOT copy or repeat your previous reply');
  });

  it('uses explanation-only variant when allowed', () => {
    const feedback = buildAssistantDraftValidationFeedback(
      [],
      '',
      null,
      true,
    );
    expect(feedback).toContain('clearly explain the conflict');
  });

  it('builds error message with attempt pluralization', () => {
    expect(buildAssistantDraftValidationErrorMessage([], null, 1)).toBe(
      'AI draft failed validation after 1 attempt.',
    );
    expect(buildAssistantDraftValidationErrorMessage([], null, 3)).toBe(
      'AI draft failed validation after 3 attempts.',
    );
    const withIssues = buildAssistantDraftValidationErrorMessage(
      [{ filename: 'a.cfg', errors: [error()] }],
      null,
      2,
    );
    expect(withIssues).toContain('[mcu] serial: missing serial');
  });

  it('exposes the max attempts constant (fail fast: one repair attempt)', () => {
    expect(MAX_ASSISTANT_DRAFT_VALIDATION_ATTEMPTS).toBe(2);
  });
});
