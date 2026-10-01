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
  const text = [
    '# a comment',
    '[stepper_x]',
    'microsteps: 16',
    '  # indented comment',
    '[include macros.cfg]',
    '',
    'plain text',
  ].join('\n');

  it('renders a mixed file exactly as the original implementation did', () => {
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

  it('joins lines with newlines — ONE text block, never per-line boxes', () => {
    expect(buildHighlightedHtml('a\nb')).toBe('a\nb');
    expect(buildHighlightedHtml('a\nb')).not.toContain('display:block');
  });

  it('renders a trailing newline as an extra empty line, like the textarea', () => {
    expect(buildHighlightedHtml('a\n')).toBe('a\n ');
  });

  it('does not wrap anything without severities', () => {
    expect(buildHighlightedHtml(text)).not.toContain('kl-line');
    expect(buildHighlightedHtml(text, { lineSeverities: new Map() })).toBe(buildHighlightedHtml(text));
  });
});

describe('buildHighlightedHtml — inline tints', () => {
  const text = 'alpha\nbroken\nwarned\nnoted\nlast';

  it('wraps the tinted line’s own markup, inline', () => {
    const html = buildHighlightedHtml(text, { lineSeverities: sev([[2, 'error']]) });
    expect(html).toContain('<span class="kl-line-error">broken</span>');
    // No box-creating display: the tint must ride the line's own line box.
    expect(html).not.toContain('display:');
    expect(html).not.toContain('position:');
  });

  it('tints warnings and leaves info alone', () => {
    const html = buildHighlightedHtml(text, { lineSeverities: sev([[3, 'warning'], [4, 'info']]) });
    expect(html).toContain('<span class="kl-line-warning">warned</span>');
    expect(html).toContain('\nnoted\n');
    expect(html).not.toContain('kl-line-info');
  });

  it('wraps only the tinted lines, leaving the rest byte-identical', () => {
    const html = buildHighlightedHtml(text, { lineSeverities: sev([[5, 'error']]) });
    expect(html.match(/class="kl-line/g)).toHaveLength(1);
    expect(html).toBe('alpha\nbroken\nwarned\nnoted\n<span class="kl-line-error">last</span>');
  });

  it('keeps the newline structure intact (line count is unchanged)', () => {
    const html = buildHighlightedHtml(text, { lineSeverities: sev([[1, 'error'], [5, 'error']]) });
    expect(html.split('\n')).toHaveLength(5);
  });

  it('keeps a line’s own syntax markup inside the tint wrapper', () => {
    expect(buildHighlightedHtml('[stepper_x]\n', { lineSeverities: sev([[1, 'error']]) })).toBe(
      '<span class="kl-line-error"><span style="color: #22d3ee">[stepper_x]</span></span>\n ',
    );
  });

  it('tints a line whose text is empty', () => {
    expect(buildHighlightedHtml('a\n\nb', { lineSeverities: sev([[2, 'warning']]) })).toBe(
      'a\n<span class="kl-line-warning"> </span>\nb',
    );
  });

  it('ignores a tint for a line beyond the end of the text', () => {
    expect(buildHighlightedHtml('a', { lineSeverities: sev([[99, 'error']]) })).toBe('a');
  });

  it('escapes once with a tint present', () => {
    expect(buildHighlightedHtml('key: <v>', { lineSeverities: sev([[1, 'error']]) })).toBe(
      '<span class="kl-line-error"><span style="color: #60a5fa">key</span><span style="color: var(--color-text-secondary)">: </span><span style="color: var(--color-text-primary)">&lt;v&gt;</span></span>',
    );
  });
});
