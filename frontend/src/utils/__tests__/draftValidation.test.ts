import { describe, expect, it } from 'vitest';
import {
  MAX_ASSISTANT_DRAFT_VALIDATION_ATTEMPTS,
  buildAssistantDraftValidationErrorMessage,
  buildAssistantDraftValidationFeedback,
  buildValidationErrorKey,
  buildFullRewriteSectionIssues,
  collectNewValidationErrors,
  deriveJinjaRepairCommands,
  formatAssistantDraftValidationIssues,
  hasOnlyRetryExemptAssistantValidationIssues,
  isBlockingAssistantValidationIssue,
  isRetryExemptAssistantValidationIssue,
  suppressValidationErrorsShadowedByFullRewrite,
} from '@/utils/draftValidation';
import type { ValidationError, ConfigSection } from '@/types/config';

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

  it('suppresses validation errors shadowed by a full-rewrite guard on the same section', () => {
    const guardMessage = "Existing section '[bed_mesh]' was returned as a full rewrite. Emit it as a mini-diff instead: the section header followed by ONLY the lines that change, prefixing removals with '-' and additions with '+'. Unchanged lines are preserved automatically and cannot be dropped.";
    const issues = [
      {
        filename: 'printer.cfg',
        errors: [
          error({ section: 'bed_mesh', param: 'mesh_min', message: "Required parameter 'mesh_min' is missing." }),
          error({ section: 'bed_mesh', param: 'mesh_max', message: "Required parameter 'mesh_max' is missing." }),
          error({ section: 'bed_mesh', param: '', message: guardMessage, code: 'macro_full_rewrite' }),
        ],
      },
    ];
    const filtered = suppressValidationErrorsShadowedByFullRewrite(issues);
    expect(filtered).toHaveLength(1);
    expect(filtered[0].errors).toHaveLength(1);
    expect(filtered[0].errors[0].message).toContain('was returned as a full rewrite');
  });

  it('keeps validation errors for sections NOT flagged by the full-rewrite guard', () => {
    const guardMessage = "Existing section '[bed_mesh]' was returned as a full rewrite. Emit it as a mini-diff instead.";
    const issues = [
      {
        filename: 'printer.cfg',
        errors: [
          error({ section: 'bed_mesh', param: '', message: guardMessage, code: 'macro_full_rewrite' }),
          error({ section: 'extruder', param: 'max_temp', message: 'max_temp too low' }),
        ],
      },
    ];
    const filtered = suppressValidationErrorsShadowedByFullRewrite(issues);
    expect(filtered).toHaveLength(1);
    expect(filtered[0].errors.map((e) => e.section)).toEqual(['bed_mesh', 'extruder']);
  });

  it('returns the issues untouched when no full-rewrite guard fired', () => {
    const issues = [
      {
        filename: 'printer.cfg',
        errors: [error({ section: 'extruder', message: 'max_temp too low' })],
      },
    ];
    expect(suppressValidationErrorsShadowedByFullRewrite(issues)).toBe(issues);
  });

  it('recognizes retry-exempt duplicate-section and shared-pin codes', () => {
    expect(isRetryExemptAssistantValidationIssue(error({
      code: 'project_duplicate',
      message: 'Section [extruder] can only be defined once across active included config files.',
    }))).toBe(true);
    expect(isRetryExemptAssistantValidationIssue(error({
      code: 'shared_pin',
      message: "Pin 'PA0' is used by multiple sections: [heater_bed], [extruder]",
    }))).toBe(true);
    expect(isRetryExemptAssistantValidationIssue(error({
      message: 'missing serial',
    }))).toBe(false);
  });

  it('hasOnlyRetryExempt returns true when all issues are exempt', () => {
    expect(hasOnlyRetryExemptAssistantValidationIssues([
      { filename: 'a.cfg', errors: [error({ code: 'project_duplicate', message: 'Section [x] can only be defined once.' })] },
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

  it('exposes the max attempts constant (Phase 5: up to three repair attempts)', () => {
    expect(MAX_ASSISTANT_DRAFT_VALIDATION_ATTEMPTS).toBe(3);
  });
});

describe('deriveJinjaRepairCommands', () => {
  const jinjaError = (section: string, message: string, code?: string): ValidationError =>
    error({ section, param: '', message, code });

  it('derives a direct fix from a Klippy unexpected-end-of-template error', () => {
    const commands = deriveJinjaRepairCommands([{
      filename: 'printer.cfg',
      errors: [jinjaError(
        'gcode_macro M109',
        "Error loading template 'gcode_macro M109:gcode' line 2: {% if printer.quad_gantry_level is defined %} # Unexpected end of template. Jinja was looking for the following tags: 'elif' or 'else' or 'endif'. The innermost block that needs to be closed is 'if'.",
        'macro_jinja_unterminated',
      )],
    }]);
    expect(commands).toEqual([
      "The innermost open Jinja block in [gcode_macro M109] is 'if' — append {% endif %} at the end of its gcode body.",
    ]);
  });

  it('ignores non-Jinja validation errors', () => {
    expect(deriveJinjaRepairCommands([{ filename: 'a.cfg', errors: [error()] }])).toEqual([]);
  });

  it('nudges tool use instead of including current section content (Phase 5 lean retry)', () => {
    const feedback = buildAssistantDraftValidationFeedback(
      [{ filename: 'a.cfg', errors: [error({ section: 'gcode_macro M109', param: '' })] }],
      '[gcode_macro M109]\ngcode:\n  M104\n',
      null,
      false,
    );
    expect(feedback).not.toContain('Current section content (edit only what must change):');
    expect(feedback).not.toContain('### [gcode_macro M109] in a.cfg');
    expect(feedback).toContain('fetch it yourself with read_user_config');
  });
});

describe('buildFullRewriteSectionIssues', () => {
  const section = (header: string, sectionType = 'gcode_macro', gcodeValue = '    G28\n'): ConfigSection => ({
    section_type: sectionType,
    section_name: header.replace(/^[a-z_]+ /, ''),
    full_header: header,
    line_number: 1,
    params: [{ key: 'gcode', value: gcodeValue, comment: '', is_commented_out: false }],
    header_comments: [],
  });

  const plainSection = (
    header: string,
    sectionType: string,
    params: Array<{ key: string; value: string }>,
  ): ConfigSection => ({
    section_type: sectionType,
    section_name: header.replace(/^[a-z_]+ /, ''),
    full_header: header,
    line_number: 1,
    params: params.map((p) => ({ key: p.key, value: p.value, comment: '', is_commented_out: false })),
    header_comments: [],
  });

  const base = [
    section('gcode_macro Level_Bed'),
    plainSection('bed_mesh', 'bed_mesh', [
      { key: 'mesh_min', value: '10, 10' },
      { key: 'mesh_max', value: '290, 290' },
    ]),
  ];

  it('flags a full rewrite of an existing macro section', () => {
    const draft = [section('gcode_macro Level_Bed', 'gcode_macro', '    G28 X0\n')];
    const issues = buildFullRewriteSectionIssues(base, draft, [{ fullHeader: 'gcode_macro Level_Bed' }]);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain('Emit it as a mini-diff instead');
  });

  it('allows a full rewrite of a plain config section (bed_mesh)', () => {
    // Regression: adding a param to a plain section cannot be expressed as a
    // mini-diff (a pure '+' has no '-' anchor), so forcing one deadlocks —
    // the model "refuses" and validation fails after 2 attempts.
    const draft = [plainSection('bed_mesh', 'bed_mesh', [
      { key: 'mesh_min', value: '10, 10' },
      { key: 'mesh_max', value: '290, 290' },
      { key: 'adaptive_margin', value: '10' },
    ])];
    expect(buildFullRewriteSectionIssues(base, draft, [{ fullHeader: 'bed_mesh' }])).toEqual([]);
  });

  it('flags non-macro sections with multi-line bodies too', () => {
    const homing = plainSection('homing_override', 'homing_override', [
      { key: 'gcode', value: 'G28\nG1 Z10\n' },
    ]);
    const baseWithHoming = [...base, homing];
    // Changed draft: same header, different body — a real rewrite.
    const draft = [plainSection('homing_override', 'homing_override', [
      { key: 'gcode', value: 'G28\nG1 Z10\nG1 X0 Y0\n' },
    ])];
    const issues = buildFullRewriteSectionIssues(baseWithHoming, draft, [{ fullHeader: 'homing_override' }]);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain('[homing_override]');
  });

  it('allows a no-op quote of an existing macro section (show-what-is-there)', () => {
    const draft = [section('gcode_macro Level_Bed')]; // identical to base
    expect(buildFullRewriteSectionIssues(base, draft, [{ fullHeader: 'gcode_macro Level_Bed' }])).toEqual([]);
  });

  it('does not flag new sections (additions are written in full)', () => {
    const draft = [section('gcode_macro BRAND_NEW')];
    expect(buildFullRewriteSectionIssues(base, draft, [{ fullHeader: 'gcode_macro BRAND_NEW' }])).toEqual([]);
  });
});
