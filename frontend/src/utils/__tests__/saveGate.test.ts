import { describe, expect, it } from 'vitest';
import {
  selectSaveGateIssues,
  warningToBulkAck,
  type SaveGateFinding,
} from '@/utils/saveGate';
import type { ValidationResult } from '@/types/config';

/** Build a minimal ValidationResult from a list of findings. */
function result(entries: Array<[
  severity: 'error' | 'warning' | 'info',
  section: string,
  message: string,
  opts?: { param?: string; line?: number; code?: string },
]>): ValidationResult {
  const errors = entries.map(([severity, section, message, opts]) => ({
    severity,
    section,
    param: opts?.param ?? '',
    message,
    line_number: opts?.line ?? 0,
    ...(opts?.code ? { code: opts.code } : {}),
  }));
  return {
    has_errors: errors.some((e) => e.severity === 'error'),
    has_warnings: errors.some((e) => e.severity === 'warning'),
    errors,
  };
}

describe('selectSaveGateIssues', () => {
  it('excludes info findings entirely (regression: info-only → both empty)', () => {
    const validation: Record<string, ValidationResult> = {
      'printer.cfg': result([
        ['info', 'stepper_z', 'duplicate', { code: 'project_duplicate', line: 5 }],
        ['info', 'stepper_z1', 'duplicate', { code: 'project_duplicate', line: 10 }],
      ]),
    };
    const out = selectSaveGateIssues(validation, ['printer.cfg']);
    expect(out.errors).toEqual([]);
    expect(out.warnings).toEqual([]);
    expect(out.hasErrors).toBe(false);
    expect(out.hasWarnings).toBe(false);
  });

  it('splits errors and warnings by severity and sets the flags', () => {
    const validation: Record<string, ValidationResult> = {
      'printer.cfg': result([
        ['error', 'stepper_x', 'missing rail', { code: 'kinematics_stepper_missing', line: 2 }],
        ['warning', 'idle_timeout', 'unknown param', { code: 'unknown_param', line: 7, param: 'x' }],
      ]),
    };
    const out = selectSaveGateIssues(validation, ['printer.cfg']);
    expect(out.errors).toHaveLength(1);
    expect(out.warnings).toHaveLength(1);
    expect(out.hasErrors).toBe(true);
    expect(out.hasWarnings).toBe(true);
    expect(out.errors[0].code).toBe('kinematics_stepper_missing');
    expect(out.warnings[0].code).toBe('unknown_param');
  });

  it('only includes findings for selected files', () => {
    const validation: Record<string, ValidationResult> = {
      'printer.cfg': result([['error', 'stepper_x', 'err a', { line: 1 }]]),
      'other.cfg': result([['warning', 'idle_timeout', 'warn b', { line: 1 }]]),
    };
    const out = selectSaveGateIssues(validation, ['printer.cfg']);
    expect(out.errors.map((e) => e.file)).toEqual(['printer.cfg']);
    expect(out.warnings).toEqual([]);
  });

  it('files absent from the validation map contribute nothing (deleted / new files)', () => {
    const validation: Record<string, ValidationResult> = {};
    const out = selectSaveGateIssues(validation, ['printer.cfg', 'gone.cfg']);
    expect(out.errors).toEqual([]);
    expect(out.warnings).toEqual([]);
  });

  it('reports parse-error files as blocked, not mixed into the error list', () => {
    const validation: Record<string, ValidationResult> = {
      // last-good model still has a finding, but the file is blocked
      'printer.cfg': result([['error', 'stepper_x', 'err', { line: 1 }]]),
      'broken.cfg': result([['warning', 'idle_timeout', 'warn', { line: 1 }]]),
    };
    const out = selectSaveGateIssues(
      validation,
      ['printer.cfg', 'broken.cfg'],
      { 'broken.cfg': 'unparseable' },
    );
    expect(out.blocked).toEqual(['broken.cfg']);
    // blocked file's last-good findings are superseded by the parse error
    expect(out.errors.map((e) => e.file)).toEqual(['printer.cfg']);
    expect(out.warnings).toEqual([]);
  });

  it('a parse-error file NOT selected for save does not block', () => {
    const validation: Record<string, ValidationResult> = {
      'printer.cfg': result([['warning', 'idle_timeout', 'warn', { line: 1 }]]),
      'broken.cfg': result([['warning', 'idle_timeout', 'warn', { line: 1 }]]),
    };
    const out = selectSaveGateIssues(
      validation,
      ['printer.cfg'], // broken.cfg deliberately not selected
      { 'broken.cfg': 'unparseable' },
    );
    expect(out.blocked).toEqual([]);
    // only the selected file's findings gate the save
    expect(out.warnings.map((e) => e.file)).toEqual(['printer.cfg']);
  });

  it('stable ordering: errors before warnings, then file, then line', () => {
    const validation: Record<string, ValidationResult> = {
      'b.cfg': result([
        ['error', 's', 'b-e-2', { line: 20 }],
        ['error', 's', 'b-e-1', { line: 10 }],
      ]),
      'a.cfg': result([
        ['warning', 's', 'a-w-1', { line: 5 }],
        ['error', 's', 'a-e-1', { line: 3 }],
        ['warning', 's', 'a-w-2', { line: 9 }],
      ]),
    };
    const out = selectSaveGateIssues(validation, ['b.cfg', 'a.cfg']);
    // errors first, sorted by file then line
    expect(out.errors.map((e) => `${e.file}:${e.line_number}`)).toEqual([
      'a.cfg:3', 'b.cfg:10', 'b.cfg:20',
    ]);
    // warnings after, sorted by file then line
    expect(out.warnings.map((e) => `${e.file}:${e.line_number}`)).toEqual([
      'a.cfg:5', 'a.cfg:9',
    ]);
  });

  it('carries file/section/param/line_number on each finding', () => {
    const validation: Record<string, ValidationResult> = {
      'printer.cfg': result([
        ['warning', 'idle_timeout', 'unknown', { code: 'unknown_param', param: 'foo', line: 42 }],
      ]),
    };
    const out = selectSaveGateIssues(validation, ['printer.cfg']);
    const finding: SaveGateFinding = out.warnings[0];
    expect(finding).toEqual({
      file: 'printer.cfg',
      code: 'unknown_param',
      section: 'idle_timeout',
      param: 'foo',
      message: 'unknown',
      line_number: 42,
    });
  });
});

describe('warningToBulkAck', () => {
  it('maps a warning finding to a bulk-ack identity payload', () => {
    const finding: SaveGateFinding = {
      file: 'printer.cfg',
      code: 'unknown_param',
      section: 'idle_timeout',
      param: 'foo',
      message: 'unknown',
      line_number: 42,
    };
    // The backend derives `extra` server-side, so the client sends '' —
    // what matters is file|code|section|param matching the validator.
    expect(warningToBulkAck(finding)).toEqual({
      file: 'printer.cfg',
      code: 'unknown_param',
      section: 'idle_timeout',
      param: 'foo',
      extra: '',
    });
  });

  it('returns an empty payload for an empty findings list', () => {
    expect(selectSaveGateIssues({}, ['x.cfg']).warnings.map(warningToBulkAck)).toEqual([]);
  });
});
