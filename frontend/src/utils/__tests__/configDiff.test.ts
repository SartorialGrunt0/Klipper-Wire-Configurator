import { describe, expect, it } from 'vitest';
import {
  normalizeDiffText,
  normalizeChangeLines,
  parsePatch,
  countChangedLines,
  createConfigPatch,
  documentLineNumbers,
} from '@/utils/configDiff';

describe('normalizeDiffText', () => {
  it('collapses CRLF to LF', () => {
    expect(normalizeDiffText('a\r\nb\r\n')).toBe('a\nb\n');
  });

  it('strips trailing whitespace per line', () => {
    expect(normalizeDiffText('a  \nb\t\nc')).toBe('a\nb\nc');
  });

  it('collapses consecutive blank lines to a single blank line', () => {
    expect(normalizeDiffText('a\n\n\n\nb')).toBe('a\n\nb');
  });
});

describe('normalizeChangeLines', () => {
  // One SIDE of a change, put into the same space `normalizeDiffText` puts a
  // document in: the pane's frame diff is normalized, the row's own diff is
  // raw, and ownership is matched by content between the two.
  it('strips trailing whitespace and a stray CR per line', () => {
    expect(normalizeChangeLines(['step_pin: PA0 ', 'gcode:\t', 'x\r']))
      .toEqual(['step_pin: PA0', 'gcode:', 'x']);
  });

  it('collapses a run of blank lines to one', () => {
    expect(normalizeChangeLines(['a', '', '', '', 'b'])).toEqual(['a', '', 'b']);
  });

  it('keeps a single blank line and is idempotent', () => {
    const once = normalizeChangeLines(['a', '', 'b', '']);
    expect(once).toEqual(['a', '', 'b', '']);
    expect(normalizeChangeLines(once)).toEqual(once);
  });

  it('leaves content untouched when there is nothing to normalize', () => {
    expect(normalizeChangeLines(['[stepper_x]', 'microsteps: 32']))
      .toEqual(['[stepper_x]', 'microsteps: 32']);
  });
});

describe('parsePatch', () => {
  const patch = [
    '--- original',
    '+++ current',
    '@@ -1,3 +1,3 @@',
    ' context line',
    '-removed line',
    '+added line',
    ' another context',
  ].join('\n');

  it('classifies header, added, removed, and context lines', () => {
    const lines = parsePatch(patch);
    expect(lines).toEqual([
      { type: 'header', content: '@@ -1,3 +1,3 @@' },
      { type: 'context', content: 'context line' },
      { type: 'removed', content: 'removed line' },
      { type: 'added', content: 'added line' },
      { type: 'context', content: 'another context' },
    ]);
  });

  it('ignores --- and +++ file header lines', () => {
    const lines = parsePatch(patch);
    expect(lines.some((l) => l.content === 'original')).toBe(false);
    expect(lines.some((l) => l.content === 'current')).toBe(false);
  });

  it('returns empty array for empty input', () => {
    expect(parsePatch('')).toEqual([]);
  });
});

describe('countChangedLines', () => {
  it('counts added and removed lines, not context or headers', () => {
    const patch = [
      '@@ -1,5 +1,5 @@',
      ' context',
      '-gone',
      '+new',
      ' context',
      '-gone2',
    ].join('\n');
    expect(countChangedLines(patch)).toBe(3);
  });

  it('ignores +++ / --- file headers', () => {
    const patch = ['--- a/file', '+++ b/file', '+real'].join('\n');
    expect(countChangedLines(patch)).toBe(1);
  });
});

describe('createConfigPatch', () => {
  it('produces a two-file patch with the given labels', () => {
    const patch = createConfigPatch(
      'printer.cfg',
      '[printer]\nkinematics: cartesian\n',
      '[printer]\nkinematics: corexy\n',
      'original',
      'current',
    );
    expect(patch).toContain('--- printer.cfg');
    expect(patch).toContain('+++ printer.cfg');
    expect(patch).toContain('-kinematics: cartesian');
    expect(patch).toContain('+kinematics: corexy');
  });

  it('returns a patch with only context when texts are identical', () => {
    const text = '[mcu]\nserial: xyz\n';
    const patch = createConfigPatch('a.cfg', text, text);
    expect(countChangedLines(patch)).toBe(0);
  });
});

/**
 * The pane stands in for the buffer, so its gutter has to be the editor's:
 * running numbers in the document, not `@@` coordinates (Cliff, 2026-10-04).
 */
describe('documentLineNumbers', () => {
  it('counts the AFTER document, and leaves removed rows blank', () => {
    const lines = parsePatch([
      '@@ -1,4 +1,5 @@',
      ' [printer]',
      '-max_accel: 1000',
      '+max_accel: 3000',
      '+square_corner_velocity: 5',
      ' max_velocity: 300',
    ].join('\n'));

    // header · context · removed · added · added · context
    expect(documentLineNumbers(lines)).toEqual([null, 1, null, 2, 3, 4]);
  });

  it('keeps counting across concatenated hunks, from each hunk\'s own start', () => {
    const lines = parsePatch([
      '@@ -10,3 +10,3 @@',
      ' a',
      '-b',
      '+B',
      '@@ -50,3 +51,3 @@',
      ' c',
      '-d',
      '+D',
    ].join('\n'));

    expect(documentLineNumbers(lines)).toEqual([null, 10, null, 11, null, 51, null, 52]);
  });

  it('never numbers a row in a hunk that only deletes', () => {
    const lines = parsePatch(['@@ -7,3 +7,1 @@', ' a', '-b', '-c', ' d'].join('\n'));
    expect(documentLineNumbers(lines)).toEqual([null, 7, null, null, 8]);
  });

  it('agrees with the editor: the frame\'s numbers are 1..N down the document', () => {
    const before = '[printer]\nmax_accel: 1000\nmax_velocity: 300\n';
    const after = '[printer]\nmax_accel: 3000\nadded: 1\nmax_velocity: 300\n';
    const lines = parsePatch(createConfigPatch('printer.cfg', before, after, 'a', 'b', 1_000_000));

    const numbers = documentLineNumbers(lines);
    const changed = lines
      .map((line, index) => ({ line, number: numbers[index] }))
      .filter((row) => row.line.type === 'added')
      .map((row) => row.number);
    // The two added lines are lines 2 and 3 of the document the buffer holds.
    expect(changed).toEqual([2, 3]);
  });
});
