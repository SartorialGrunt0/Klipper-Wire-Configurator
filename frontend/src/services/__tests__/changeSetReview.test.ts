import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/api', () => ({
  resolveChangeSet: vi.fn(),
  parseConfigText: vi.fn(async (text: string, file: string) => ({
    config: { filename: file, raw_text: text, sections: [] },
  })),
  exportConfig: vi.fn(async (cf: { raw_text?: string }) => cf.raw_text ?? ''),
  validateConfig: vi.fn(async () => ({ has_errors: false, has_warnings: false, errors: [] })),
  validateProject: vi.fn(async () => ({})),
}));

import * as api from '@/services/api';
import type { ChangeSetPayload } from '@/services/api';
import { useChangeSetStore } from '@/stores/changeSetStore';
import { useConfigStore } from '@/stores/configStore';
import { usePendingEditStore } from '@/stores/pendingEditStore';
import type { PendingDiffModel } from '@/utils/pendingDiff';
import {
  discardReview, keepSection, resolveChangeSet, undoSection,
} from '@/services/changeSetReview';

/**
 * The decision engine is ONE implementation for both surfaces (the chat's
 * footer bar and the text view's pane). These tests pin the laws it exists to
 * keep: keep never touches the network, undo is a server replay whose result
 * goes through the shared apply path, and the status both surfaces render
 * (`busy`, `note`) tells the truth on every exit.
 */

const payload = (): ChangeSetPayload => ({
  edits: [
    {
      id: 'e0', file: 'printer.cfg', section: 'printer', key: 'max_accel',
      op: 'set_param', summary: 'set max_accel', added: 1, removed: 1,
      diffText: '-max_accel: 1000\n+max_accel: 3000', advisories: [],
      superseded: false, supersededBy: '',
    },
    {
      id: 'e1', file: 'printer.cfg', section: 'stepper_x', key: 'microsteps',
      op: 'set_param', summary: 'set microsteps', added: 1, removed: 1,
      diffText: '-microsteps: 16\n+microsteps: 32', advisories: [],
      superseded: false, supersededBy: '',
    },
  ],
  files: [
    {
      file: 'printer.cfg', added: 2, removed: 2,
      sections: [
        { file: 'printer.cfg', section: 'printer', added: 1, removed: 1, edits: ['e0'], advisories: { error: 0, warning: 0, other: 0 } },
        { file: 'printer.cfg', section: 'stepper_x', added: 1, removed: 1, edits: ['e1'], advisories: { error: 0, warning: 0, other: 0 } },
      ],
      beforeText: '[printer]\nmax_accel: 1000\n\n[stepper_x]\nmicrosteps: 16\n',
    },
  ],
  totalAdded: 2,
  totalRemoved: 2,
  createdFiles: [],
});

type Resolved = Awaited<ReturnType<typeof api.resolveChangeSet>>;

const resolvedOk = (content: string): Resolved => ({
  status: 'ok',
  files: { 'printer.cfg': { content, deleted: false } },
  stale: [],
});

beforeEach(() => {
  vi.clearAllMocks();
  useChangeSetStore.getState().clear();
  useConfigStore.setState({
    configFiles: {
      // The editor holds the staged text the backend pushed — this is what
      // rides along as "the client's working state".
      'printer.cfg': {
        filename: 'printer.cfg',
        sections: [],
        includes: [],
        header_comments: [],
        raw_text: '[printer]\nmax_accel: 1000\n\n[stepper_x]\nmicrosteps: 32\n',
      },
    },
    originalTexts: {},
    isDirty: true,
    activeFile: 'printer.cfg',
  });
  useChangeSetStore.getState().setFromStream('req-1', payload());
});

describe('keep', () => {
  it('decides and replays too — the marks are defined by the DECIDED set', async () => {
    vi.mocked(api.resolveChangeSet).mockResolvedValue({
      ...resolvedOk('[printer]\nmax_accel: 3000\n'),
      frames: { 'printer.cfg': 'FRAME-WITH-KEPT-ONLY' },
    });
    await keepSection('printer.cfg', 'printer', ['req-1:e0']);

    expect(useChangeSetStore.getState().kept).toEqual(['req-1:e0']);
    expect(api.resolveChangeSet).toHaveBeenCalledTimes(1);
    const sent = vi.mocked(api.resolveChangeSet).mock.calls[0][0];
    // The TEXT keeps everything (a keep drops nothing) …
    expect(sent.segments[0].keptEditIds).toEqual(['e0', 'e1']);
    // … while the FRAME holds only what has been decided, which is what
    // stops the kept edit being marked.
    expect(sent.segments[0].frameKeptEditIds).toEqual(['e0']);
    expect(useChangeSetStore.getState().frames).toEqual({ 'printer.cfg': 'FRAME-WITH-KEPT-ONLY' });
    expect(useChangeSetStore.getState().busy).toBe(false);
  });
});

