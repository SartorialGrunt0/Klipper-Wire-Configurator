import { describe, it, expect } from 'vitest';
import {
  INDENT_UNIT,
  lineStartAt,
  lineEndAt,
  lineIndexAt,
  lineRangeForSelection,
  outdentAmount,
  indentCaret,
  indentSelection,
  outdentSelection,
} from '../textIndent';

// Line starts in DOC: alpha@0, '  beta'@6, '\tgamma'@13, ''@20, delta@21
const DOC = 'alpha\n  beta\n\tgamma\n\ndelta';

describe('line helpers', () => {
  it('finds line starts', () => {
    expect(lineStartAt(DOC, 0)).toBe(0);
    expect(lineStartAt(DOC, 3)).toBe(0);
    expect(lineStartAt(DOC, 6)).toBe(6);
    expect(lineStartAt(DOC, 19)).toBe(13);
    expect(lineStartAt(DOC, 20)).toBe(20);
    expect(lineStartAt(DOC, 25)).toBe(21);
  });

  it('finds line ends', () => {
    expect(lineEndAt(DOC, 0)).toBe(5);
    expect(lineEndAt(DOC, 6)).toBe(12);
    expect(lineEndAt(DOC, 20)).toBe(20);
    expect(lineEndAt(DOC, 21)).toBe(26);
  });

  it('counts the line index', () => {
    expect(lineIndexAt(DOC, 0)).toBe(0);
    expect(lineIndexAt(DOC, 5)).toBe(0);
    expect(lineIndexAt(DOC, 6)).toBe(1);
    expect(lineIndexAt(DOC, 20)).toBe(3);
    expect(lineIndexAt(DOC, DOC.length)).toBe(4);
  });

  it('clamps out-of-range positions instead of throwing', () => {
    expect(lineStartAt(DOC, 999)).toBe(21);
    expect(lineEndAt(DOC, -5)).toBe(5);
    expect(lineIndexAt(DOC, -5)).toBe(0);
  });
});

describe('lineRangeForSelection', () => {
  it('covers the selection inside a single line', () => {
    expect(lineRangeForSelection(DOC, 1, 3)).toEqual({ start: 0, end: 5 });
  });

  it('does not pull in the line a selection ends at the start of', () => {
    // [0, 6] ends right after line 0's newline = at the start of line 1
    expect(lineRangeForSelection(DOC, 0, 6)).toEqual({ start: 0, end: 5 });
  });

  it('covers every line a mid-line selection touches', () => {
    expect(lineRangeForSelection(DOC, 0, 7)).toEqual({ start: 0, end: 12 });
  });

  it('normalises a backwards selection', () => {
    expect(lineRangeForSelection(DOC, 7, 0)).toEqual({ start: 0, end: 12 });
  });

  it('covers a blank line on its own', () => {
    expect(lineRangeForSelection(DOC, 20, 20)).toEqual({ start: 20, end: 20 });
  });
});

describe('outdentAmount', () => {
  it('removes a full indent unit first', () => {
    expect(outdentAmount('    x')).toBe(4);
    expect(outdentAmount('      x')).toBe(4);
  });

  it('removes a single tab', () => {
    expect(outdentAmount('\tx')).toBe(1);
  });

  it('removes whatever short indentation a line has', () => {
    expect(outdentAmount('  x')).toBe(2);
    expect(outdentAmount(' x')).toBe(1);
    expect(outdentAmount('x')).toBe(0);
    expect(outdentAmount('')).toBe(0);
  });

  it('only counts leading spaces', () => {
    expect(outdentAmount(' x y')).toBe(1);
  });
});

describe('indentCaret', () => {
  it('inserts one unit at a collapsed caret and keeps the caret after it', () => {
    expect(indentCaret('ab', 1)).toEqual({ text: 'a    b', start: 5, end: 5 });
  });

  it('works at the start and end of the text', () => {
    expect(indentCaret('ab', 0)).toEqual({ text: '    ab', start: 4, end: 4 });
    expect(indentCaret('ab', 2)).toEqual({ text: 'ab    ', start: 6, end: 6 });
  });

  it('indents an empty document', () => {
    expect(indentCaret('', 0)).toEqual({ text: INDENT_UNIT, start: 4, end: 4 });
  });
});

