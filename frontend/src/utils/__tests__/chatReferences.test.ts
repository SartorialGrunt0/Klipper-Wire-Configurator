import { describe, expect, it } from 'vitest';

import type { ValidationError } from '../../types/config';
import type { SeverityVisibility } from '../validationVisibility';
import { ALL_VISIBLE } from '../validationVisibility';
import {
  MAX_REFERENCE_FINDINGS,
  addReference,
  buildReferenceContext,
  dedupeReferences,
  findingsForScope,
  mentionMatches,
  mentionQuery,
  nodeToReference,
  referenceLabel,
  selectionToReference,
  worstFindings,
  type ChatReference,
} from '../chatReferences';

// ── Fixtures ────────────────────────────────────────────────────────

const FILE = 'printer.cfg';
const MACRO_FILE = 'macros.cfg';

function lines(count: number, prefix = '  param'): string {
  return Array.from({ length: count }, (_, i) => `${prefix}${i + 1}: ${i + 1}`).join('\n');
}

function finding(over: Partial<ValidationError> = {}): ValidationError {
  return {
    severity: 'error',
    section: 'stepper_x',
    param: 'enable_pin',
    message: 'boom',
    line_number: 1,
    ...over,
  };
}

// ── selectionToReference ────────────────────────────────────────────

describe('selectionToReference', () => {
  it('captures a single highlighted line with a stable id', () => {
    const ref = selectionToReference(lines(5), FILE, 3, 3);
    expect(ref).not.toBeNull();
    expect(ref!.kind).toBe('lines');
    expect(ref!.file).toBe(FILE);
    expect(ref!.startLine).toBe(3);
    expect(ref!.endLine).toBe(3);
    expect(ref!.id).toBe('lines:printer.cfg:3-3');
  });

  it('captures a 30-line selection and keeps the excerpt', () => {
    const ref = selectionToReference(lines(40), FILE, 5, 34);
    expect(ref!.startLine).toBe(5);
    expect(ref!.endLine).toBe(34);
    expect(ref!.text).toContain('param5: 5');
    expect(ref!.text).toContain('param34: 34');
    // Bounded: neighbouring lines outside the range are excluded.
    expect(ref!.text).not.toContain('param35: 35');
    expect(ref!.text).not.toContain('param4: 4');
  });

  it('produces the same id for the same range regardless of text', () => {
    const a = selectionToReference(lines(40), FILE, 5, 34);
    const b = selectionToReference(
      Array.from({ length: 40 }, (_, i) => `different ${i + 1}`).join('\n'),
      FILE,
      5,
      34,
    );
    expect(a!.id).toBe(b!.id);
  });

  it('normalizes a reversed range', () => {
    const ref = selectionToReference(lines(10), FILE, 7, 2);
    expect(ref!.startLine).toBe(2);
    expect(ref!.endLine).toBe(7);
  });

  it('returns null for a whitespace-only selection', () => {
    expect(selectionToReference('   \n\t\n  ', FILE, 2, 4)).toBeNull();
  });

  it('returns null for an empty selection (collapsed caret)', () => {
    expect(selectionToReference('', FILE, 1, 1)).toBeNull();
  });

  it('returns null when the range falls outside the text', () => {
    expect(selectionToReference(lines(3), FILE, 9, 11)).toBeNull();
  });

  it('caps the excerpt so a huge selection cannot flood the prompt', () => {
    const huge = Array.from({ length: 5000 }, (_, i) => `line ${i + 1} ${'x'.repeat(80)}`).join('\n');
    const ref = selectionToReference(huge, FILE, 1, 5000);
    expect(ref!.text!.length).toBeLessThanOrEqual(8000);
  });
});

// ── nodeToReference ─────────────────────────────────────────────────

