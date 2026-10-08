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
  /**
   * 1-based live lines that carry an undecided AI change (Zed-model review:
   * pending changes tint the LIVE buffer instead of replacing it). Same
   * inline-span rule as the severity tints.
   */
  pendingAdded?: ReadonlySet<number>;
  /**
   * 1-based lines where an undecided DELETION would return: painted with the
   * red row mark (`.kl-line-removed`). Like every other live-editor mark it
   * is INLINE — the text's own line box paints it, so it cannot drift from
   * the text at any zoom (the band layer this replaced computed row positions
   * outside the text and slid −13px by line 702 at 90% zoom, 2026-10-07).
   */
  pendingRemoved?: ReadonlySet<number>;
  /**
   * Lines that ANCHOR a pending run's inline Keep/Undo pair: 1-based live
   * line → run key. Emits a zero-width marker span (`kl-run-anchor`,
   * data-run-key) inside the line's own markup — invisible, layout-neutral,
   * and MEASURABLE: the floating decision pair positions itself from this
   * span's rect, so its vertical position comes from the text layout itself,
   * never from font-metric arithmetic outside the text (the inline law).
   */
  runAnchors?: ReadonlyMap<number, string>;
  /**
   * 1-based line holding the caret, highlighted so "where am I" is ambient
   * (Zed renders it even unfocused). The weakest tint in the stack — see
   * TINT PRECEDENCE on `buildHighlightedHtml`.
   */
  currentLine?: number | null;
  /** Focused editor: the caret line paints stronger than an unfocused one. */
  currentLineFocused?: boolean;
}

/**
 * TINT PRECEDENCE — designed once, in the editable-pending round (2026-10-05),
 * so the highlights cannot fight one another as the stack grows:
 *
 *   error > warning > pending > current-line (focused or not)
 *
 * ONE tint class per line, strongest wins; a pending line that is also an
 * error line shows red (the AI's change being wrong IS the news), and a
 * pending line under the caret shows green — position loses to a claim about
 * the content, because the caret marker is ambient, not information.
 */
export const TINT_CLASS: Record<'error' | 'warning', string> = {
  error: 'kl-line-error',
  warning: 'kl-line-warning',
};
const PENDING_CLASS = 'kl-line-pending';
const REMOVED_CLASS = 'kl-line-removed';
const CURRENT_CLASS = 'kl-line-current';
const CURRENT_UNFOCUSED_CLASS = 'kl-line-current-unfocused';

/** The tint class for one line under the precedence above, or null. */
export function tintClassFor(options: {
  severity?: IssueSeverity;
  pending?: boolean;
  removed?: boolean;
  current?: boolean;
  focused?: boolean;
}): string | null {
  const { severity, pending, removed, current, focused } = options;
  if (severity === 'error') return TINT_CLASS.error;
  if (severity === 'warning') return TINT_CLASS.warning;
  // A pending line the reviewer can KEEP and a line an undecided deletion
  // would RETURN to are mutually exclusive by construction (a live line is
  // either new or pre-existing), so order between them is a formality; red
  // first because the red row's return-point is the sharper claim.
  if (removed) return REMOVED_CLASS;
  if (pending) return PENDING_CLASS;
  if (current) return focused ? CURRENT_CLASS : CURRENT_UNFOCUSED_CLASS;
  return null;
}

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
  const pending = options.pendingAdded;
  const removed = options.pendingRemoved;
  const anchors = options.runAnchors;
  const current = options.currentLine ?? null;
  const escapeAttr = (value: string) => escapeHtml(value).replace(/"/g, '&quot;');
  return text
    .split('\n')
    .map((line, idx) => {
      const lineNumber = idx + 1;
      // The ghost sits inside the line's markup at the caret column, so it
      // shares the line box and cannot shift the text that follows it.
      const atGhost = ghost && ghost.line === lineNumber && ghost.text.length > 0;
      let html = atGhost
        ? renderLine(line.slice(0, ghost.column)) +
          ghostHtml(ghost.text) +
          renderLine(line.slice(ghost.column))
        : renderLine(line);

      const tint = tintClassFor({
        severity: severities?.get(lineNumber),
        pending: pending?.has(lineNumber) ?? false,
        removed: removed?.has(lineNumber) ?? false,
        current: current === lineNumber,
        focused: options.currentLineFocused,
      });
      // The pair's anchor marker: an EMPTY inline span at the line's start —
      // zero-width, so it cannot shift a glyph, but its rect is a DOM truth
      // the floating pair measures. Inside the tint wrapper when there is one
      // (so it belongs to the same line box the tint paints).
      const anchorKey = anchors?.get(lineNumber);
      const marker = anchorKey !== undefined
        ? `<span class="kl-run-anchor" data-run-key="${escapeAttr(anchorKey)}"></span>`
        : '';
      if (!tint) return marker + html;
      // Pending review marks paint the FULL row (the mini-diff's look) via
      // the horizontal-overflow trick: padding-right stretches the tint
      // across the row, the equal negative margin nets the advance back to
      // zero so the text after it never shifts. Vertical padding is FORBIDDEN
      // on these spans — inline vertical padding grows the line box and
      // changes the pitch (measured 22.75 → 28.6px, 2026-10-07), which is
      // exactly what the overlay must never do: it shares the textarea's
      // rhythm character for character.
      const fullRow = tint === PENDING_CLASS || tint === REMOVED_CLASS;
      return `<span class="${tint}${fullRow ? ' kl-row-full' : ''}">${marker}${html}</span>`;
    })
    .join('\n');
}
