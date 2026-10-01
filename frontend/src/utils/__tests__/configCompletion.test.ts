import { describe, it, expect } from 'vitest';
import {
  detectCompletionContext,
  sectionTypeOf,
  matchScore,
  rankCandidates,
  candidatesFor,
  completionsAt,
  acceptAt,
  applyCandidate,
  ghostRemainder,
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

  it('stays out of comments', () => {
    expect(detectCompletionContext('[stepper_x]\n#micro', 18)).toBeNull();
    expect(detectCompletionContext('[stepper_x]\n  # micro', 20)).toBeNull();
    expect(detectCompletionContext('[stepper_x]\n#max_velocity: 3', 25)).toBeNull();
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
          { kind: 'include-file', replaceStart: 0, replaceEnd: 0, prefix: '', trailing: '', tokenEnd: 0 },
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
    tokenEnd: 0,
    ...over,
  } as Parameters<typeof candidatesFor>[0]);

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

  it('does not double a bracket when the candidate list is built directly', () => {
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

  it('marks params the section already defines and ranks them last', () => {
    const candidates = rankCandidates(
      candidatesFor(ctx({ kind: 'param-key', sectionType: 'stepper_x' }), {
        ...SOURCES,
        usedParamKeys: ['microsteps', 'stepper_type'],
      }),
      '',
    );
    expect(candidates.map((c) => c.label)).toEqual(['rotation_distance', 'microsteps', 'stepper_type']);
    expect(candidates.find((c) => c.label === 'microsteps')?.alreadySet).toBe(true);
    expect(candidates.find((c) => c.label === 'rotation_distance')?.alreadySet).toBe(false);
    expect(candidates.find((c) => c.label === 'microsteps')?.detail).toContain('already set');
  });

  it('leaves the ghost a param to suggest even when some are set', () => {
    const candidates = rankCandidates(
      candidatesFor(ctx({ kind: 'param-key', sectionType: 'stepper_x' }), {
        ...SOURCES,
        usedParamKeys: ['microsteps'],
      }),
      'micro',
    );
    // Only the set param matches 'micro' — the ghost has nothing to offer it.
    expect(candidates.every((c) => c.alreadySet)).toBe(true);
  });

  it('offers everything when the section is empty', () => {
    const candidates = candidatesFor(ctx({ kind: 'param-key', sectionType: 'stepper_x' }), SOURCES);
    expect(candidates.map((c) => c.label)).toEqual(['microsteps', 'rotation_distance', 'stepper_type']);
  });

  it('offers nothing for an unknown section type', () => {
    expect(candidatesFor(ctx({ kind: 'param-key', sectionType: 'nope' }), SOURCES)).toEqual([]);
  });

  it('offers enum values for an enum param', () => {
    const candidates = candidatesFor(
      ctx({ kind: 'param-value', sectionType: 'sensor', paramKey: 'sensor_type' }),
      SOURCES,
    );
    expect(candidates.map((c) => c.label)).toEqual([
      'EPCOS 100K B57560G104F',
      'NTC 100K MGB18-104F39050L32',
    ]);
  });

  it('offers the schema default for a param with one', () => {
    const candidates = candidatesFor(
      ctx({ kind: 'param-value', sectionType: 'stepper_x', paramKey: 'microsteps' }),
      SOURCES,
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ label: '16', insertText: '16', isDefault: true });
  });

  it('ranks the default above the enum values', () => {
    const schemas = {
      ...SCHEMAS,
      sensor: section('sensor', {
        params: [param('sensor_type', { type: 'enum', default: 'NTC 100K MGB18-104F39050L32', enum_values: ['EPCOS 100K B57560G104F', 'NTC 100K MGB18-104F39050L32'] })],
      }),
    };
    const candidates = rankCandidates(
      candidatesFor(ctx({ kind: 'param-value', sectionType: 'sensor', paramKey: 'sensor_type' }), {
        ...SOURCES,
        schemas,
      }),
      '',
    );
    expect(candidates.map((c) => c.label)).toEqual([
      'NTC 100K MGB18-104F39050L32',
      'EPCOS 100K B57560G104F',
    ]);
  });

  it('does not duplicate the default when it is also an enum value', () => {
    const schemas = {
      ...SCHEMAS,
      mcu: section('mcu', {
        params: [param('restart_method', { type: 'enum', default: 'arduino', enum_values: ['arduino', 'command'] })],
      }),
    };
    const candidates = candidatesFor(ctx({ kind: 'param-value', sectionType: 'mcu', paramKey: 'restart_method' }), {
      ...SOURCES,
      schemas,
    });
    expect(candidates.map((c) => c.label)).toEqual(['arduino', 'command']);
    expect(candidates.filter((c) => c.isDefault)).toHaveLength(1);
  });

  it('offers nothing for a param with neither default nor enum', () => {
    expect(
      candidatesFor(ctx({ kind: 'param-value', sectionType: 'stepper_x', paramKey: 'stepper_type' }), SOURCES),
    ).toEqual([]);
  });

  it('puts project macros ahead of registry commands', () => {
    const candidates = candidatesFor(ctx({ kind: 'gcode-command' }), SOURCES);
    expect(candidates[0].label).toBe('CLEAN_NOZZLE');
    expect(candidates[0].detail).toContain('gcode_macro');
    expect(candidates.map((c) => c.label)).toContain('G28');
  });
});

