import type { IssueSeverity } from './issueSummary';

/**
 * Syntax highlighting for the text view's overlay `<pre>`.
 *
 * **The code must stay ONE continuous text block** (lines joined with `\n`,
 * one text node per run). Wrapping each line in its own block box — however
 * convenient for painting a full-width row tint — reintroduces the gutter drift
 * fixed in e482e63: per-line boxes round their offsets independently of the
 * textarea's continuous line boxes, so the numbers advance in increments
 * slightly smaller than the lines and the error grows with the document
 * length (invisible at device pixel ratio 1, obvious at Windows display
 * scaling / browser zoom).
 *
 * Row tints are therefore painted by an out-of-flow band layer (see
 * `tintBands`) positioned from the font metrics, never by restructuring the
 * text.
 */

/** Vertical padding of the code area (`p-4`), in px. */
export const CODE_PADDING_TOP_PX = 16;
/** `leading-relaxed` — the line height in em. */
export const CODE_LINE_HEIGHT_EM = 1.625;
/** Files with more findings than this keep their strip + dots, but only the
 *  first N rows are tinted (a band layer per row is not free). */
export const TINT_CAP = 200;

export interface TintBand {
  /** 1-based line the band covers. */
  line: number;
  /** CSS `top` for the band, from the code area's content origin. */
  top: string;
  /** CSS colour (a `--color-*-tint` token). */
  background: string;
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

/**
 * Highlighted markup for the overlay. One text block, lines joined with `\n` —
 * deliberately unaffected by findings, so the overlay's line boxes are always
 * the same boxes the textarea lays out.
 */
export function buildHighlightedHtml(text: string): string {
  return text.split('\n').map(renderLine).join('\n');
}

/**
 * Row tints as out-of-flow bands: one entry per tinted line, `top` computed
 * from the code area's padding and the line height in `em`, so the band tracks
 * the font at any zoom and never participates in text layout.
 *
 * `info` gets no band: it is legal, order-dependent context, not an alarm.
 */
export function tintBands(
  severities: ReadonlyMap<number, IssueSeverity> | undefined,
  options: {
    paddingTopPx?: number;
    lineHeightEm?: number;
    cap?: number;
  } = {},
): TintBand[] {
  if (!severities || severities.size === 0) return [];
  const paddingTop = options.paddingTopPx ?? CODE_PADDING_TOP_PX;
  const lineHeight = options.lineHeightEm ?? CODE_LINE_HEIGHT_EM;
  const cap = options.cap ?? TINT_CAP;

  const bands: TintBand[] = [];
  for (const [line, severity] of Array.from(severities.entries()).sort((a, b) => a[0] - b[0])) {
    if (line < 1) continue;
    if (severity !== 'error' && severity !== 'warning') continue;
    bands.push({
      line,
      top: `calc(${paddingTop}px + ${line - 1} * ${lineHeight}em)`,
      background: severity === 'error' ? 'var(--color-error-tint)' : 'var(--color-warning-tint)',
    });
    if (bands.length >= cap) break;
  }
  return bands;
}

/** Explicit height for the band layer so it covers the whole document. */
export function tintLayerHeight(
  lineCount: number,
  options: { paddingTopPx?: number; lineHeightEm?: number } = {},
): string {
  const paddingTop = options.paddingTopPx ?? CODE_PADDING_TOP_PX;
  const lineHeight = options.lineHeightEm ?? CODE_LINE_HEIGHT_EM;
  return `calc(${lineCount} * ${lineHeight}em + ${paddingTop * 2}px)`;
}
