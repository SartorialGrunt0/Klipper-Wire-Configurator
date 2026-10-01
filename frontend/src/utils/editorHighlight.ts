import type { IssueSeverity } from './issueSummary';

/**
 * Syntax highlighting for the text view's overlay `<pre>`.
 *
 * The editor is a transparent `<textarea>` layered over this markup, so the
 * overlay's line rhythm must match the textarea's exactly (see the gutter
 * comment in TextEditor — per-row boxes drift with browser zoom; a single text
 * block does not). Two output shapes:
 *
 * - **plain** (no tints): lines joined with `\n`, one inline span per line —
 *   byte-identical to the original implementation.
 * - **tinted** (any severity tint): every line is wrapped in a `display:block`
 *   span and the lines are joined with `''` (the block boxes already break
 *   lines). Joining with `\n` *and* wrapping would double every line box.
 */

export interface HighlightOptions {
  /**
   * 1-based line → severity. `error` tints the row, `warning` tints it yellow,
   * `info` is deliberately plain (legal, order-dependent context is not an
   * alarm — matching the gutter dot treatment).
   */
  lineSeverities?: ReadonlyMap<number, IssueSeverity>;
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

export function buildHighlightedHtml(text: string, options: HighlightOptions = {}): string {
  const lines = text.split('\n');
  const rendered = lines.map((line) => renderLine(line));
  const severities = options.lineSeverities;

  if (!severities || severities.size === 0) {
    return rendered.join('\n');
  }

  return rendered
    .map((html, idx) => {
      const severity = severities.get(idx + 1);
      const tint =
        severity === 'error' ? ' kl-line-error' : severity === 'warning' ? ' kl-line-warning' : '';
      return `<span class="kl-line${tint}">${html}</span>`;
    })
    .join('');
}
