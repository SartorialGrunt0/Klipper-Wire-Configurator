import { beforeEach, describe, expect, it } from 'vitest';

import type { ChangeSetPayload } from '@/services/api';
import { changeSetTotals, useChangeSetStore } from '@/stores/changeSetStore';

const payload = (over: Partial<ChangeSetPayload> = {}): ChangeSetPayload => ({
  edits: [
    {
      id: 'e0', file: 'printer.cfg', section: 'printer', key: 'max_accel',
      op: 'set_param', summary: 'set max_accel', added: 1, removed: 1,
      diffText: '', advisories: [], superseded: false, supersededBy: '',
    },
    {
      id: 'e1', file: 'printer.cfg', section: 'stepper_x', key: 'microsteps',
      op: 'set_param', summary: 'set microsteps', added: 1, removed: 1,
      diffText: '', advisories: [], superseded: false, supersededBy: '',
    },
  ],
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

beforeEach(() => {
  useChangeSetStore.getState().clear();
});

describe('changeSetStore', () => {
  it('publishes a payload as the review view', () => {
    useChangeSetStore.getState().setFromStream('req-1', payload());
    const state = useChangeSetStore.getState();
    expect(state.requestId).toBe('req-1');
    expect(state.view?.rows).toHaveLength(2);
    expect(state.unreviewedCount()).toBe(2);
  });

  it('starts a NEW request with no decisions inherited', () => {
    useChangeSetStore.getState().setFromStream('req-1', payload());
    useChangeSetStore.getState().keepAll();
    expect(useChangeSetStore.getState().unreviewedCount()).toBe(0);

    useChangeSetStore.getState().setFromStream('req-2', payload());
    expect(useChangeSetStore.getState().unreviewedCount()).toBe(2);
    expect(useChangeSetStore.getState().undone).toEqual([]);
  });

  it('keeps decisions when the same request refreshes from the poll', () => {
    useChangeSetStore.getState().setFromStream('req-1', payload());
    useChangeSetStore.getState().undoSection('printer.cfg', 'stepper_x');
    useChangeSetStore.getState().setFromStream('req-1', payload());
    expect(useChangeSetStore.getState().undone).toEqual(['e1']);
    expect(useChangeSetStore.getState().keptIds()).toEqual(['e0']);
  });

  it('drops decisions about rows that no longer exist', () => {
    useChangeSetStore.getState().setFromStream('req-1', payload());
    useChangeSetStore.getState().undoSection('printer.cfg', 'stepper_x');
    const shrunk = payload({ edits: [payload().edits[0]], files: [payload().files[0]] });
    useChangeSetStore.getState().setFromStream('req-1', {
      ...shrunk,
      files: [{ ...shrunk.files[0], sections: [payload().files[0].sections[0]] }],
    });
    expect(useChangeSetStore.getState().undone).toEqual([]);
  });

  it('keepAll marks every row decided without dropping anything', () => {
    useChangeSetStore.getState().setFromStream('req-1', payload());
    useChangeSetStore.getState().keepAll();
    const state = useChangeSetStore.getState();
    expect(state.unreviewedCount()).toBe(0);
    expect(state.keptIds()).toEqual(['e0', 'e1']);
    expect(changeSetTotals(state)).toEqual({ added: 2, removed: 2 });
  });

  it('undoAll drops the whole set and the totals follow', () => {
    useChangeSetStore.getState().setFromStream('req-1', payload());
    useChangeSetStore.getState().undoAll();
    const state = useChangeSetStore.getState();
    expect(state.keptIds()).toEqual([]);
    expect(state.unreviewedCount()).toBe(0);
    expect(changeSetTotals(state)).toEqual({ added: 0, removed: 0 });
  });

  it('undoes one section without touching the other', () => {
    useChangeSetStore.getState().setFromStream('req-1', payload());
    useChangeSetStore.getState().undoSection('printer.cfg', 'stepper_x');
    const state = useChangeSetStore.getState();
    expect(state.keptIds()).toEqual(['e0']);
    expect(changeSetTotals(state)).toEqual({ added: 1, removed: 1 });
    expect(state.unreviewedCount()).toBe(0);
  });

  it('undoes a whole file', () => {
    useChangeSetStore.getState().setFromStream('req-1', payload());
    useChangeSetStore.getState().undoFile('printer.cfg');
    expect(useChangeSetStore.getState().keptIds()).toEqual([]);
  });

  it('re-undosing the same section does not duplicate the ledger', () => {
    useChangeSetStore.getState().setFromStream('req-1', payload());
    useChangeSetStore.getState().undoSection('printer.cfg', 'stepper_x');
    useChangeSetStore.getState().undoSection('printer.cfg', 'stepper_x');
    expect(useChangeSetStore.getState().undone).toEqual(['e1']);
  });

  it('tracks unfolded rows per id and clears them with the request', () => {
    useChangeSetStore.getState().setFromStream('req-1', payload());
    useChangeSetStore.getState().toggleExpanded('e0');
    expect(useChangeSetStore.getState().expanded).toEqual(['e0']);
    useChangeSetStore.getState().toggleExpanded('e0');
    expect(useChangeSetStore.getState().expanded).toEqual([]);
    useChangeSetStore.getState().toggleExpanded('e0');
    useChangeSetStore.getState().setFromStream('req-2', payload());
    expect(useChangeSetStore.getState().expanded).toEqual([]);
  });

  it('an empty payload clears the view instead of stranding rows', () => {
    useChangeSetStore.getState().setFromStream('req-1', payload());
    useChangeSetStore.getState().setFromStream('req-1', null);
    expect(useChangeSetStore.getState().view).toBeNull();
    expect(useChangeSetStore.getState().unreviewedCount()).toBe(0);
  });
});
