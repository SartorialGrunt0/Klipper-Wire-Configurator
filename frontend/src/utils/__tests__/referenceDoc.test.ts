import { describe, expect, it } from 'vitest';
import { extractHeadings, slugifyHeading } from '../referenceDoc';

describe('slugifyHeading', () => {
  it('slugifies plain text', () => {
    expect(slugifyHeading('Format of micro-controller pin names')).toBe('format-of-micro-controller-pin-names');
  });

  it('strips section brackets', () => {
    expect(slugifyHeading('[mcu]')).toBe('mcu');
    expect(slugifyHeading('[gcode_macro <name>]')).toBe('gcode-macro-name');
  });

  it('strips emphasis and backticks', () => {
    expect(slugifyHeading('`safe_z_home` **config**')).toBe('safe-z-home-config');
  });

  it('falls back when nothing remains', () => {
    expect(slugifyHeading('###')).toBe('section');
  });
});

describe('extractHeadings', () => {
  it('extracts levels, text, and deduped ids in order', () => {
    const md = [
      '# Configuration reference',
      'intro paragraph',
      '## Micro-controller configuration',
      '### [mcu]',
      '### [mcu]',
      '#### deep heading',
    ].join('\n');
    const headings = extractHeadings(md);
    expect(headings.map((h) => [h.level, h.text, h.id])).toEqual([
      [1, 'Configuration reference', 'configuration-reference'],
      [2, 'Micro-controller configuration', 'micro-controller-configuration'],
      [3, '[mcu]', 'mcu'],
      [3, '[mcu]', 'mcu-2'],
      [4, 'deep heading', 'deep-heading'],
    ]);
  });

  it('ignores headings inside fenced code blocks', () => {
    const md = ['```', '### [virtual]', 'still inside', '```', '### [real]'].join('\n');
    const headings = extractHeadings(md);
    expect(headings.map((h) => h.text)).toEqual(['[real]']);
  });

  it('handles trailing hash marks', () => {
    const headings = extractHeadings('## [probe] ##');
    expect(headings[0].text).toBe('[probe]');
  });

  it('skips blank heading text', () => {
    const headings = extractHeadings('##\n##   \n### [ok]');
    expect(headings.map((h) => h.text)).toEqual(['[ok]']);
  });
});
