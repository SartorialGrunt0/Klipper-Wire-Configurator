import { describe, expect, it } from 'vitest';
import { EXPIRY_PRESETS, expiryFromPreset } from '../keyExpiry';

describe('expiryFromPreset', () => {
  const now = new Date('2026-11-23T12:00:00Z');

  it('maps every preset except never to a YYYY-MM-DD date', () => {
    for (const p of EXPIRY_PRESETS.filter((x) => x.value !== 'never')) {
      const iso = expiryFromPreset(p.value, now);
      expect(iso).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("'never' means no expiry (null)", () => {
    expect(expiryFromPreset('never', now)).toBeNull();
  });

  it('lands the documented day offsets from the given date', () => {
    expect(expiryFromPreset('30d', now)).toBe('2026-12-23');
    expect(expiryFromPreset('90d', now)).toBe('2027-02-21');
    expect(expiryFromPreset('6mo', now)).toBe('2027-05-25');
    expect(expiryFromPreset('1y', now)).toBe('2027-11-23');
  });

  it('Never is the default (first) option', () => {
    expect(EXPIRY_PRESETS[0].value).toBe('never');
  });
});
