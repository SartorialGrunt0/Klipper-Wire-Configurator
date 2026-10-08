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

describe('buildHighlightedHtml — inline ghost text', () => {
  it('injects the ghost at the caret column, inline', () => {
    const html = buildHighlightedHtml('rotation_di', { ghost: { line: 1, column: 11, text: 'stance: ' } });
    // The text after the caret is empty, and an empty remainder renders as a
    // space — the same rule that keeps an empty line a full line box.
    expect(html).toBe('rotation_di<span class="kl-ghost">stance: </span> ');
    expect(html).not.toContain('display:');
    expect(html).not.toContain('position:');
  });

  it('places it on the right line only', () => {
    const html = buildHighlightedHtml('a\nb\nc', { ghost: { line: 2, column: 1, text: 'XY' } });
    expect(html).toBe('a\nb<span class="kl-ghost">XY</span> \nc');
  });

  it('escapes the ghost text', () => {
    expect(buildHighlightedHtml('x', { ghost: { line: 1, column: 1, text: '<b>' } })).toBe(
      'x<span class="kl-ghost">&lt;b&gt;</span> ',
    );
  });

  it('keeps the newline structure (the ghost adds no line)', () => {
    const html = buildHighlightedHtml('a\nb', { ghost: { line: 1, column: 1, text: 'Z' } });
    expect(html.split('\n')).toHaveLength(2);
  });

  it('is a no-op for an empty suggestion or a line out of range', () => {
    expect(buildHighlightedHtml('a', { ghost: { line: 1, column: 1, text: '' } })).toBe('a');
    expect(buildHighlightedHtml('a', { ghost: { line: 9, column: 0, text: 'Z' } })).toBe('a');
  });

  it('sits inside the tint wrapper when the line is flagged', () => {
    const html = buildHighlightedHtml('abc', {
      lineSeverities: sev([[1, 'error']]),
      ghost: { line: 1, column: 3, text: 'd' },
    });
    expect(html).toBe('<span class="kl-line-error">abc<span class="kl-ghost">d</span> </span>');
  });

  it('renders the line markup around the caret split', () => {
    const html = buildHighlightedHtml('key: va', { ghost: { line: 1, column: 7, text: 'lue' } });
    expect(html).toContain('<span class="kl-ghost">lue</span>');
    expect(html).toContain('key');
    expect(html).toContain('va');
  });

  it('leaves untinted, ghost-free output byte-identical', () => {
    expect(buildHighlightedHtml('a\nb', { ghost: null })).toBe(buildHighlightedHtml('a\nb'));
  });
});

