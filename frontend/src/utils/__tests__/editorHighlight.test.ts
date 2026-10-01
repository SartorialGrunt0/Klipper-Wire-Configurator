import { describe, it, expect } from 'vitest';
import {
  buildHighlightedHtml,
  escapeHtml,
  tintBands,
  tintLayerHeight,
  TINT_CAP,
} from '../editorHighlight';
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

describe('buildHighlightedHtml', () => {
  it('renders a mixed file exactly as the original implementation did', () => {
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

  it('joins lines with newlines — ONE text block, never per-line boxes', () => {
    expect(buildHighlightedHtml('a\nb')).toBe('a\nb');
    // Per-line block boxes are what makes the gutter drift (e482e63).
    expect(buildHighlightedHtml('a\nb')).not.toContain('display:block');
    expect(buildHighlightedHtml('a\nb')).not.toContain('kl-line');
  });

  it('renders a trailing newline as an extra empty line, like the textarea', () => {
    expect(buildHighlightedHtml('a\n')).toBe('a\n ');
  });
});

describe('tintBands', () => {
  it('returns nothing without findings', () => {
    expect(tintBands(undefined)).toEqual([]);
    expect(tintBands(new Map())).toEqual([]);
  });

  it('places the first line just below the code padding', () => {
    expect(tintBands(sev([[1, 'error']]))).toEqual([
      { line: 1, top: 'calc(16px + 0 * 1.625em)', background: 'var(--color-error-tint)' },
    ]);
  });

  it('places line 584 at 583 line heights down', () => {
    expect(tintBands(sev([[584, 'warning']]))[0].top).toBe('calc(16px + 583 * 1.625em)');
    expect(tintBands(sev([[584, 'warning']]))[0].background).toBe('var(--color-warning-tint)');
  });

  it('gives info findings no band', () => {
    expect(tintBands(sev([[4, 'info']]))).toEqual([]);
  });

  it('sorts bands by line', () => {
    expect(tintBands(sev([[9, 'error'], [2, 'warning']])).map((band) => band.line)).toEqual([2, 9]);
  });

  it('ignores file-level lines', () => {
    expect(tintBands(sev([[0, 'error']]))).toEqual([]);
  });

  it('caps the number of bands', () => {
    const many = new Map<number, IssueSeverity>();
    for (let i = 1; i <= TINT_CAP + 25; i += 1) many.set(i, 'error');
    expect(tintBands(many)).toHaveLength(TINT_CAP);
    expect(tintBands(many, { cap: 3 })).toHaveLength(3);
  });

  it('honours custom metrics', () => {
    expect(tintBands(sev([[3, 'error']]), { paddingTopPx: 8, lineHeightEm: 1.2 })[0].top).toBe(
      'calc(8px + 2 * 1.2em)',
    );
  });
});

describe('tintLayerHeight', () => {
  it('covers the whole document plus the padding', () => {
    expect(tintLayerHeight(723)).toBe('calc(723 * 1.625em + 32px)');
  });
});