describe('undo', () => {
  it('replays the kept ops and applies the returned text to the editor', async () => {
    vi.mocked(api.resolveChangeSet).mockResolvedValue(resolvedOk('[printer]\nmax_accel: 3000\n'));
    await undoSection('printer.cfg', 'stepper_x', ['req-1:e1']);

    // The chain is the KEEP list: everything except what was undone.
    expect(api.resolveChangeSet).toHaveBeenCalledTimes(1);
    const sent = vi.mocked(api.resolveChangeSet).mock.calls[0][0];
    expect(sent.segments).toEqual([
      { requestId: 'req-1', keptEditIds: ['e0'], frameKeptEditIds: [] },
    ]);
    // The client's working text rides along — it is what stops a replay from
    // clobbering a hand edit.
    expect(Object.keys(sent.contextFiles ?? {})).toContain('printer.cfg');

    expect(useConfigStore.getState().configFiles['printer.cfg'].raw_text)
      .toBe('[printer]\nmax_accel: 3000\n');
    expect(useChangeSetStore.getState().undone).toEqual(['req-1:e1']);
    expect(useChangeSetStore.getState().busy).toBe(false);
    expect(useChangeSetStore.getState().note).toBeNull();
  });

  it('reports a change set that is gone instead of pretending it replayed', async () => {
    vi.mocked(api.resolveChangeSet).mockResolvedValue({ status: 'not_found' });
    await undoSection('printer.cfg', 'stepper_x', ['req-1:e1']);
    expect(useChangeSetStore.getState().note).toMatch(/no longer available/);
    expect(useChangeSetStore.getState().busy).toBe(false);
  });

  it('names the ops the server could not re-apply', async () => {
    vi.mocked(api.resolveChangeSet).mockResolvedValue({
      ...resolvedOk('[printer]\nmax_accel: 3000\n'),
      stale: [{ id: 'e0', file: 'printer.cfg', reason: 'anchor moved' }],
    });
    await undoSection('printer.cfg', 'stepper_x', ['req-1:e1']);
    expect(useChangeSetStore.getState().note).toContain('could not be re-applied');
    expect(useChangeSetStore.getState().note).toContain('anchor moved');
  });

  it('is busy while the replay is in flight, in the store both surfaces read', async () => {
    let release: (value: Resolved) => void = () => {};
    vi.mocked(api.resolveChangeSet).mockReturnValue(
      new Promise<Resolved>((resolve) => { release = resolve; }),
    );
    const inFlight = undoSection('printer.cfg', 'stepper_x', ['req-1:e1']);
    expect(useChangeSetStore.getState().busy).toBe(true);
    release(resolvedOk('[printer]\nmax_accel: 3000\n'));
    await inFlight;
    expect(useChangeSetStore.getState().busy).toBe(false);
  });

  it('stores the frame the server replayed for the decided set', async () => {
    vi.mocked(api.resolveChangeSet).mockResolvedValue({
      ...resolvedOk('[printer]\nmax_accel: 3000\n'),
      frames: { 'printer.cfg': 'FRAME-WITH-KEPT-ONLY' },
    });
    await undoSection('printer.cfg', 'stepper_x', ['req-1:e1']);
    expect(useChangeSetStore.getState().frames).toEqual({ 'printer.cfg': 'FRAME-WITH-KEPT-ONLY' });
  });

  it('clears the frame when nothing is decided, so the pane uses the pre-review text', async () => {
    useChangeSetStore.setState({ frames: { 'printer.cfg': 'STALE' } });
    vi.mocked(api.resolveChangeSet).mockResolvedValue(resolvedOk('[printer]\nmax_accel: 3000\n'));
    await resolveChangeSet();
    expect(useChangeSetStore.getState().frames).toEqual({});
  });

  it('says so when the server text cannot be applied to the editor', async () => {
    vi.mocked(api.resolveChangeSet).mockResolvedValue(resolvedOk('x'));
    vi.mocked(api.parseConfigText).mockRejectedValueOnce(new Error('bad text'));
    await resolveChangeSet();
    expect(useChangeSetStore.getState().note).toContain('printer.cfg');
    expect(useChangeSetStore.getState().busy).toBe(false);
  });
});

/**
 * A wholesale replacement of the working buffer — Revert, a fresh generate, a
 * re-read from the Pi — takes the review with it.
 *
 * Live report 2026-10-04 (Cliff): *ask the chat to add something → revert →
 * ask it to add something else → the reverted addition is back in the diff.*
 * The change set is a running total, and every UNDECIDED row is replayed as
 * KEPT, so a segment that survived the revert replays its ops onto the oldest
 * baseline and writes the discarded edit back into the file.
 */
describe('a discarded working buffer', () => {
  beforeEach(() => {
    usePendingEditStore.setState({
      pending: { approvalId: 'stale' } as unknown as PendingDiffModel,
      takeover: 'shown',
    });
  });

  it('drops the review, so no later decision can replay it back in', () => {
    discardReview();

    expect(useChangeSetStore.getState().segments).toEqual([]);
    expect(useChangeSetStore.getState().view).toBeNull();
    expect(useChangeSetStore.getState().frames).toEqual({});
    expect(usePendingEditStore.getState().pending).toBeNull();
    expect(usePendingEditStore.getState().takeover).toBe('auto');

    // A later request stages its own change. Its decision chain is that
    // request ALONE: the reverted edit is not in the buffer, so replaying it
    // would be inventing text.
    useChangeSetStore.getState().setFromStream('req-2', payload());
    const segments = useChangeSetStore.getState().resolveSegments();
    expect(segments.map((segment) => segment.requestId)).toEqual(['req-2']);
  });

  it('control: an UNDISCARDED review still spans requests', () => {
    // The running total is the wanted behaviour when the buffer is intact —
    // this is the behaviour the discard exists to end.
    useChangeSetStore.getState().setFromStream('req-2', payload());
    expect(useChangeSetStore.getState().resolveSegments().map((segment) => segment.requestId))
      .toEqual(['req-1', 'req-2']);
  });
});
