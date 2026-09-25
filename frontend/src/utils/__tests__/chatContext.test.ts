import { afterEach, describe, expect, it, vi } from 'vitest';
import { selectUnsavedDrafts, UNSAVED_DELTA_MAX_TOTAL_BYTES } from '../chatContext';
import { useConfigStore } from '../../stores/configStore';
import type { ConfigFile } from '../../types/config';

const cfg = (filename: string): ConfigFile => ({
  filename, sections: [], includes: [], header_comments: [], raw_text: '',
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('selectUnsavedDrafts', () => {
  it('picks a file with no saved baseline (AI-created approved draft)', () => {
    const picked = selectUnsavedDrafts(
      { 'printer.cfg': cfg('printer.cfg'), 'prepare_bed_mesh.cfg': cfg('prepare_bed_mesh.cfg') },
      { 'printer.cfg': '[printer]\n' },
      { 'printer.cfg': '[printer]\n', 'prepare_bed_mesh.cfg': '[gcode_macro X]\n' },
      new Set(['printer.cfg']),
    );
    expect(picked).toEqual(['prepare_bed_mesh.cfg']);
  });

  it('picks a file whose text differs from the saved baseline', () => {
    const picked = selectUnsavedDrafts(
      { 'printer.cfg': cfg('printer.cfg') },
      { 'printer.cfg': '[printer]\nmax_accel: 3000\n' },
      { 'printer.cfg': '[printer]\nmax_accel: 4000\n' },
      new Set(),
    );
    expect(picked).toEqual(['printer.cfg']);
  });

  it('skips files identical to the saved baseline (mirror carries them)', () => {
    const picked = selectUnsavedDrafts(
      { 'aux_fan.cfg': cfg('aux_fan.cfg') },
      { 'aux_fan.cfg': '[fan]\npin: PA0\n' },
      { 'aux_fan.cfg': '[fan]\npin: PA0\n' },
      new Set(),
    );
    expect(picked).toEqual([]);
  });

  it('newline style alone does not count as a change', () => {
    const picked = selectUnsavedDrafts(
      { 'aux_fan.cfg': cfg('aux_fan.cfg') },
      { 'aux_fan.cfg': '[fan]\r\npin: PA0\r\n' },
      { 'aux_fan.cfg': '[fan]\npin: PA0\n' },
      new Set(),
    );
    expect(picked).toEqual([]);
  });

  it('never re-adds a key already in the payload', () => {
    const picked = selectUnsavedDrafts(
      { 'printer.cfg': cfg('printer.cfg') },
      {}, // no baseline at all -> would be picked...
      { 'printer.cfg': '[printer]\n' },
      new Set(['printer.cfg']),
    );
    expect(picked).toEqual([]);
  });

  it('skips files with no text available', () => {
    const picked = selectUnsavedDrafts(
      { 'broken.cfg': cfg('broken.cfg') },
      {},
      {},
      new Set(),
    );
    expect(picked).toEqual([]);
  });

  it('caps total bytes and keeps store order', () => {
    const big = 'x'.repeat(1000);
    const files = { 'a.cfg': cfg('a.cfg'), 'b.cfg': cfg('b.cfg'), 'c.cfg': cfg('c.cfg') };
    const texts = { 'a.cfg': big, 'b.cfg': big, 'c.cfg': big };
    const picked = selectUnsavedDrafts(files, {}, texts, new Set(), 2000);
    expect(picked).toEqual(['a.cfg', 'b.cfg']);
    // Default cap: everything fits.
    expect(
      selectUnsavedDrafts(files, {}, texts, new Set()),
    ).toEqual(['a.cfg', 'b.cfg', 'c.cfg']);
    expect(UNSAVED_DELTA_MAX_TOTAL_BYTES).toBeGreaterThan(2000);
  });

  it('multi-byte content measured in bytes, not characters', () => {
    const unicode = 'é'.repeat(10); // 20 bytes utf-8
    const picked = selectUnsavedDrafts(
      { 'u.cfg': cfg('u.cfg') },
      {},
      { 'u.cfg': unicode },
      new Set(),
      15,
    );
    expect(picked).toEqual([]);
  });

  it('store flow: an approved-but-unsaved AI file is picked next turn', () => {
    // Dogfood 2026-09-25: turn 1 config_write + approve put
    // prepare_bed_mesh.cfg into the store as a dirty draft (no saved
    // baseline). Turn 2 checks NOTHING in "Include Files" — the draft
    // must still reach the edit session, or add_include reports
    // 'Include file not found' for a file the user can see.
    useConfigStore.setState({ configFiles: {}, originalTexts: {}, isDirty: false });
    vi.useFakeTimers(); // updateConfigFile schedules a debounced revalidation fetch
    useConfigStore.getState().setConfigFile('printer.cfg', cfg('printer.cfg'));
    useConfigStore.getState().setOriginalText('printer.cfg', '[printer]\n');
    useConfigStore.getState().updateConfigFile('prepare_bed_mesh.cfg', cfg('prepare_bed_mesh.cfg'));

    const state = useConfigStore.getState();
    const texts = {
      'printer.cfg': '[printer]\n',
      'prepare_bed_mesh.cfg': '[gcode_macro PREPARE_BED_MESH]\n',
    };
    const picked = selectUnsavedDrafts(
      state.configFiles, state.originalTexts, texts, new Set<string>(),
    );
    expect(state.isDirty).toBe(true);
    expect(picked).toEqual(['prepare_bed_mesh.cfg']);
  });
});
