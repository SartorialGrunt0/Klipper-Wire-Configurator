import { describe, it, expect } from 'vitest';
import {
  detectCompletionContext,
  sectionTypeOf,
  matchScore,
  rankCandidates,
  candidatesFor,
  completionsAt,
  applyCandidate,
  type CompletionSources,
} from '../configCompletion';
import type { SectionSchema, ParamSchema } from '../../types/config';

const param = (name: string, over: Partial<ParamSchema> = {}): ParamSchema => ({
  name,
  type: 'float',
  required: false,
  default: null,
  description: '',
  enum_values: [],
  unit: '',
  ...over,
});

const section = (type: string, over: Partial<SectionSchema> = {}): SectionSchema => ({
  section_type: type,
  display_name: type,
  category: 'hardware',
  component_group: '',
  is_named: false,
  description: '',
  max_instances: 1,
  requires: [],
  params: [],
  ...over,
});

const SCHEMAS: Record<string, SectionSchema> = {
  stepper_x: section('stepper_x', {
    display_name: 'Stepper X',
    description: 'X axis stepper',
    params: [
      param('microsteps', { required: true, default: '16', description: 'Microstep count' }),
      param('rotation_distance', { required: true }),
      param('stepper_type'),
    ],
  }),
  sensor: section('sensor', {
    params: [param('sensor_type', { type: 'enum', enum_values: ['EPCOS 100K B57560G104F', 'NTC 100K MGB18-104F39050L32'] })],
  }),
  gcode_macro: section('gcode_macro', { is_named: true, params: [param('gcode', { type: 'multi_line' })] }),
  printer: section('printer', { params: [param('max_velocity'), param('max_accel')] }),
};

const SOURCES: CompletionSources = {
  schemas: SCHEMAS,
  includePaths: ['macros/start.cfg', 'macros/end.cfg', 'mainsail.cfg'],
  macroNames: ['CLEAN_NOZZLE', 'PRINT_END'],
  gcodeCommands: ['G28', 'G1', 'M104', 'BED_MESH_CALIBRATE'],
};

/** Convenience: caret at the end of `text` unless `|` marks it. */
const at = (withCaret: string) => {
  const caret = withCaret.indexOf('|');
  const text = withCaret.replace('|', '');
  return { text, caret: caret === -1 ? text.length : caret };
};

describe('sectionTypeOf', () => {
  it('takes the first token of a named header', () => {
    expect(sectionTypeOf('gcode_macro CLEAN_NOZZLE')).toBe('gcode_macro');
    expect(sectionTypeOf('fan_generic part_fan')).toBe('fan_generic');
    expect(sectionTypeOf('stepper_x')).toBe('stepper_x');
    expect(sectionTypeOf('  STepper_X  ')).toBe('stepper_x');
  });

  it('returns undefined without a header', () => {
    expect(sectionTypeOf(null)).toBeUndefined();
    expect(sectionTypeOf('   ')).toBeUndefined();
  });
});

describe('detectCompletionContext — section headers', () => {
  it('offers section types after an opening bracket', () => {
    const { text, caret } = at('[step');
    const ctx = detectCompletionContext(text, caret);
    expect(ctx).toMatchObject({ kind: 'section-type', prefix: 'step', replaceStart: 1, trailing: '' });
  });

  it('offers everything right after the bracket', () => {
    expect(detectCompletionContext('[', 1)).toMatchObject({ kind: 'section-type', prefix: '' });
  });

  it('works for a commented-out header', () => {
    expect(detectCompletionContext('#[pro', 5)).toMatchObject({ kind: 'section-type', prefix: 'pro' });
  });

  it('keeps the trailing bracket out of the replacement', () => {
    const { text, caret } = at('[step|]');
    const ctx = detectCompletionContext(text, caret);
    expect(ctx).toMatchObject({ kind: 'section-type', prefix: 'step', trailing: ']' });
  });

  it('offers include paths after [include', () => {
    const { text, caret } = at('[include mac');
    expect(detectCompletionContext(text, caret)).toMatchObject({
      kind: 'include-file',
      prefix: 'mac',
      replaceStart: 9,
    });
  });

  it('does not offer a header once the bracket is closed', () => {
    expect(detectCompletionContext('[stepper_x]\n', 12)?.kind).toBe('param-key');
    const nextLine = '[stepper_x]\n[';
    expect(detectCompletionContext(nextLine, nextLine.length)).toMatchObject({ kind: 'section-type' });
  });

  it('does not fire in ordinary text outside any section', () => {
    expect(detectCompletionContext('max_velocity: 300', 16)).toBeNull();
  });
});

