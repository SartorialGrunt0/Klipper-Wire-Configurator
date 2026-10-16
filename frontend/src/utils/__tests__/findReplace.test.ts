import { describe, it, expect } from 'vitest';
import {
  findHits,
  findAbsoluteHits,
  countHits,
  replaceAll,
  replaceOne,
} from '../findReplace';

const DOC = ['[stepper_x]', 'microsteps: 16', 'max_velocity: 300  # max_velocity', '', 'max_accel: 3000'].join('\n');

describe('findHits', () => {
  it('finds every occurrence on a line, not just the first', () => {
    // The old search used indexOf once per line, so this returned one row.
    expect(findHits('velocity = velocity + velocity', 'velocity')).toEqual([
      { line: 1, start: 0, end: 8 },
      { line: 1, start: 11, end: 19 },
      { line: 1, start: 22, end: 30 },
    ]);
  });

  it('reports 1-based lines and line-relative offsets', () => {
    expect(findHits(DOC, 'max_velocity')).toEqual([
      { line: 3, start: 0, end: 12 },
      { line: 3, start: 21, end: 33 },
    ]);
  });

  it('is case-insensitive by default and preserves nothing about the match', () => {
    expect(findHits('Max_Accel: 1', 'max_accel')).toEqual([{ line: 1, start: 0, end: 9 }]);
  });

  it('honours match case', () => {
    expect(findHits('Max_Accel: 1', 'max_accel', { caseSensitive: true })).toEqual([]);
    expect(findHits('max_accel: 1', 'max_accel', { caseSensitive: true })).toEqual([
      { line: 1, start: 0, end: 9 },
    ]);
  });

  it('treats the query as literal text, not a pattern', () => {
    expect(findHits('a.b aXb', '.')).toEqual([{ line: 1, start: 1, end: 2 }]);
  });

  it('does not report overlapping matches', () => {
    expect(findHits('aaa', 'aa')).toEqual([{ line: 1, start: 0, end: 2 }]);
  });

  it('skips matches that are not whole words when asked', () => {
    expect(findHits('max max_velocity xmax', 'max', { wholeWord: true })).toEqual([
      { line: 1, start: 0, end: 3 },
    ]);
  });

  it('treats hyphens and colons as non-word characters', () => {
    expect(findHits('a-max a:max', 'max', { wholeWord: true })).toHaveLength(2);
  });

  it('finds matches on the first and last line', () => {
    expect(findHits('x\ny\nx', 'x')).toEqual([
      { line: 1, start: 0, end: 1 },
      { line: 3, start: 0, end: 1 },
    ]);
  });

  it('returns nothing for an empty query', () => {
    expect(findHits(DOC, '')).toEqual([]);
    expect(findAbsoluteHits(DOC, '')).toEqual([]);
  });

  it('counts hits', () => {
    expect(countHits(DOC, 'max_')).toBe(3);
  });
});

describe('replaceAll', () => {
  it('replaces every occurrence and reports the count', () => {
    const result = replaceAll('a b a b a', 'a', 'X');
    expect(result).toEqual({ text: 'X b X b X', count: 3 });
  });

  it('replaces case-insensitively without disturbing untouched text', () => {
    const result = replaceAll('Max_Accel: 1\nmax_accel: 2', 'max_accel', 'accel', { caseSensitive: false });
    expect(result).toEqual({ text: 'accel: 1\naccel: 2', count: 2 });
  });

  it('inserts the replacement literally', () => {
    expect(replaceAll('a', 'a', '$& \\1 $1')).toEqual({ text: '$& \\1 $1', count: 1 });
  });

  it('is a no-op with a count of 0 when nothing matches', () => {
    expect(replaceAll(DOC, 'nope', 'x')).toEqual({ text: DOC, count: 0 });
  });

  it('supports an empty replacement (deletion)', () => {
    expect(replaceAll('max_x max_y', 'max_', '')).toEqual({ text: 'x y', count: 2 });
  });

  it('keeps line structure intact', () => {
    const result = replaceAll(DOC, 'max_velocity', 'velocity');
    expect(result.text.split('\n')).toHaveLength(5);
    expect(result.text).toContain('velocity: 300  # velocity');
  });
});

describe('replaceOne', () => {
  it('replaces the match a result row points at', () => {
    const target = { line: 3, start: 21, end: 33 }; // the comment occurrence
    expect(replaceOne(DOC, 'max_velocity', 'velocity', {}, target)).toEqual({
      text: '[stepper_x]\nmicrosteps: 16\nmax_velocity: 300  # velocity\n\nmax_accel: 3000',
      count: 1,
    });
  });

  it('replaces the first occurrence when the row points at it', () => {
    expect(replaceOne(DOC, 'max_velocity', 'velocity', {}, { line: 3, start: 0, end: 12 }).count).toBe(1);
  });

  it('refuses a stale row instead of corrupting the line', () => {
    const stale = { line: 3, start: 5, end: 17 };
    expect(replaceOne(DOC, 'max_velocity', 'velocity', {}, stale)).toEqual({ text: DOC, count: 0 });
  });

  it('refuses a row pointing past the end of the text', () => {
    expect(replaceOne(DOC, 'max_velocity', 'v', {}, { line: 99, start: 0, end: 12 }).count).toBe(0);
  });

  it('refuses when the row is not a whole-word match', () => {
    const text = 'xmax_velocity';
    expect(replaceOne(text, 'max_velocity', 'v', { wholeWord: true }, { line: 1, start: 1, end: 13 }).count).toBe(0);
  });

  it('replaces exactly one occurrence even when the line has several', () => {
    const text = 'max max max';
    const result = replaceOne(text, 'max', 'X', {}, { line: 1, start: 4, end: 7 });
    expect(result).toEqual({ text: 'max X max', count: 1 });
  });
});
