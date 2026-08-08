import { describe, expect, it } from 'vitest';
import {
  normalizeDiffText,
  parsePatch,
  countChangedLines,
  createConfigPatch,
} from '@/utils/configDiff';

describe('normalizeDiffText', () => {
  it('collapses CRLF to LF', () => {
    expect(normalizeDiffText('a\r\nb\r\n')).toBe('a\nb\n');
  });

  it('strips trailing whitespace per line', () => {
    expect(normalizeDiffText('a  \nb\t\nc')).toBe('a\nb\nc');
  });

  it('collapses consecutive blank lines to a single blank line', () => {
    expect(normalizeDiffText('a\n\n\n\nb')).toBe('a\n\nb');
  });
});

describe('parsePatch', () => {
  const patch = [
    '--- original',
    '+++ current',
    '@@ -1,3 +1,3 @@',
    ' context line',
    '-removed line',
    '+added line',
    ' another context',
  ].join('\n');

  it('classifies header, added, removed, and context lines', () => {
    const lines = parsePatch(patch);
    expect(lines).toEqual([
      { type: 'header', content: '@@ -1,3 +1,3 @@' },
      { type: 'context', content: 'context line' },
      { type: 'removed', content: 'removed line' },
      { type: 'added', content: 'added line' },
      { type: 'context', content: 'another context' },
    ]);
  });

  it('ignores --- and +++ file header lines', () => {
    const lines = parsePatch(patch);
    expect(lines.some((l) => l.content === 'original')).toBe(false);
    expect(lines.some((l) => l.content === 'current')).toBe(false);
  });

  it('returns empty array for empty input', () => {
    expect(parsePatch('')).toEqual([]);
  });
});

describe('countChangedLines', () => {
  it('counts added and removed lines, not context or headers', () => {
    const patch = [
      '@@ -1,5 +1,5 @@',
      ' context',
      '-gone',
      '+new',
      ' context',
      '-gone2',
    ].join('\n');
    expect(countChangedLines(patch)).toBe(3);
  });

  it('ignores +++ / --- file headers', () => {
    const patch = ['--- a/file', '+++ b/file', '+real'].join('\n');
    expect(countChangedLines(patch)).toBe(1);
  });
});

describe('createConfigPatch', () => {
  it('produces a two-file patch with the given labels', () => {
    const patch = createConfigPatch(
      'printer.cfg',
      '[printer]\nkinematics: cartesian\n',
      '[printer]\nkinematics: corexy\n',
      'original',
      'current',
    );
    expect(patch).toContain('--- printer.cfg');
    expect(patch).toContain('+++ printer.cfg');
    expect(patch).toContain('-kinematics: cartesian');
    expect(patch).toContain('+kinematics: corexy');
  });

  it('returns a patch with only context when texts are identical', () => {
    const text = '[mcu]\nserial: xyz\n';
    const patch = createConfigPatch('a.cfg', text, text);
    expect(countChangedLines(patch)).toBe(0);
  });
});
