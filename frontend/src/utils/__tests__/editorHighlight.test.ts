import { describe, it, expect } from 'vitest';
import { buildHighlightedHtml, escapeHtml } from '../editorHighlight';
import type { IssueSeverity } from '../issueSummary';

const sev = (entries: Array<[number, IssueSeverity]>) => new Map(entries);

describe('escapeHtml', () => {
  it('escapes the three HTML-significant characters', () => {
    expect(escapeHtml('<a & b>')).toBe('&lt;a &amp; b&gt;');
  });

  it('leaves quotes alone (attribute escaping is the caller’s job)', () => {
    expect(escapeHtml('say "hi"')).toBe('say "hi"');
  });
});

describe('buildHighlightedHtml — plain output', () => {
  it('is byte-identical to the original implementation for a mixed file', () => {
    const text = [
      '# a comment',
      '[stepper_x]',
      'microsteps: 16',
      '  # indented comment',
      '[include macros.cfg]',
      '',
      'plain text',
    ].join('\n');

    expect(buildHighlightedHtml(text)).toBe(
      '<span style="color: var(--color-text-secondary)"># a comment</span>\n' +
        '<span style="color: #22d3ee">[stepper_x]</span>\n' +
        '<span style="color: #60a5fa">microsteps</span><span style="color: var(--color-text-secondary)">: </span><span style="color: var(--color-text-primary)">16</span>\n' +
        '<span style="color: var(--color-text-secondary)">  # indented comment</span>\n' +
        '<span style="color: #22d3ee">[include macros.cfg]</span>\n' +
        ' \n' +
        'plain text',
    );
  });

  it('renders a commented-out section header as a comment line (comment branch wins)', () => {
    // Pre-existing precedence, preserved byte-for-byte: the comment test runs
    // first, so the section regex's optional `#` prefix never fires and the
    // whole line stays grey.
    expect(buildHighlightedHtml('#[probe]')).toBe(
      '<span style="color: var(--color-text-secondary)">#[probe]</span>',
    );
  });

  it('renders an [include ...] line as a section header (same precedence quirk)', () => {
    expect(buildHighlightedHtml('[include macros.cfg]')).toBe(
      '<span style="color: #22d3ee">[include macros.cfg]</span>',
    );
  });

  it('escapes HTML in every branch exactly once', () => {
    expect(buildHighlightedHtml('<b>')).toBe('&lt;b&gt;');
    expect(buildHighlightedHtml('[a<b]')).toBe('<span style="color: #22d3ee">[a&lt;b]</span>');
    expect(buildHighlightedHtml('key: <value>')).toBe(
      '<span style="color: #60a5fa">key</span><span style="color: var(--color-text-secondary)">: </span><span style="color: var(--color-text-primary)">&lt;value&gt;</span>',
    );
  });

  it('joins lines with newlines (one text block, no per-line boxes)', () => {
    expect(buildHighlightedHtml('a\nb')).toBe('a\nb');
    expect(buildHighlightedHtml('a\nb')).not.toContain('kl-line');
  });

  it('does not wrap anything when the tint map is empty', () => {
    expect(buildHighlightedHtml('a\nb', { lineSeverities: new Map() })).toBe('a\nb');
  });

  it('renders a trailing newline as an extra empty line, like the textarea', () => {
    expect(buildHighlightedHtml('a\n')).toBe('a\n ');
  });
});

describe('buildHighlightedHtml — line tints', () => {
  const text = 'a\nbroken\nwarned\nnoted\nlast';

  it('tints error lines and warning lines, and leaves info plain', () => {
    const html = buildHighlightedHtml(text, { lineSeverities: sev([[2, 'error'], [3, 'warning'], [4, 'info']]) });
    expect(html).toContain('<span class="kl-line kl-line-error">broken</span>');
    expect(html).toContain('<span class="kl-line kl-line-warning">warned</span>');
    expect(html).toContain('<span class="kl-line">noted</span>');
    expect(html).not.toContain('kl-line-info');
  });

  it('wraps every line in block mode so the line rhythm is unchanged', () => {
    const html = buildHighlightedHtml(text, { lineSeverities: sev([[2, 'error']]) });
    expect(html.match(/class="kl-line/g)).toHaveLength(5);
    // Block boxes break lines themselves — a '\n' between them would double
    // every line box and desynchronise the overlay from the textarea.
    expect(html).not.toContain('\n');
  });

  it('wraps plain lines too, so tinted and untinted rows behave identically', () => {
    const html = buildHighlightedHtml(text, { lineSeverities: sev([[5, 'error']]) });
    expect(html.startsWith('<span class="kl-line">a</span>')).toBe(true);
    expect(html.endsWith('<span class="kl-line kl-line-error">last</span>')).toBe(true);
  });

  it('ignores a tint for a line beyond the end of the text', () => {
    const html = buildHighlightedHtml('a', { lineSeverities: sev([[99, 'error']]) });
    expect(html).toBe('<span class="kl-line">a</span>');
  });

  it('does not escape or re-classify the inner markup', () => {
    const html = buildHighlightedHtml('[stepper_x]\n', { lineSeverities: sev([[1, 'error']]) });
    expect(html).toBe(
      '<span class="kl-line kl-line-error"><span style="color: #22d3ee">[stepper_x]</span></span>' +
        '<span class="kl-line"> </span>',
    );
  });
});
