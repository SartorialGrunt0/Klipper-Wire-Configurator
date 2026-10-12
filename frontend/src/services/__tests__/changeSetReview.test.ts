import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/api', () => ({
  parseConfigText: vi.fn(async (text: string, file: string) => ({
    config: { filename: file, raw_text: text, sections: [], includes: [], header_comments: [] },
  })),
  exportConfig: vi.fn(async (cf: { raw_text?: string }) => cf.raw_text ?? ''),
  validateConfig: vi.fn(async () => ({ has_errors: false, has_warnings: false, errors: [] })),
  validateProject: vi.fn(async () => ({})),
  loadNativeLayout: vi.fn(async () => ({ layout: null })),
}));

import * as api from '@/services/api';
import { applyStagedEdits, buildDecisionContext, discardReview } from '@/services/changeSetReview';
import { ledgerFrom } from '@/services/reviewEngine';
import { useChangeSetStore } from '@/stores/changeSetStore';
import { useConfigStore } from '@/stores/configStore';
import { usePendingEditStore } from '@/stores/pendingEditStore';
import type { PendingDiffModel } from '@/utils/pendingDiff';

/**
 * What is LEFT of the old decision engine after the mechanical ledger took the
 * decisions (Sir, 2026-10-07). The keep/undo verbs and the server `resolve`
 * replay are gone — `services/reviewEngine` owns them. These tests pin the two
 * things the engine still reuses: the ONE apply path and the buffer-discard.
 */

const cfg = (raw_text: string) => ({
  filename: 'printer.cfg',
  sections: [],
  includes: [],
  header_comments: [],
  raw_text,
});

beforeEach(() => {
  vi.clearAllMocks();
  useChangeSetStore.getState().clear();
  useConfigStore.setState({
    configFiles: {},
    liveTexts: {},
    originalTexts: {},
    activeFile: 'printer.cfg',
    isDirty: false,
  });
});

describe('applyStagedEdits', () => {
  it('applies an upsert through the config store and marks the project dirty', async () => {
    const failed = await applyStagedEdits([
      { file: 'printer.cfg', op: 'update', summary: '', newText: 'X' },
    ]);
    expect(failed).toEqual([]);
    expect(useConfigStore.getState().configFiles['printer.cfg'].raw_text).toBe('X');
    expect(useConfigStore.getState().isDirty).toBe(true);
  });

  it('removes a file for a delete_file op', async () => {
    useConfigStore.setState({ configFiles: { 'printer.cfg': cfg('A') } });
    const failed = await applyStagedEdits([
      { file: 'printer.cfg', op: 'delete_file', summary: '', newText: '' },
    ]);
    expect(failed).toEqual([]);
    expect(useConfigStore.getState().configFiles['printer.cfg']).toBeUndefined();
  });

  it('reports a file whose text could not be parsed', async () => {
    vi.mocked(api.parseConfigText).mockRejectedValueOnce(new Error('bad text'));
    const failed = await applyStagedEdits([
      { file: 'printer.cfg', op: 'update', summary: '', newText: 'X' },
    ]);
    expect(failed).toEqual(['printer.cfg']);
  });

  it('is a no-op with no edits', async () => {
    expect(await applyStagedEdits([])).toEqual([]);
    expect(useConfigStore.getState().isDirty).toBe(false);
  });

  it('publishes the ledger live-text for a NON-active file, so the review appears without a file switch', async () => {
    // Sir's bug report 2026-10-11: with printer.cfg selected, an edit staged
    // into Hotkey.cfg applied but the chat footer stayed hidden until the
    // view switched to Hotkey.cfg. Cause: `liveTextFor` prefers the store's
    // `liveTexts` over `raw_text`, and a previously-VIEWED file keeps a stale
    // entry there — the staging wrote the model but not the live side, so
    // diff(FRAME, LIVE) netted zero runs. The fix pairs the writes, exactly
    // as the engine's own `applyLive` does.
    useConfigStore.setState({
      configFiles: {
        'printer.cfg': cfg('[printer]\nmax_velocity: 200\n'),
        'Hotkey.cfg': cfg('[gcode_macro HOTKEY_1]\ngcode:\n  M117 one\n'),
      },
      activeFile: 'printer.cfg',
    });
    // The user viewed Hotkey.cfg earlier this session: the editor published
    // its export into liveTexts, and it stays after the buffer moves on.
    useConfigStore.getState().setLiveText('Hotkey.cfg', '[gcode_macro HOTKEY_1]\ngcode:\n  M117 one\n');

    const before = '[gcode_macro HOTKEY_1]\ngcode:\n  M117 one\n';
    const after = '[gcode_macro HOTKEY_1]\ngcode:\n  M117 AI-edited\n';
    const failed = await applyStagedEdits([
      { file: 'Hotkey.cfg', op: 'update', summary: '', newText: after },
    ]);
    expect(failed).toEqual([]);
    useChangeSetStore.getState().seedFrames({ 'Hotkey.cfg': before });

    expect(useConfigStore.getState().liveTexts['Hotkey.cfg']).toBe(after);
    // What the footer renders: the ledger must see the run with the view
    // still on printer.cfg.
    const files = ledgerFrom({
      reviewFrames: useChangeSetStore.getState().reviewFrames,
      liveTexts: useConfigStore.getState().liveTexts,
      configFiles: useConfigStore.getState().configFiles,
    });
    expect(files.flatMap((f) => f.runs).length).toBe(1);
  });
});

describe('buildDecisionContext', () => {
  it("carries each loaded file's text and a label", async () => {
    useConfigStore.setState({ configFiles: { 'printer.cfg': cfg('A') }, activeFile: 'printer.cfg' });
    const ctx = await buildDecisionContext();
    expect(ctx['printer.cfg'].content).toBe('A');
    expect(ctx['printer.cfg'].label).toMatch(/Active/);
  });
});

/**
 * A wholesale replacement of the working buffer — Revert, a fresh generate, a
 * re-read from the Pi — takes the review with it: the frame belongs to a file
 * state that no longer exists.
 */
describe('discardReview', () => {
  beforeEach(() => {
    usePendingEditStore.setState({
      pending: { approvalId: 'stale' } as unknown as PendingDiffModel,
      takeover: 'shown',
    });
  });

  it('drops the review frames and the pending card slot', () => {
    useChangeSetStore.setState({ reviewFrames: { 'printer.cfg': 'FRAME' } });
    discardReview();

    expect(useChangeSetStore.getState().segments).toEqual([]);
    expect(useChangeSetStore.getState().view).toBeNull();
    expect(useChangeSetStore.getState().reviewFrames).toEqual({});
    expect(usePendingEditStore.getState().pending).toBeNull();
    expect(usePendingEditStore.getState().takeover).toBe('auto');
  });
});