describe('indentSelection', () => {
  it('indents a single line covered by the selection', () => {
    expect(indentSelection(DOC, 0, 5)).toEqual({
      text: '    alpha\n  beta\n\tgamma\n\ndelta',
      start: 4,
      end: 9,
    });
  });

  it('indents every covered line and grows the selection by unit × lines', () => {
    expect(indentSelection(DOC, 0, 12)).toEqual({
      text: '    alpha\n      beta\n\tgamma\n\ndelta',
      start: 4,
      end: 20,
    });
  });

  it('gives blank lines inside the range the unit too', () => {
    expect(indentSelection('a\n\nb\n', 0, 5)).toEqual({
      text: '    a\n    \n    b\n',
      start: 4,
      end: 17,
    });
  });

  it('indents only the lines the selection reaches', () => {
    expect(indentSelection('aaa\nbbb\nccc', 0, 5)).toEqual({
      text: '    aaa\n    bbb\nccc',
      start: 4,
      end: 13,
    });
  });

  it('keeps CRLF line endings', () => {
    expect(indentSelection('a\r\nb', 0, 3)).toEqual({
      text: '    a\r\nb',
      start: 4,
      end: 7,
    });
  });

  it('indents a collapsed caret line when driven through the selection-shaped API', () => {
    // Tab with no selection goes through indentCaret; this pins that the range
    // variant still behaves for a caret at a line end.
    expect(indentSelection('ab\ncd', 2, 2)).toEqual({ text: '    ab\ncd', start: 6, end: 6 });
  });
});

describe('outdentSelection', () => {
  it('removes a full unit from a caret line', () => {
    expect(outdentSelection('    alpha', 4, 4)).toEqual({ text: 'alpha', start: 0, end: 0 });
  });

  it('removes a tab', () => {
    expect(outdentSelection('\talpha', 1, 1)).toEqual({ text: 'alpha', start: 0, end: 0 });
  });

  it('removes short indentation', () => {
    expect(outdentSelection('  alpha', 3, 3)).toEqual({ text: 'alpha', start: 1, end: 1 });
  });

  it('is a no-op on a flush-left line', () => {
    expect(outdentSelection('alpha', 2, 2)).toEqual({ text: 'alpha', start: 2, end: 2 });
  });

  it('is a no-op on empty text', () => {
    expect(outdentSelection('', 0, 0)).toEqual({ text: '', start: 0, end: 0 });
  });

  it('clamps a caret that sits inside the removed indentation', () => {
    expect(outdentSelection('    alpha', 2, 2)).toEqual({ text: 'alpha', start: 0, end: 0 });
  });

  it('outdents every covered line by its own indentation', () => {
    expect(outdentSelection('   x\n\ty\n z', 0, 10)).toEqual({
      text: 'x\ny\nz',
      start: 0,
      end: 5,
    });
  });

  it('keeps the selection over the same text when whole lines are selected', () => {
    expect(outdentSelection('  a\n  b', 0, 7)).toEqual({ text: 'a\nb', start: 0, end: 3 });
  });

  it('leaves unindented lines in the middle of the range alone', () => {
    expect(outdentSelection('    a\nb\n    c', 0, 13)).toEqual({
      text: 'a\nb\nc',
      start: 0,
      end: 5,
    });
  });
});

describe('indent / outdent round trip', () => {
  it('restores the original text and caret for a caret-only edit', () => {
    const text = 'a\n  b\nc';
    const indented = indentSelection(text, 4, 4);
    expect(indented.text).toBe('a\n      b\nc');
    const back = outdentSelection(indented.text, indented.start, indented.end);
    expect(back.text).toBe(text);
    expect(back.start).toBe(4);
  });

  it('restores the original text for a multi-line selection', () => {
    const text = 'a\n  b\nc\n';
    const indented = indentSelection(text, 0, 7);
    const back = outdentSelection(indented.text, indented.start, indented.end);
    expect(back.text).toBe(text);
  });
});
