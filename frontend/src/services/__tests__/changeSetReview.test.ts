import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/api', () => ({
  parseConfigText: vi.fn(async (text: string, file: string) => ({
    config: { filename: file, raw_text: text, sections: [] },
  })),
  exportConfig: vi.fn(async (cf: { raw_text?: string }) => cf.raw_text ?? ''),
  validateConfig: vi.fn(async () => ({ has_errors: false, has_warnings: false, errors: [] })),
  validateProject: vi.fn(async () => ({})),
}));

import * as api from '@/services/api';
import { applyStagedEdits, buildDecisionContext, discardReview } from '@/services/changeSetReview';
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