describe('nodeToReference', () => {
  it('turns a section node into a section reference', () => {
    const ref = nodeToReference({
      kind: 'section',
      id: 'section:macros.cfg#gcode_macro CLEAN_NOZZLE',
      label: 'gcode_macro CLEAN_NOZZLE',
      line: 12,
      file: MACRO_FILE,
      children: [],
    });
    expect(ref).toEqual({
      id: 'section:macros.cfg:gcode_macro CLEAN_NOZZLE',
      kind: 'section',
      file: MACRO_FILE,
      section: 'gcode_macro CLEAN_NOZZLE',
      line: 12,
    });
  });

  it('turns a param node into a param reference carrying its section', () => {
    const ref = nodeToReference({
      kind: 'param',
      id: 'param:macros.cfg#x#speed:40',
      label: 'speed',
      line: 40,
      file: MACRO_FILE,
      section: 'gcode_macro CLEAN_NOZZLE',
      children: [],
    });
    expect(ref).toEqual({
      id: 'param:macros.cfg:gcode_macro CLEAN_NOZZLE:speed:40',
      kind: 'param',
      file: MACRO_FILE,
      section: 'gcode_macro CLEAN_NOZZLE',
      param: 'speed',
      line: 40,
    });
  });

  it('turns a file node into a file reference', () => {
    const ref = nodeToReference({
      kind: 'file',
      id: 'file:printer.cfg',
      label: 'printer.cfg',
      file: FILE,
      children: [],
    });
    expect(ref).toEqual({ id: 'file:printer.cfg', kind: 'file', file: FILE });
  });

  it('returns null for a folder node (nothing attachable)', () => {
    expect(
      nodeToReference({ kind: 'folder', id: 'folder:sub', label: 'sub', children: [] }),
    ).toBeNull();
  });

  it('returns null for a node with no owning file', () => {
    expect(nodeToReference({ kind: 'section', id: 'x', label: 'x', line: 1, children: [] })).toBeNull();
  });
});

// ── worstFindings / findingsForScope ────────────────────────────────

describe('worstFindings', () => {
  it('orders error > warning > info, then by line', () => {
    const sorted = worstFindings([
      finding({ severity: 'info', line_number: 1 }),
      finding({ severity: 'error', line_number: 30 }),
      finding({ severity: 'warning', line_number: 20 }),
      finding({ severity: 'error', line_number: 10 }),
      finding({ severity: 'warning', line_number: 5 }),
    ]);
    expect(sorted.map((f) => `${f.severity}:${f.line_number}`)).toEqual([
      'error:10',
      'error:30',
      'warning:5',
      'warning:20',
      'info:1',
    ]);
  });
});

describe('findingsForScope', () => {
  const byFile: Record<string, { errors: ValidationError[] }> = {
    [FILE]: {
      errors: [
        finding({ line_number: 100, section: 'stepper_x' }),
        finding({ line_number: 120, section: 'stepper_x' }),
        finding({ line_number: 138, section: 'stepper_x', severity: 'warning' }),
        finding({ line_number: 139, section: 'stepper_x' }),
        finding({ line_number: 200, section: 'extruder' }),
      ],
    },
    [MACRO_FILE]: {
      errors: [finding({ line_number: 12, section: 'gcode_macro CLEAN_NOZZLE' })],
    },
  };

  it('clips a lines reference to its inclusive range', () => {
    const ref: ChatReference = { id: 'l', kind: 'lines', file: FILE, startLine: 120, endLine: 138 };
    const out = findingsForScope(ref, byFile, ALL_VISIBLE);
    expect(out.map((f) => f.line_number)).toEqual([120, 138]);
  });

  it('matches a section reference on the section name', () => {
    const ref: ChatReference = {
      id: 's',
      kind: 'section',
      file: MACRO_FILE,
      section: 'gcode_macro CLEAN_NOZZLE',
    };
    const out = findingsForScope(ref, byFile, ALL_VISIBLE);
    expect(out).toHaveLength(1);
    expect(out[0].line_number).toBe(12);
  });

  it('collects every finding in the file for a file reference', () => {
    const ref: ChatReference = { id: 'f', kind: 'file', file: FILE };
    const out = findingsForScope(ref, byFile, ALL_VISIBLE);
    expect(out).toHaveLength(5);
  });

  it('respects the validation-visibility settings — hidden severities are never sent', () => {
    const ref: ChatReference = { id: 'f', kind: 'file', file: FILE };
    const hidden: SeverityVisibility = {
      enabled: true,
      showError: true,
      showWarning: false,
      showInfo: false,
    };
    const out = findingsForScope(ref, byFile, hidden);
    expect(out.every((f) => f.severity === 'error')).toBe(true);
    expect(out).toHaveLength(4);
  });

  it('sends nothing at all when validation is switched off', () => {
    const ref: ChatReference = { id: 'f', kind: 'file', file: FILE };
    const off: SeverityVisibility = { ...ALL_VISIBLE, enabled: false };
    expect(findingsForScope(ref, byFile, off)).toEqual([]);
  });

  it('caps the result at 20, worst first', () => {
    const many = Array.from({ length: 60 }, (_, i) =>
      finding({ line_number: i + 1, severity: i === 59 ? 'error' : 'info' }),
    );
    const out = findingsForScope(
      { id: 'f', kind: 'file', file: FILE },
      { [FILE]: { errors: many } },
      ALL_VISIBLE,
    );
    expect(out).toHaveLength(MAX_REFERENCE_FINDINGS);
    expect(out[0].severity).toBe('error');
  });

  it('returns [] for an unknown file rather than throwing', () => {
    expect(
      findingsForScope({ id: 'x', kind: 'file', file: 'nope.cfg' }, byFile, ALL_VISIBLE),
    ).toEqual([]);
  });
});