describe('matchScore — tiers', () => {
  it('scores exact > prefix > word boundary > substring', () => {
    expect(matchScore('max_velocity', 'max_velocity')).toBe(100);
    expect(matchScore('max_velocity', 'max_')).toBe(80);
    expect(matchScore('max_velocity', 'velocity')).toBe(60);
    expect(matchScore('max_velocity', 'locity')).toBe(40);
    expect(matchScore('max_velocity', 'zzz')).toBe(0);
  });

  it('matches a single character by prefix only', () => {
    // The reported bug: 'r' is *inside* canbus_inte[R]face, and the substring
    // tier offered it under [mcu] while the user was typing a param name.
    expect(matchScore('canbus_interface', 'r')).toBe(0);
    expect(matchScore('restart_method', 'r')).toBe(80);
    expect(matchScore('max_velocity', 'v')).toBe(0);
    expect(matchScore('rotation_distance', 'd')).toBe(0);
  });

  it('keeps the weaker tiers from two characters on', () => {
    expect(matchScore('rotation_distance', 'distance')).toBe(60);
    expect(matchScore('rotation_distance', 'tation')).toBe(40);
  });
});

describe('ghostRemainder', () => {
  it('strips the typed part, case-insensitively', () => {
    expect(ghostRemainder('microsteps: ', 'mic')).toBe('rosteps: ');
    expect(ghostRemainder('stepper_x', 'STEP')).toBe('per_x');
  });

  it('is the whole insertion for an empty prefix', () => {
    expect(ghostRemainder('16', '')).toBe('16');
  });

  it('never doubles a word (the del + delta_radius report)', () => {
    // The old ghost was insertText.slice(prefix.length) — correct only for a
    // prefix match, which is exactly why only prefix matches may ghost.
    expect(ghostRemainder('delta_radius', 'del')).toBe('ta_radius');
    expect(ghostRemainder('delta_radius', 'tail')).toBe('delta_radius');
  });
});

