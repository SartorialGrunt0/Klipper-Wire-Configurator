import { describe, it, expect } from 'vitest';
import { caretLineColumn, columnToX, caretOffsetIn, type CaretMetrics } from '../caretGeometry';

const METRICS: CaretMetrics = {
  lineHeight: 22.75,
  paddingTop: 16,
  paddingLeft: 16,
  charWidth: 8.4,
  tabSize: 4,
};

describe('caretLineColumn', () => {
  it('reports the first line at offset 0', () => {
    expect(caretLineColumn('abc\ndef', 0)).toEqual({ lineIndex: 0, column: 0 });
  });

  it('counts columns inside a line', () => {
    expect(caretLineColumn('abc\ndef', 2)).toEqual({ lineIndex: 0, column: 2 });
  });

  it('moves to the next line after a newline', () => {
    expect(caretLineColumn('abc\ndef', 4)).toEqual({ lineIndex: 1, column: 0 });
    expect(caretLineColumn('abc\ndef', 7)).toEqual({ lineIndex: 1, column: 3 });
  });

  it('handles a trailing newline (the caret on the empty last line)', () => {
    expect(caretLineColumn('abc\n', 4)).toEqual({ lineIndex: 1, column: 0 });
  });

  it('clamps out-of-range offsets', () => {
    expect(caretLineColumn('abc', 99)).toEqual({ lineIndex: 0, column: 3 });
    expect(caretLineColumn('abc', -5)).toEqual({ lineIndex: 0, column: 0 });
  });
});

describe('columnToX', () => {
  it('multiplies the column by the character width', () => {
    expect(columnToX('abcdef', 3, 10, 4)).toBe(30);
  });

  it('advances a tab to the next tab stop', () => {
    expect(columnToX('\tx', 1, 10, 4)).toBe(40);
    expect(columnToX('a\tx', 2, 10, 4)).toBe(40);
    expect(columnToX('abcd\tx', 5, 10, 4)).toBe(80);
  });

  it('counts a tab in the middle of a tab stop', () => {
    // 3 chars in, the tab only advances one column.
    expect(columnToX('abc\tx', 4, 10, 4)).toBe(40);
  });

  it('stops at the end of the line rather than inventing characters', () => {
    expect(columnToX('ab', 5, 10, 4)).toBe(20);
  });

  it('handles an empty line', () => {
    expect(columnToX('', 3, 10, 4)).toBe(0);
  });
});

describe('caretOffsetIn', () => {
  it('offsets by the padding', () => {
    expect(caretOffsetIn('abcd', 0, METRICS)).toMatchObject({ x: 16, y: 16, lineIndex: 0, column: 0 });
  });

  it('adds one line height per line', () => {
    const offset = caretOffsetIn('abc\ndef\nghi', 8, METRICS);
    expect(offset.lineIndex).toBe(2);
    expect(offset.y).toBeCloseTo(16 + 2 * 22.75, 5);
  });

  it('adds the column advance on the caret line only', () => {
    const offset = caretOffsetIn('abc\ndef\nghi', 9, METRICS);
    expect(offset.column).toBe(1);
    expect(offset.x).toBeCloseTo(16 + 8.4, 5);
  });

  it('matches the textarea’s own metrics for a real file shape', () => {
    const text = '[stepper_x]\nmicrosteps: 16\n';
    const offset = caretOffsetIn(text, text.indexOf('16') + 2, METRICS);
    expect(offset.lineIndex).toBe(1);
    expect(offset.column).toBe('microsteps: 16'.length);
  });
});