// ── addReference / dedupeReferences ─────────────────────────────────

describe('addReference', () => {
  it('appends a new reference', () => {
    const a: ChatReference = { id: 'a', kind: 'file', file: FILE };
    const b: ChatReference = { id: 'b', kind: 'file', file: MACRO_FILE };
    expect(addReference([a], b).map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('is a no-op for a reference already pinned (by id)', () => {
    const a: ChatReference = { id: 'a', kind: 'file', file: FILE };
    const again: ChatReference = { id: 'a', kind: 'file', file: FILE };
    expect(addReference([a], again)).toHaveLength(1);
  });
});

describe('dedupeReferences', () => {
  it('collapses a section reference already covered by a lines reference', () => {
    const out = dedupeReferences([
      { id: 'lines:printer.cfg:100-140', kind: 'lines', file: FILE, startLine: 100, endLine: 140 },
      { id: 'section:printer.cfg:stepper_x', kind: 'section', file: FILE, section: 'stepper_x' },
    ]);
    expect(out.map((r) => r.id)).toEqual(['lines:printer.cfg:100-140']);
  });

  it('keeps a section reference whose line falls outside the lines range', () => {
    const out = dedupeReferences([
      { id: 'lines:printer.cfg:100-140', kind: 'lines', file: FILE, startLine: 100, endLine: 140 },
      { id: 'section:printer.cfg:extruder', kind: 'section', file: FILE, section: 'extruder', line: 300 },
    ]);
    expect(out).toHaveLength(2);
  });

  it('collapses a param reference already covered by a lines reference', () => {
    const out = dedupeReferences([
      { id: 'lines:printer.cfg:100-140', kind: 'lines', file: FILE, startLine: 100, endLine: 140 },
      { id: 'param:printer.cfg:stepper_x:enable_pin:120', kind: 'param', file: FILE, param: 'enable_pin', line: 120 },
    ]);
    expect(out.map((r) => r.id)).toEqual(['lines:printer.cfg:100-140']);
  });

  it('keeps same-kind references in different files', () => {
    const out = dedupeReferences([
      { id: 'section:printer.cfg:stepper_x', kind: 'section', file: FILE, section: 'stepper_x' },
      { id: 'section:macros.cfg:stepper_x', kind: 'section', file: MACRO_FILE, section: 'stepper_x' },
    ]);
    expect(out).toHaveLength(2);
  });

  it('preserves order and never mutates the input', () => {
    const input: ChatReference[] = [
      { id: 'a', kind: 'file', file: FILE },
      { id: 'b', kind: 'file', file: FILE },
    ];
    const out = dedupeReferences(input);
    expect(input).toHaveLength(2);
    expect(out.map((r) => r.id)).toEqual(['a', 'b']);
  });
});

// ── referenceLabel ──────────────────────────────────────────────────

describe('referenceLabel', () => {
  it('renders a section reference as file:[section]', () => {
    expect(
      referenceLabel({
        id: 's',
        kind: 'section',
        file: MACRO_FILE,
        section: 'gcode_macro CLEAN_NOZZLE',
      }),
    ).toBe('macros.cfg:[gcode_macro CLEAN_NOZZLE]');
  });

  it('renders a multi-line range as file:start-end', () => {
    expect(
      referenceLabel({ id: 'l', kind: 'lines', file: FILE, startLine: 120, endLine: 138 }),
    ).toBe('printer.cfg:120-138');
  });

  it('renders a single line without a range', () => {
    expect(referenceLabel({ id: 'l', kind: 'lines', file: FILE, startLine: 42, endLine: 42 })).toBe(
      'printer.cfg:42',
    );
  });

  it('renders a finding reference as severity · line N', () => {
    expect(
      referenceLabel({ id: 'x', kind: 'finding', file: FILE, severity: 'error', line: 42 }),
    ).toBe('error · line 42');
  });

  it('renders a param reference with its section', () => {
    expect(
      referenceLabel({
        id: 'p',
        kind: 'param',
        file: FILE,
        section: 'stepper_x',
        param: 'enable_pin',
      }),
    ).toBe('printer.cfg:[stepper_x] enable_pin');
  });

  it('renders a file reference by name', () => {
    expect(referenceLabel({ id: 'f', kind: 'file', file: MACRO_FILE })).toBe('macros.cfg');
  });
});

// ── buildReferenceContext / referenceToPromptBlock ───────────────────

describe('buildReferenceContext', () => {
  it('attaches the in-scope findings to each reference', () => {
    const refs: ChatReference[] = [
      { id: 'l', kind: 'lines', file: FILE, startLine: 115, endLine: 145, text: lines(40) },
    ];
    const out = buildReferenceContext(
      refs,
      { [FILE]: { errors: [finding({ line_number: 120 }), finding({ line_number: 999 })] } },
      ALL_VISIBLE,
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.findings?.map((f) => f.line_number)).toEqual([120]);
  });

  it('leaves findings undefined when the scope has none', () => {
    const out = buildReferenceContext(
      [{ id: 'f', kind: 'file', file: MACRO_FILE }],
      { [FILE]: { errors: [finding({ line_number: 1 })] } },
      ALL_VISIBLE,
    );
    expect(out[0]?.findings).toBeUndefined();
  });
});

// The reference → prompt-block format is asserted backend-side
// (`tests/test_ai_chat_routes.py`) — see the note in utils/chatReferences.ts
// on why exactly one renderer exists and why it lives there.

// ── mentionQuery / mentionMatches ───────────────────────────────────

describe('mentionQuery', () => {
  it('returns an empty query right after typing @', () => {
    expect(mentionQuery('look at @', 9)).toBe('');
  });

  it('returns the token being typed', () => {
    expect(mentionQuery('look at @stepper', 16)).toBe('stepper');
  });

  it('stops the query at whitespace', () => {
    expect(mentionQuery('@stepper_x is fine', 18)).toBeNull();
  });

  it('ignores an @ in the middle of a word (email-shaped text)', () => {
    expect(mentionQuery('mail me at bob@example', 22)).toBeNull();
  });

  it('accepts an @ after a bracket or start of line', () => {
    expect(mentionQuery('(@step', 6)).toBe('step');
    expect(mentionQuery('@step', 5)).toBe('step');
  });

  it('uses only the text before the caret', () => {
    expect(mentionQuery('@abc def', 3)).toBe('ab');
  });

  it('rejects a closed mention (whitespace already ended it)', () => {
    expect(mentionQuery('@stepper_x ', 11)).toBeNull();
  });

  it('returns null when there is no @ at all', () => {
    expect(mentionQuery('hello there', 11)).toBeNull();
  });

  it('tolerates a caret past the end of the text', () => {
    expect(mentionQuery('@abc', 99)).toBe('abc');
  });
});

describe('mentionMatches', () => {
  const sources = [
    { kind: 'file' as const, file: 'printer.cfg', label: 'printer.cfg' },
    { kind: 'section' as const, file: 'printer.cfg', label: 'stepper_x' },
    { kind: 'section' as const, file: 'macros.cfg', label: 'gcode_macro CLEAN_NOZZLE' },
    { kind: 'param' as const, file: 'printer.cfg', label: 'max_accel' },
  ];

  it('returns everything for an empty query', () => {
    expect(mentionMatches('', sources)).toHaveLength(4);
  });

  it('filters case-insensitively on a substring', () => {
    const out = mentionMatches('step', sources);
    expect(out.map((s) => s.label)).toEqual(['stepper_x']);
  });

  it('matches inside a section name', () => {
    const out = mentionMatches('clean', sources);
    expect(out.map((s) => s.label)).toEqual(['gcode_macro CLEAN_NOZZLE']);
  });

  it('caps the list', () => {
    expect(mentionMatches('', sources, 2)).toHaveLength(2);
  });

  it('returns [] when nothing matches', () => {
    expect(mentionMatches('zzz', sources)).toEqual([]);
  });
});