describe('tint precedence (editable-pending round, 2026-10-05)', () => {
  it('pending paints its line green in the overlay', () => {
    const html = buildHighlightedHtml('a = 1\nb = 2', { pendingAdded: new Set([2]) });
    const [first, second] = html.split('\n');
    expect(first).not.toContain('kl-line-pending');
    // Full-row inline mark (2026-10-07 law): the pending tint stretches
    // across the row via kl-row-full, still as the line's own inline span.
    expect(second.startsWith('<span class="kl-line-pending kl-row-full">')).toBe(true);
  });

  it('error beats warning beats pending beats current-line', () => {
    // One tint class per line, strongest wins.
    const html = buildHighlightedHtml('x\ny\nz\nw', {
      lineSeverities: new Map([[1, 'error' as const], [2, 'warning' as const]]),
      pendingAdded: new Set([3]),
      currentLine: 1,
      currentLineFocused: true,
    });
    const rows = html.split('\n');
    expect(rows[0]).toContain('class="kl-line-error"');
    expect(rows[0]).not.toContain('kl-line-current');
    expect(rows[1]).toContain('class="kl-line-warning"');
    expect(rows[2]).toContain('class="kl-line-pending kl-row-full"');
    expect(rows[2]).not.toContain('kl-line-current'); // pending beats the caret
    expect(rows[3]).not.toContain('kl-line-current'); // only ONE line carries it
    // sanity: current line itself paints when nothing stronger claims it
    const plain = buildHighlightedHtml('x\ny', { currentLine: 2, currentLineFocused: true });
    expect(plain.split('\n')[1]).toContain('class="kl-line-current"');
  });

  it('an unfocused caret line paints the fainter class', () => {
    const focused = buildHighlightedHtml('x', { currentLine: 1, currentLineFocused: true });
    const blurred = buildHighlightedHtml('x', { currentLine: 1, currentLineFocused: false });
    expect(focused).toContain('kl-line-current"');
    expect(blurred).toContain('kl-line-current-unfocused');
  });

  it('an undecided deletion marks the return line red, inline and full-row', () => {
    const html = buildHighlightedHtml('keep\nreturn\nkeep', {
      pendingRemoved: new Set([2]),
      currentLine: 2,
      currentLineFocused: true,
    });
    const rows = html.split('\n');
    expect(rows[0]).not.toContain('kl-line-removed');
    expect(rows[1]).toContain('class="kl-line-removed kl-row-full"');
    expect(rows[1]).not.toContain('kl-line-current'); // red beats the caret
    expect(rows[2]).not.toContain('kl-line-removed');
  });

  it('a replacement line claims GREEN when its run also anchors a deletion', () => {
    // Sir, 2026-10-08: the anchor fix puts a replacement run's −N gutter
    // mark on the run's own (green) line. The line EXISTS with new content,
    // so green owns the row; the gutter carries the deletion. The old
    // precedence painted this line red and hid the AI's change.
    const html = buildHighlightedHtml('a\nB\nc', {
      pendingAdded: new Set([2]),
      pendingRemoved: new Set([2]),
    });
    const rows = html.split('\n');
    expect(rows[1]).toContain('class="kl-line-pending kl-row-full"');
    expect(rows[1]).not.toContain('kl-line-removed');
  });

  it('error and warning still beat the pending marks', () => {
    const html = buildHighlightedHtml('a\nb', {
      lineSeverities: new Map([[1, 'error' as const]]),
      pendingAdded: new Set([1]),
      pendingRemoved: new Set([2]),
    });
    const rows = html.split('\n');
    expect(rows[0]).toContain('class="kl-line-error"');
    expect(rows[1]).toContain('kl-line-removed');
  });

  it('keeps every tint an inline span around the line markup (drift law)', () => {
    const html = buildHighlightedHtml('[gcode_macro FOO]', {
      pendingAdded: new Set([1]),
      currentLine: 1,
    });
    // The class span WRAPS the section markup rather than replacing it.
    expect(html).toMatch(/^<span class="kl-line-pending kl-row-full">.*\[/);
  });
});

describe('buildHighlightedHtml — run-anchor markers (inline pairs, 2026-10-07)', () => {
  it('emits a zero-width keyed marker on the anchored line only', () => {
    const html = buildHighlightedHtml('a\nb\nc', { runAnchors: new Map([[2, '4:2+1-0']]) });
    const rows = html.split('\n');
    expect(rows[0]).toBe('a');
    expect(rows[1]).toBe('<span class="kl-run-anchor" data-run-key="4:2+1-0"></span>b');
    expect(rows[2]).toBe('c');
  });

  it('the marker rides INSIDE the tint wrapper when the line is tinted', () => {
    const html = buildHighlightedHtml('keep\nchanged', {
      pendingAdded: new Set([2]),
      runAnchors: new Map([[2, 'k1']]),
    });
    const row = html.split('\n')[1];
    expect(row.startsWith('<span class="kl-line-pending kl-row-full"><span class="kl-run-anchor" data-run-key="k1"></span>')).toBe(true);
  });

  it('escapes quotes in a run key (attribute safety)', () => {
    const html = buildHighlightedHtml('x', { runAnchors: new Map([[1, 'a"b\\c']]) });
    expect(html).toContain('data-run-key="a&quot;b\\c"');
  });

  it('adds no line boxes and leaves unanchored output byte-identical', () => {
    const text = 'a\nb\nc';
    expect(buildHighlightedHtml(text, { runAnchors: new Map() })).toBe(buildHighlightedHtml(text));
    const anchored = buildHighlightedHtml(text, { runAnchors: new Map([[1, 'k']]) });
    expect(anchored.split('\n')).toHaveLength(3);
    expect(anchored).not.toContain('display:');
    expect(anchored).not.toContain('position:');
  });
});