describe('completionsAt — the ghost follows the token, not the caret', () => {
  it('offers the ghost with the caret at the end of the token', () => {
    const { text, caret } = at('[stepper_x]\nmic');
    const result = completionsAt(text, caret, SOURCES)!;
    expect(result.context.kind).toBe('param-key');
    expect(result.ghost?.label).toBe('microsteps');
    expect(result.ghostText).toBe('rosteps: ');
    expect(result.accepts).toBe(true);
  });

  it('still offers the ghost with the caret inside the token', () => {
    const { text, caret } = at('[stepper_x]\nmi|c');
    const result = completionsAt(text, caret, SOURCES)!;
    expect(result.context.prefix).toBe('mic');
    expect(result.ghostText).toBe('rosteps: ');
  });

  it('replaces the WHOLE token, so a mid-token accept cannot splice', () => {
    const { text, caret } = at('[stepper_x]\nmi|c');
    const result = completionsAt(text, caret, SOURCES)!;
    expect(result.context.replaceStart).toBe(text.indexOf('mic'));
    expect(result.context.replaceEnd).toBe(text.length);
    const applied = applyCandidate(text, result.context, result.ghost!);
    expect(applied.text).toBe('[stepper_x]\nmicrosteps: ');
  });

  it('draws the ghost at the end of the token, not at the caret', () => {
    const { text, caret } = at('[stepper_x]\nmi|c');
    expect(completionsAt(text, caret, SOURCES)!.context.tokenEnd).toBe(text.length);
  });

  it('keeps the ghost when text follows the caret on the line', () => {
    const { text, caret } = at('[stepper_x]\nmic| ; note');
    const result = completionsAt(text, caret, SOURCES)!;
    expect(result.ghostText).toBe('rosteps: ');
    expect(result.context.trailing).toBe(' ; note');
  });

  it('says nothing for a token that already matches a name', () => {
    const { text, caret } = at('[stepper_x]\nmicrosteps');
    // Nothing left to add beyond the separator on a key that is fully typed.
    expect(completionsAt(text, caret, SOURCES)!.ghostText).toBe(': ');
  });

  it('fills nothing in on a blank line inside a section', () => {
    const { text, caret } = at('[stepper_x]\n');
    const result = completionsAt(text, caret, SOURCES)!;
    // The list still exists for an explicit Ctrl+Space, but nothing is ghosted
    // and the accept key must not fire.
    expect(result.ghost).toBeNull();
    expect(result.accepts).toBe(false);
    expect(result.candidates.map((c) => c.label)).toContain('microsteps');
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

  it('still suggests at the end of a line that is not the last one', () => {
    const text = '[stepper_x]\nmicro\n[printer]\nmax_velocity: 300';
    const result = completionsAt(text, text.indexOf('\nmicro') + 6, SOURCES);
    expect(result?.ghost?.label).toBe('microsteps');
  });
});

describe('acceptAt — the right arrow', () => {
  it('accepts at the end of the token', () => {
    const { text, caret } = at('[stepper_x]\nmic');
    expect(acceptAt(text, caret, SOURCES)).toEqual({
      text: '[stepper_x]\nmicrosteps: ',
      caret: '[stepper_x]\nmicrosteps: '.length,
    });
  });

  it('does not accept while the caret is inside the token', () => {
    const { text, caret } = at('[stepper_x]\nmi|c');
    expect(acceptAt(text, caret, SOURCES)).toBeNull();
  });

  it('does not accept when text follows the token on the line', () => {
    const { text, caret } = at('[stepper_x]\nmic| ; note');
    expect(acceptAt(text, caret, SOURCES)).toBeNull();
  });

  it('accepts a param and then its default value — two presses, no keystroke between', () => {
    const { text, caret } = at('[stepper_x]\nmic');
    const first = acceptAt(text, caret, SOURCES)!;
    expect(first.text).toBe('[stepper_x]\nmicrosteps: ');
    const second = acceptAt(first.text, first.caret, SOURCES)!;
    expect(second.text).toBe('[stepper_x]\nmicrosteps: 16');
  });

  it('offers nothing on the second press when the param has no default', () => {
    const schemas = {
      ...SCHEMAS,
      stepper_x: section('stepper_x', { params: [param('stepper_type')] }),
    };
    const { text, caret } = at('[stepper_x]\nstep');
    const first = acceptAt(text, caret, { ...SOURCES, schemas })!;
    expect(first.text).toBe('[stepper_x]\nstepper_type: ');
    expect(acceptAt(first.text, first.caret, { ...SOURCES, schemas })).toBeNull();
  });
});

describe('applyCandidate', () => {
  it('replaces the typed prefix and leaves the caret after the insertion', () => {
    const { text, caret } = at('[stepper_x]\nmicro');
    const result = completionsAt(text, caret, SOURCES)!;
    const applied = applyCandidate(text, result.context, result.ghost!);
    expect(applied.text).toBe('[stepper_x]\nmicrosteps: ');
    expect(applied.caret).toBe(applied.text.length);
  });

  it('does not double the closing bracket on a header', () => {
    const { text, caret } = at('[step|]');
    const result = completionsAt(text, caret, SOURCES)!;
    expect(result.ghostText).toBe('per_x');
    expect(result.context.trailing).toBe(']');
    const applied = applyCandidate(text, result.context, result.ghost!);
    expect(applied.text).toBe('[stepper_x]');
  });

  it('completes a gcode command in place', () => {
    const { text, caret } = at('[gcode_macro X]\ngcode:\n  G2');
    const result = completionsAt(text, caret, SOURCES)!;
    const applied = applyCandidate(text, result.context, result.ghost!);
    expect(applied.text).toBe('[gcode_macro X]\ngcode:\n  G28');
  });

  it('completes an include path', () => {
    const { text, caret } = at('[include mac');
    const result = completionsAt(text, caret, SOURCES)!;
    const applied = applyCandidate(text, result.context, result.ghost!);
    expect(applied.text).toBe('[include macros/end.cfg]');
  });

  it('does not touch anything else in the document', () => {
    const text = '[stepper_x]\nmicro\n[printer]\nmax_velocity: 300';
    const result = completionsAt(text, text.indexOf('\nmicro') + 6, SOURCES)!;
    const applied = applyCandidate(text, result.context, result.ghost!);
    expect(applied.text.split('\n')[3]).toBe('max_velocity: 300');
    expect(applied.text.split('\n')[0]).toBe('[stepper_x]');
  });
});
