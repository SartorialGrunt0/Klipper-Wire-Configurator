import { beforeEach, describe, expect, it } from 'vitest';

import type { ChangeSetPayload } from '@/services/api';
import { useChangeSetStore } from '@/stores/changeSetStore';

const edit = (id: string, section: string) => ({
  id,
  file: 'printer.cfg',
  section,
  key: 'k',
  op: 'set_param',
  summary: `set ${id}`,
  added: 1,
  removed: 1,
  diffText: '',
  advisories: [],
  superseded: false,
  supersededBy: '',
});

const payload = (over: Partial<ChangeSetPayload> = {}): ChangeSetPayload => ({
  edits: [edit('e0', 'printer'), edit('e1', 'stepper_x')],
  files: [
    {
      file: 'printer.cfg',
      added: 2,
      removed: 2,
      sections: [
        {
          file: 'printer.cfg', section: 'printer', added: 1, removed: 1,
          edits: ['e0'], advisories: { error: 0, warning: 0, other: 0 },
        },
        {
          file: 'printer.cfg', section: 'stepper_x', added: 1, removed: 1,
          edits: ['e1'], advisories: { error: 0, warning: 0, other: 0 },
        },
      ],
    },
  ],
  totalAdded: 2,
  totalRemoved: 2,
  createdFiles: [],
  ...over,
});

/** A second message: new request id, its own row ids. */
const secondPayload = (): ChangeSetPayload => ({
  ...payload(),
  edits: [edit('e0', 'printer')],
  files: [{
    file: 'printer.cfg',
    added: 1,
    removed: 1,
    sections: [{
      file: 'printer.cfg', section: 'printer', added: 1, removed: 1,
      edits: ['e0'], advisories: { error: 0, warning: 0, other: 0 },
    }],
  }],
  totalAdded: 1,
  totalRemoved: 1,
});

const state = () => useChangeSetStore.getState();

beforeEach(() => {
  state().clear();
});

describe('changeSetStore', () => {
  it('publishes a payload as the review view', () => {
    state().setFromStream('req-1', payload());
    expect(state().segments.map((segment) => segment.requestId)).toEqual(['req-1']);
    expect(state().view?.rows.map((row) => row.id)).toEqual(['req-1:e0', 'req-1:e1']);
  });

  it('KEEPS a running total across messages (Sir, 2026-10-02)', () => {
    state().setFromStream('req-1', payload());
    state().setFromStream('req-2', secondPayload());
    // Both requests are still listed, oldest first, with namespaced ids.
    expect(state().segments.map((segment) => segment.requestId)).toEqual(['req-1', 'req-2']);
    expect(state().view?.rows.map((row) => row.id)).toEqual([
      'req-1:e0', 'req-1:e1', 'req-2:e0',
    ]);
  });

  it('re-publishing the SAME request refreshes it without duplicating', () => {
    state().setFromStream('req-1', payload());
    state().setFromStream('req-1', payload());
    expect(state().segments).toHaveLength(1);
    expect(state().view?.rows).toHaveLength(2);
  });

  it('an empty payload removes that request, leaving the rest of the total', () => {
    state().setFromStream('req-1', payload());
    state().setFromStream('req-2', secondPayload());
    state().setFromStream('req-2', null);
    expect(state().segments.map((segment) => segment.requestId)).toEqual(['req-1']);
    expect(state().view?.rows).toHaveLength(2);
  });

  it('tracks unfolded rows per id', () => {
    state().setFromStream('req-1', payload());
    state().toggleExpanded('req-1:e0');
    expect(state().expanded).toEqual(['req-1:e0']);
    state().toggleExpanded('req-1:e0');
    expect(state().expanded).toEqual([]);
  });

  it('drops unfolded rows that no longer exist', () => {
    state().setFromStream('req-1', payload());
    state().toggleExpanded('req-1:e1');
    const shrunk = payload({ edits: [edit('e0', 'printer')] });
    state().setFromStream('req-1', {
      ...shrunk,
      files: [{ ...shrunk.files[0], sections: [payload().files[0].sections[0]] }],
    });
    expect(state().expanded).toEqual([]);
  });

  it('clear forgets everything, including the review frames', () => {
    state().setFromStream('req-1', payload());
    state().seedFrames({ 'printer.cfg': 'FRAME' });
    state().clear();
    expect(state().view).toBeNull();
    expect(state().segments).toEqual([]);
    expect(state().reviewFrames).toEqual({});
  });
});

/**
 * The ledger's FRAMES (Sir, 2026-10-07): seeded once per request, never
 * clobbering a review already in progress.
 */
describe('review frames', () => {
  it('seeds each file only when the key is not already present', () => {
    state().seedFrames({ 'printer.cfg': 'PRE-REVIEW', 'other.cfg': 'B' });
    expect(state().reviewFrames).toEqual({ 'printer.cfg': 'PRE-REVIEW', 'other.cfg': 'B' });

    // A review in progress keeps its frame — a later poll must not reset it.
    state().seedFrames({ 'printer.cfg': 'STALE', 'third.cfg': 'C' });
    expect(state().reviewFrames['printer.cfg']).toBe('PRE-REVIEW');
    expect(state().reviewFrames['third.cfg']).toBe('C');
  });

  it('a created file seeds a null frame', () => {
    state().seedFrames({ 'new.cfg': null });
    expect(state().reviewFrames['new.cfg']).toBeNull();
  });

  it('setReviewFrame replaces one file and removeReviewFrame drops one', () => {
    state().seedFrames({ 'a.cfg': 'A', 'b.cfg': 'B' });
    state().setReviewFrame('a.cfg', 'A');
    expect(state().reviewFrames['a.cfg']).toBe('A');
    state().setReviewFrame('a.cfg', 'A2');
    expect(state().reviewFrames['a.cfg']).toBe('A2');
    state().removeReviewFrame('a.cfg');
    expect('a.cfg' in state().reviewFrames).toBe(false);
    expect(state().reviewFrames['b.cfg']).toBe('B');
  });
});
