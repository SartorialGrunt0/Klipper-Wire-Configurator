import type { IssueSeverity } from './issueSummary';

/**
 * Syntax highlighting for the text view's overlay `<pre>`.
 *
 * **The code is ONE continuous text block** (lines joined with `\n`). Wrapping
 * lines in their own block boxes — however convenient for painting a
 * full-width row tint — reintroduces the gutter drift fixed in e482e63:
 * per-line boxes round their offsets independently of the textarea's
 * continuous line boxes, so the numbers advance in increments slightly smaller
 * than the lines and the error grows with the document length.
 *
 * A floating band layer is no better: it computes a row's position from the
 * font metrics in a layer that is NOT the text, so anything that makes that
 * layer lay out differently (engine, zoom, display scaling) moves the tint off
 * its line without moving the text.
 *
 * So a tint is an **inline span wrapped around the line's own markup**: an
 * inline box adds no line box, the glyphs keep their exact positions, and the
 * background is painted by the same boxes that draw the characters — it cannot
 * end up on a different line than its text, in any engine, at any zoom.
 *
 * The trade-off is that the tint covers the line's text, not the full width of
 * the editor.
 */

export interface HighlightOptions {
  /**
   * 1-based line → severity. `error` tints the line red, `warning` yellow.
   * `info` is deliberately untinted: it is legal, order-dependent context, not
   * an alarm.
   */
  lineSeverities?: ReadonlyMap<number, IssueSeverity>;
  /**
   * Inline ghost suggestion drawn at the caret. Same rule as the tints: an
   * inline span inside the line's own markup, so it occupies the line box that
   * already exists and cannot move the text.
   */
  ghost?: { line: number; column: number; text: string } | null;
}

export const TINT_CLASS: Record<'error' | 'warning', string> = {
  error: 'kl-line-error',
  warning: 'kl-line-warning',
};

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function renderLine(line: string): string {
  const escaped = escapeHtml(line);
  if (/^\s*#/.test(line)) {
    return `<span style="color: var(--color-text-secondary)">${escaped}</span>`;
  }
  const sectionMatch = line.match(/^\s*(#?)\[([^\]]+)\]\s*$/);
  if (sectionMatch) {
    const prefix = sectionMatch[1] ? '<span style="color: var(--color-text-secondary)">#</span>' : '';
    return `${prefix}<span style="color: #22d3ee">[${escapeHtml(sectionMatch[2])}]</span>`;
  }
  const includeMatch = line.match(/^\s*\[include\s+([^\]]+)\]\s*$/i);
  if (includeMatch) {
    return `<span style="color: #a78bfa">[include ${escapeHtml(includeMatch[1])}]</span>`;
  }
  const paramMatch = line.match(/^(\s*)(#?)([A-Za-z0-9_][A-Za-z0-9_\-]*)(\s*[:=]\s*)(.*)$/);
  if (paramMatch) {
    const [, ws, hash, key, sep, rawValue] = paramMatch;
    return `${escapeHtml(ws)}${hash ? '<span style="color: var(--color-text-secondary)">#</span>' : ''}<span style="color: #60a5fa">${escapeHtml(key)}</span><span style="color: var(--color-text-secondary)">${escapeHtml(sep)}</span><span style="color: var(--color-text-primary)">${escapeHtml(rawValue)}</span>`;
  }
  return escaped || ' ';
}

/** Ghost span markup for a suggestion at `column` of the line. */
export function ghostHtml(text: string): string {
  return `<span class="kl-ghost">${escapeHtml(text)}</span>`;
}

export function buildHighlightedHtml(text: string, options: HighlightOptions = {}): string {
  const severities = options.lineSeverities;
  const ghost = options.ghost;
  return text
    .split('\n')
    .map((line, idx) => {
      const lineNumber = idx + 1;
      // The ghost sits inside the line's markup at the caret column, so it
      // shares the line box and cannot shift the text that follows it.
      const atGhost = ghost && ghost.line === lineNumber && ghost.text.length > 0;
      const html = atGhost
        ? renderLine(line.slice(0, ghost.column)) +
          ghostHtml(ghost.text) +
          renderLine(line.slice(ghost.column))
        : renderLine(line);

      const severity = severities?.get(lineNumber);
      if (severity !== 'error' && severity !== 'warning') return html;
      return `<span class="${TINT_CLASS[severity]}">${html}</span>`;
    })
    .join('\n');
}