describe('detectCompletionContext — params', () => {
  const text = '[stepper_x]\nmic';

  it('offers param keys at a line start inside a section', () => {
    expect(detectCompletionContext(text, text.length)).toMatchObject({
      kind: 'param-key',
      prefix: 'mic',
      sectionType: 'stepper_x',
    });
  });

  it('offers param keys on a fresh line', () => {
    const t = '[stepper_x]\nmicrosteps: 16\n';
    expect(detectCompletionContext(t, t.length)).toMatchObject({ kind: 'param-key', prefix: '' });
  });

  it('does not offer keys above the first section', () => {
    expect(detectCompletionContext('mic', 3)).toBeNull();
  });

  it('offers enum values after a key', () => {
    const t = '[sensor]\nsensor_type: ';
    expect(detectCompletionContext(t, t.length)).toMatchObject({
      kind: 'param-value',
      prefix: '',
      paramKey: 'sensor_type',
      sectionType: 'sensor',
    });
  });

  it('offers enum values mid-typing', () => {
    const t = '[sensor]\nsensor_type: NTC';
    expect(detectCompletionContext(t, t.length)).toMatchObject({
      kind: 'param-value',
      prefix: 'NTC',
      replaceStart: t.length - 3,
    });
  });

  it('does not offer a second value token after the first one', () => {
    const t = '[sensor]\nsensor_type: NTC 100';
    expect(detectCompletionContext(t, t.length)).toBeNull();
  });
});

describe('detectCompletionContext — gcode blocks', () => {
  it('offers commands inside a gcode_macro gcode: block', () => {
    const t = '[gcode_macro CLEAN_NOZZLE]\ngcode:\n  G2';
    expect(detectCompletionContext(t, t.length)).toMatchObject({
      kind: 'gcode-command',
      prefix: 'G2',
      sectionType: 'gcode_macro',
    });
  });

  it('offers commands inside gcode_on_error:', () => {
    const t = '[gcode_macro X]\ngcode_on_error:\n  M1';
    expect(detectCompletionContext(t, t.length)).toMatchObject({ kind: 'gcode-command', prefix: 'M1' });
  });

  it('does not offer commands for a param outside a gcode block', () => {
    const t = '[stepper_x]\n  G2';
    expect(detectCompletionContext(t, t.length)?.kind).not.toBe('gcode-command');
  });

  it('does not offer commands in a non-macro section body', () => {
    const t = '[printer]\n  max_vel';
    expect(detectCompletionContext(t, t.length)).toMatchObject({ kind: 'param-key' });
  });

  it('stays out of Jinja', () => {
    const t = '[gcode_macro X]\ngcode:\n  {% if';
    expect(detectCompletionContext(t, t.length)).toBeNull();
  });

  it('stays out of a comment inside a gcode block', () => {
    const t = '[gcode_macro X]\ngcode:\n  # note';
    const ctx = detectCompletionContext(t, t.length);
    expect(ctx === null || ctx.kind !== 'gcode-command').toBe(true);
  });
});

