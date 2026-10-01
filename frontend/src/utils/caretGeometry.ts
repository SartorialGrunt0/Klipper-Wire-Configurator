/**
 * Caret geometry for the completion popup.
 *
 * The textarea's caret has no DOM node, so its pixel position is computed from
 * the font metrics (the editor is monospace with `wrap="off"`, so a line is
 * always exactly `lineIndex * lineHeight` down and the column's x is a sum of
 * character advances). The maths is pure and tested; only the font measurement
 * touches the DOM.
 */

export interface CaretMetrics {
  lineHeight: number;
  paddingTop: number;
  paddingLeft: number;
  charWidth: number;
  tabSize: number;
}

export interface CaretRect {
  /** Viewport coordinates of the caret. */
  x: number;
  y: number;
  height: number;
  lineIndex: number;
  column: number;
}

export function caretLineColumn(text: string, caret: number): { lineIndex: number; column: number } {
  const clamped = Math.max(0, Math.min(caret, text.length));
  const before = text.slice(0, clamped);
  const lineIndex = before.split('\n').length - 1;
  const lastBreak = before.lastIndexOf('\n');
  return { lineIndex, column: clamped - (lastBreak + 1) };
}

/** x offset of `column` characters into `lineText`, expanding tabs. */
export function columnToX(lineText: string, column: number, charWidth: number, tabSize: number): number {
  const limit = Math.min(column, lineText.length);
  let x = 0;
  for (let i = 0; i < limit; i += 1) {
    if (lineText[i] === '\t') {
      const columnsIn = charWidth > 0 ? Math.round(x / charWidth) : 0;
      const advance = tabSize - (columnsIn % tabSize);
      x += advance * charWidth;
    } else {
      x += charWidth;
    }
  }
  return x;
}

/** Pure: offset of the caret inside the text content box. */
export function caretOffsetIn(
  text: string,
  caret: number,
  metrics: CaretMetrics,
): { x: number; y: number; lineIndex: number; column: number } {
  const { lineIndex, column } = caretLineColumn(text, caret);
  const lineText = text.split('\n')[lineIndex] ?? '';
  return {
    x: metrics.paddingLeft + columnToX(lineText, column, metrics.charWidth, metrics.tabSize),
    y: metrics.paddingTop + lineIndex * metrics.lineHeight,
    lineIndex,
    column,
  };
}

let cachedCharWidth: { key: string; width: number } | null = null;

/** Width of one monospace character for this computed style (cached per font). */
function measureCharWidth(style: CSSStyleDeclaration): number {
  const key = `${style.font}|${style.fontSize}|${style.letterSpacing}`;
  if (cachedCharWidth?.key === key) return cachedCharWidth.width;

  const probe = document.createElement('span');
  probe.textContent = 'M'.repeat(50);
  probe.style.position = 'absolute';
  probe.style.visibility = 'hidden';
  probe.style.whiteSpace = 'pre';
  probe.style.font = style.font;
  probe.style.fontSize = style.fontSize;
  probe.style.fontFamily = style.fontFamily;
  probe.style.letterSpacing = style.letterSpacing;
  document.body.appendChild(probe);
  const width = probe.getBoundingClientRect().width / 50;
  probe.remove();

  cachedCharWidth = { key, width };
  return width;
}

/** Viewport rect of the caret in a textarea, or null when it cannot be measured. */
export function measureCaretRect(el: HTMLTextAreaElement, caret: number): CaretRect | null {
  const style = window.getComputedStyle(el);
  const lineHeight = parseFloat(style.lineHeight);
  const charWidth = measureCharWidth(style);
  if (!lineHeight || !charWidth) return null;

  const offset = caretOffsetIn(el.value, caret, {
    lineHeight,
    paddingTop: parseFloat(style.paddingTop) || 0,
    paddingLeft: parseFloat(style.paddingLeft) || 0,
    charWidth,
    tabSize: Number.parseInt(String(style.tabSize ?? '4'), 10) || 4,
  });

  const box = el.getBoundingClientRect();
  return {
    x: box.left + offset.x - el.scrollLeft,
    y: box.top + offset.y - el.scrollTop,
    height: lineHeight,
    lineIndex: offset.lineIndex,
    column: offset.column,
  };
}
