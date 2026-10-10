/**
 * Indentation maths for the text-view editor.
 *
 * The editor is a plain `<textarea>` with `tabSize: 4`, so the unit is four
 * spaces. Everything here is pure string/offset arithmetic so the behaviour is
 * unit-testable without a DOM (jsdom has no layout, and selection behaviour is
 * exactly the part worth pinning).
 *
 * Offsets are JS string offsets (UTF-16 code units), matching
 * `HTMLTextAreaElement.selectionStart/selectionEnd`.
 */

/** One indent level. Matches the textarea's `tabSize: 4`. */
export const INDENT_UNIT = '    ';

export interface EditRange {
  start: number;
  end: number;
}

export interface TextEdit {
  text: string;
  start: number;
  end: number;
}

/** Index of the first character of the line containing `pos`. */
export function lineStartAt(text: string, pos: number): number {
  const clamped = Math.max(0, Math.min(pos, text.length));
  const nl = text.lastIndexOf('\n', clamped - 1);
  return nl === -1 ? 0 : nl + 1;
}

/** Index just past the last character of the line containing `pos`. */
export function lineEndAt(text: string, pos: number): number {
  const clamped = Math.max(0, Math.min(pos, text.length));
  const nl = text.indexOf('\n', clamped);
  return nl === -1 ? text.length : nl;
}

/** Zero-based line index containing `pos`. */
export function lineIndexAt(text: string, pos: number): number {
  const clamped = Math.max(0, Math.min(pos, text.length));
  let count = 0;
  for (let i = 0; i < clamped; i += 1) {
    if (text[i] === '\n') count += 1;
  }
  return count;
}

/**
 * Full-line range covering `[start, end]`.
 *
 * A selection that ends exactly at the start of a line does **not** pull that
 * next line in — the editor convention (selecting up to the start of line 3
 * indents lines 1-2, not 3).
 */
export function lineRangeForSelection(text: string, start: number, end: number): EditRange {
  const lo = Math.max(0, Math.min(start, end));
  const hi = Math.max(0, Math.max(start, end));
  const rangeStart = lineStartAt(text, lo);
  const lastLinePos = hi > lo && text[hi - 1] === '\n' ? hi - 1 : hi;
  const rangeEnd = lineEndAt(text, lastLinePos);
  return { start: rangeStart, end: Math.max(rangeStart, rangeEnd) };
}

/** How many characters a Shift+Tab removes from the head of this line. */
export function outdentAmount(line: string): number {
  if (line.startsWith(INDENT_UNIT)) return INDENT_UNIT.length;
  if (line.startsWith('\t')) return 1;
  const spaces = /^ {1,3}/.exec(line);
  return spaces ? spaces[0].length : 0;
}

/**
 * Insert one indent unit at a collapsed caret.
 */
export function indentCaret(text: string, pos: number): TextEdit {
  const at = Math.max(0, Math.min(pos, text.length));
  const caret = at + INDENT_UNIT.length;
  return { text: text.slice(0, at) + INDENT_UNIT + text.slice(at), start: caret, end: caret };
}

/**
 * Prefix every line covered by `[start, end]` with one indent unit.
 *
 * The caret keeps its offset *within its line*; a multi-line selection grows by
 * `unit × lines`.
 */
export function indentSelection(text: string, start: number, end: number): TextEdit {
  const range = lineRangeForSelection(text, start, end);
  const body = text.slice(range.start, range.end);
  const lines = body.split('\n');
  const nextBody = lines.map((line) => INDENT_UNIT + line).join('\n');
  const grew = INDENT_UNIT.length * lines.length;
  const lo = Math.max(0, Math.min(start, end));
  const hi = Math.max(0, Math.max(start, end));
  return {
    text: text.slice(0, range.start) + nextBody + text.slice(range.end),
    start: lo + INDENT_UNIT.length,
    end: hi + grew,
  };
}

/**
 * Remove one indent level from every line covered by `[start, end]`.
 *
 * A line loses one indent unit, or one leading tab, or up to three leading
 * spaces (i.e. whatever indentation it actually has). Offsets inside the
 * removed head clamp to the new line start.
 */
export function outdentSelection(text: string, start: number, end: number): TextEdit {
  const range = lineRangeForSelection(text, start, end);
  const body = text.slice(range.start, range.end);
  const lines = body.split('\n');

  let removedBeforeStart = 0;
  let removedBeforeEnd = 0;
  let lineOffset = 0;
  const nextLines: string[] = [];

  for (const line of lines) {
    const removed = outdentAmount(line);
    const lineStartAbs = range.start + lineOffset;
    const lineEndAbs = lineStartAbs + line.length;
    if (lineStartAbs < start) {
      removedBeforeStart += Math.min(removed, Math.max(0, start - lineStartAbs));
    }
    if (lineEndAbs <= end) {
      removedBeforeEnd += removed;
    } else if (lineStartAbs < end) {
      removedBeforeEnd += Math.min(removed, Math.max(0, end - lineStartAbs));
    }
    nextLines.push(removed > 0 ? line.slice(removed) : line);
    lineOffset += line.length + 1; // + the '\n' that split() consumed
  }

  return {
    text: text.slice(0, range.start) + nextLines.join('\n') + text.slice(range.end),
    start: Math.max(0, start - removedBeforeStart),
    end: Math.max(0, end - removedBeforeEnd),
  };
}