describe('matchScore / rankCandidates', () => {
  it('scores exact > prefix > word boundary > substring', () => {
    expect(matchScore('stepper', 'stepper')).toBe(100);
    expect(matchScore('stepper_x', 'step')).toBe(80);
    expect(matchScore('tmc2209 stepper_x', 'stepper')).toBe(60);
    expect(matchScore('big_stepper_thing', 'stepper')).toBe(60);
    expect(matchScore('xxstepper', 'stepper')).toBe(40);
    expect(matchScore('nothing', 'zzz')).toBe(0);
  });

  it('is case-insensitive', () => {
    expect(matchScore('STEpper', 'step')).toBe(80);
  });

  it('drops non-matches and sorts by score', () => {
    const ranked = rankCandidates(
      [
        { label: 'big_stepper', insertText: 'x', kind: 'param-key', score: 0, rank: 0 },
        { label: 'stepper_x', insertText: 'x', kind: 'param-key', score: 0, rank: 1 },
      ],
      'stepper',
    );
    expect(ranked.map((c) => c.label)).toEqual(['stepper_x', 'big_stepper']);
  });

  it('keeps source order for equal scores', () => {
    const ranked = rankCandidates(
      [
        { label: 'a_x', insertText: 'x', kind: 'param-key', score: 0, rank: 0 },
        { label: 'b_x', insertText: 'x', kind: 'param-key', score: 0, rank: 1 },
      ],
      '_x',
    );
    expect(ranked.map((c) => c.label)).toEqual(['a_x', 'b_x']);
  });

  it('returns everything, alphabetically, for an empty prefix', () => {
    // Paths tie on score and rank, so the label is the final tie-break — a
    // predictable order for a list the user scans.
    expect(
      rankCandidates(
        candidatesFor(
          { kind: 'include-file', replaceStart: 0, replaceEnd: 0, prefix: '', trailing: '' },
          SOURCES,
        ),
        '',
      ).map((c) => c.label),
    ).toEqual(['macros/end.cfg', 'macros/start.cfg', 'mainsail.cfg']);
  });
});

describe('candidatesFor', () => {
  const ctx = (over: Partial<Parameters<typeof candidatesFor>[0]>) => ({
    kind: 'section-type' as const,
    replaceStart: 0,
    replaceEnd: 0,
    prefix: '',
    trailing: '',
    ...over,
  });

  it('ranks section types the project already defines last', () => {
    const candidates = rankCandidates(
      candidatesFor(ctx({ kind: 'section-type' }), {
        ...SOURCES,
        usedSectionTypes: ['stepper_x'],
      }),
      'step',
    );
    // stepper_x is the only project section AND the only schema type matching
    // 'step' here, so it survives — the demotion must not hide it.
    expect(candidates.map((c) => c.label)).toEqual(['Stepper X']);
    const withBoth = rankCandidates(
      candidatesFor(ctx({ kind: 'section-type' }), {
        ...SOURCES,
        usedSectionTypes: ['stepper_x'],
        schemas: { ...SCHEMAS, stepper_extra: section('stepper_extra') },
      }),
      'step',
    );
    // Unused types come first; a used one is still offered, just lower.
    expect(withBoth[0].label).toBe('stepper_extra');
    expect(withBoth.map((c) => c.label)).toContain('Stepper X');
  });

  it('closes the bracket for a section type', () => {
    const [first] = candidatesFor(ctx({ kind: 'section-type' }), SOURCES);
    expect(first.insertText).toMatch(/\]$/);
  });

  it('does not double an existing bracket', () => {
    const found = candidatesFor(ctx({ kind: 'section-type', trailing: ']' }), SOURCES).find(
      (c) => c.label === 'Stepper X',
    );
    expect(found?.insertText).toBe('stepper_x');
  });

  it('offers param keys with a colon for the enclosing section', () => {
    const candidates = candidatesFor(
      ctx({ kind: 'param-key', sectionType: 'stepper_x' }),
      SOURCES,
    );
    expect(candidates.map((c) => c.label)).toEqual(['microsteps', 'rotation_distance', 'stepper_type']);
    expect(candidates[0].insertText).toBe('microsteps: ');
    expect(candidates[0].detail).toContain('required');
  });

  it('ranks params already in the section last', () => {
    const candidates = rankCandidates(
      candidatesFor(ctx({ kind: 'param-key', sectionType: 'stepper_x' }), {
        ...SOURCES,
        usedParamKeys: ['microsteps'],
      }),
      '',
    );
    expect(candidates.map((c) => c.label)).toEqual(['rotation_distance', 'stepper_type', 'microsteps']);
  });

  it('offers nothing for an unknown section type', () => {
    expect(candidatesFor(ctx({ kind: 'param-key', sectionType: 'nope' }), SOURCES)).toEqual([]);
  });

  it('offers enum values only when the param has them', () => {
    expect(
      candidatesFor(ctx({ kind: 'param-value', sectionType: 'sensor', paramKey: 'sensor_type' }), SOURCES),
    ).toHaveLength(2);
    expect(
      candidatesFor(ctx({ kind: 'param-value', sectionType: 'stepper_x', paramKey: 'microsteps' }), SOURCES),
    ).toEqual([]);
  });

  it('puts project macros ahead of registry commands', () => {
    const candidates = candidatesFor(ctx({ kind: 'gcode-command' }), SOURCES);
    expect(candidates[0].label).toBe('CLEAN_NOZZLE');
    expect(candidates[0].detail).toContain('gcode_macro');
    expect(candidates.map((c) => c.label)).toContain('G28');
  });
});

