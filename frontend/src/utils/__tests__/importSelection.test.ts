import { describe, expect, it } from 'vitest';
import { buildInitialSelection, findOverlappingFiles } from '../importSelection';

describe('buildInitialSelection', () => {
  it('defaults .cfg files to checked, skips known non-klipper files', () => {
    const sel = buildInitialSelection([
      'printer.cfg',
      'moonraker.conf',
      'macros.cfg',
      'printer-20250810_142619.cfg',
    ]);
    expect(sel['printer.cfg']).toBe(true);
    expect(sel['macros.cfg']).toBe(true);
    expect(sel['moonraker.conf']).toBe(false);
    expect(sel['printer-20250810_142619.cfg']).toBe(false);
  });

  it('skips backup extensions case-insensitively', () => {
    const sel = buildInitialSelection(['old.cfg.bak', 'stale.cfg.OLD', 'webcam.txt', 'ok.cfg']);
    expect(sel['old.cfg.bak']).toBe(false);
    expect(sel['stale.cfg.OLD']).toBe(false);
    expect(sel['webcam.txt']).toBe(false);
    expect(sel['ok.cfg']).toBe(true);
  });

  it('skips other known non-klipper config files case-insensitively', () => {
    const sel = buildInitialSelection(['Crowsnest.Conf', 'KLIPPERSCREEN.CONF', 'sonar.conf']);
    expect(sel['Crowsnest.Conf']).toBe(false);
    expect(sel['KLIPPERSCREEN.CONF']).toBe(false);
    expect(sel['sonar.conf']).toBe(false);
  });
});

describe('findOverlappingFiles', () => {
  it('returns selected names that already exist in the project, preserving selection order', () => {
    expect(
      findOverlappingFiles({ 'printer.cfg': true, 'other.cfg': true, 'skip.cfg': true }, [
        'printer.cfg',
        'other.cfg',
      ]),
    ).toEqual(['printer.cfg', 'other.cfg']);
  });

  it('ignores deselected files', () => {
    expect(findOverlappingFiles({ 'printer.cfg': false, 'other.cfg': true }, ['printer.cfg'])).toEqual([]);
  });

  it('returns [] when nothing overlaps', () => {
    expect(findOverlappingFiles({ 'printer.cfg': true }, ['other.cfg'])).toEqual([]);
  });
});
