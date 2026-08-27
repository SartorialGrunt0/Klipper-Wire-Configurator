import { describe, expect, it } from 'vitest';
import { ISSUE_MARKER, issueSeverityOf } from '../issueMarker';

describe('issueMarker', () => {
  it('error and warning keep their existing markers and colors', () => {
    expect(ISSUE_MARKER.error.marker).toBe('●');
    expect(ISSUE_MARKER.error.color).toBe('var(--color-error)');
    expect(ISSUE_MARKER.warning.marker).toBe('▲');
    expect(ISSUE_MARKER.warning.color).toBe('var(--color-warning)');
  });

  it('info uses a muted grey from the existing UI palette (Q1)', () => {
    // The grey family of the default save button — bg-tertiary background /
    // text-secondary text — not a new color token.
    expect(ISSUE_MARKER.info.color).toBe('var(--color-text-secondary)');
    expect(ISSUE_MARKER.info.dotClass).toContain('bg-[var(--color-text-secondary)]');
    expect(ISSUE_MARKER.info.marker).not.toBe(ISSUE_MARKER.error.marker);
    expect(ISSUE_MARKER.info.marker).not.toBe(ISSUE_MARKER.warning.marker);
  });

  it('info row marker is the circle-i glyph (flash-menu info icon), not a dot', () => {
    // Reuses the flash-menu "circle with an i" info icon, rendered grey.
    expect(ISSUE_MARKER.info.marker).toBe('ⓘ');
  });

  it('info is lower emphasis: smaller gutter dot with opacity', () => {
    expect(ISSUE_MARKER.info.gutterDotClass).toContain('w-1.5');
    expect(ISSUE_MARKER.info.gutterDotClass).toContain('opacity-');
    expect(ISSUE_MARKER.error.gutterDotClass).toContain('w-2');
  });

  it('normalizes unknown severity strings to info (never drops an issue)', () => {
    expect(issueSeverityOf('info')).toBe('info');
    expect(issueSeverityOf('error')).toBe('error');
    expect(issueSeverityOf('warning')).toBe('warning');
    expect(issueSeverityOf('someday')).toBe('info');
    expect(issueSeverityOf('')).toBe('info');
  });

  it('every severity spec carries a non-empty marker and title', () => {
    for (const spec of Object.values(ISSUE_MARKER)) {
      expect(spec.marker.length).toBeGreaterThan(0);
      expect(spec.title.length).toBeGreaterThan(0);
      expect(spec.color.startsWith('var(--color-')).toBe(true);
    }
  });
});