describe('completionsAt', () => {
  it('returns ranked suggestions with the replacement range', () => {
    const { text, caret } = at('[stepper_x]\nmicro');
    const result = completionsAt(text, caret, SOURCES);
    expect(result?.context.kind).toBe('param-key');
    expect(result?.candidates[0].label).toBe('microsteps');
  });

  it('returns null when nothing matches', () => {
    const { text, caret } = at('[stepper_x]\nzzz');
    expect(completionsAt(text, caret, SOURCES)).toBeNull();
  });

  it('returns null when the caret is not completable', () => {
    expect(completionsAt('plain text', 5, SOURCES)).toBeNull();
  });

  it('caps the suggestion list', () => {
    const many: CompletionSources = {
      ...SOURCES,
      gcodeCommands: Array.from({ length: 200 }, (_, i) => `G${i}`),
    };
    const { text, caret } = at('[gcode_macro X]\ngcode:\n  G');
    expect(completionsAt(text, caret, many)?.candidates.length).toBe(50);
  });
});

describe('applyCandidate', () => {
  it('replaces the typed prefix and leaves the caret after the insertion', () => {
    const { text, caret } = at('[stepper_x]\nmicro');
    const result = completionsAt(text, caret, SOURCES)!;
    const applied = applyCandidate(text, result.context, result.candidates[0]);
    expect(applied.text).toBe('[stepper_x]\nmicrosteps: ');
    expect(applied.caret).toBe(applied.text.length);
  });

  it('keeps the closing bracket already on the line', () => {
    const { text, caret } = at('[step|]');
    const result = completionsAt(text, caret, SOURCES)!;
    const applied = applyCandidate(text, result.context, result.candidates[0]);
    expect(applied.text).toBe('[stepper_x]');
    expect(applied.caret).toBe('[stepper_x'.length);
  });

  it('completes a gcode command in place', () => {
    const { text, caret } = at('[gcode_macro X]\ngcode:\n  G2');
    const result = completionsAt(text, caret, SOURCES)!;
    const applied = applyCandidate(text, result.context, result.candidates[0]);
    expect(applied.text).toBe('[gcode_macro X]\ngcode:\n  G28');
    expect(applied.caret).toBe(applied.text.length);
  });

  it('completes an include path', () => {
    const { text, caret } = at('[include mac');
    const result = completionsAt(text, caret, SOURCES)!;
    const applied = applyCandidate(text, result.context, result.candidates[0]);
    expect(applied.text).toBe('[include macros/end.cfg]');
  });

  it('does not touch anything else in the document', () => {
    const text = '[stepper_x]\nmicro\n[printer]\nmax_velocity: 300';
    const result = completionsAt(text, text.indexOf('\nmicro') + 6, SOURCES)!;
    const applied = applyCandidate(text, result.context, result.candidates[0]);
    expect(applied.text.split('\n')[3]).toBe('max_velocity: 300');
    expect(applied.text.split('\n')[0]).toBe('[stepper_x]');
  });
});
