import { beforeEach, describe, expect, it } from 'vitest';

import type { ChangeSetPayload } from '@/services/api';
import { changeSetTotals, useChangeSetStore } from '@/stores/changeSetStore';

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

const state = () => useChangeSetStore.getState();

beforeEach(() => {
  state().clear();
});

describe('changeSetStore', () => {
  it('publishes a payload as the review view', () => {
    state().setFromStream('req-1', payload());
    expect(state().requestId).toBe('req-1');
    expect(state().view?.rows).toHaveLength(2);
    expect(state().unreviewedCount()).toBe(2);
    expect(state().pendingIds()).toEqual(['e0', 'e1']);
  });

  it('starts a NEW request with no decisions inherited', () => {
    state().setFromStream('req-1', payload());
    state().keepAll();
    expect(state().unreviewedCount()).toBe(0);

    state().setFromStream('req-2', payload());
    expect(state().unreviewedCount()).toBe(2);
    expect(state().undone).toEqual([]);
    expect(state().kept).toEqual([]);
  });

  it('keeps decisions when the same request refreshes from the poll', () => {
    state().setFromStream('req-1', payload());
    state().undoSection('printer.cfg', 'stepper_x');
    state().setFromStream('req-1', payload());
    expect(state().undone).toEqual(['e1']);
    expect(state().keptIds()).toEqual(['e0']);
  });

  it('drops decisions about rows that no longer exist', () => {
    state().setFromStream('req-1', payload());
    state().undoSection('printer.cfg', 'stepper_x');
    const shrunk = payload({ edits: [edit('e0', 'printer')] });
    state().setFromStream('req-1', {
      ...shrunk,
      files: [{ ...shrunk.files[0], sections: [payload().files[0].sections[0]] }],
    });
    expect(state().undone).toEqual([]);
  });

  it('keepAll decides every undecided edit without touching the text', () => {
    state().setFromStream('req-1', payload());
    state().keepAll();
    expect(state().unreviewedCount()).toBe(0);
    expect(state().kept).toEqual(['e0', 'e1']);
    expect(state().undone).toEqual([]);        // nothing was dropped
    expect(state().keptIds()).toEqual(['e0', 'e1']);
  });

  it('undoAll drops every undecided edit and leaves the kept ones alone', () => {
    state().setFromStream('req-1', payload());
    state().keepSection('printer.cfg', 'printer', ['e0']);
    state().undoAll();
    expect(state().undone).toEqual(['e1']);
    expect(state().keptIds()).toEqual(['e0']);
    expect(state().unreviewedCount()).toBe(0);
    expect(changeSetTotals(state())).toEqual({ added: 0, removed: 0 });
  });

  it('a decided edit leaves the summary, and the totals follow', () => {
    state().setFromStream('req-1', payload());
    expect(changeSetTotals(state())).toEqual({ added: 2, removed: 2 });
    expect(state().pendingGroups()[0].sections.map((s) => s.section))
      .toEqual(['printer', 'stepper_x']);

    state().keepSection('printer.cfg', 'printer', ['e0']);
    expect(state().pendingGroups()[0].sections.map((s) => s.section)).toEqual(['stepper_x']);
    expect(changeSetTotals(state())).toEqual({ added: 1, removed: 1 });
    expect(state().unreviewedCount()).toBe(1);

    state().undoSection('printer.cfg', 'stepper_x');
    expect(state().pendingGroups()).toEqual([]);   // nothing left to review
    expect(changeSetTotals(state())).toEqual({ added: 0, removed: 0 });
  });

  it('keeps a whole file without deciding anything else', () => {
    state().setFromStream('req-1', payload({
      edits: [edit('e0', 'printer'), edit('e1', 'stepper_x'), edit('e2', 'other')],
      files: [
        {
          file: 'printer.cfg', added: 1, removed: 1,
          sections: [{
            file: 'printer.cfg', section: 'printer', added: 1, removed: 1,
            edits: ['e0'], advisories: { error: 0, warning: 0, other: 0 },
          }],
        },
        {
          file: 'macros.cfg', added: 2, removed: 2,
          sections: [{
            file: 'macros.cfg', section: 'stepper_x', added: 1, removed: 1,
            edits: ['e1'], advisories: { error: 0, warning: 0, other: 0 },
          }, {
            file: 'macros.cfg', section: 'other', added: 1, removed: 1,
            edits: ['e2'], advisories: { error: 0, warning: 0, other: 0 },
          }],
        },
      ],
    }));
    state().keepFile('macros.cfg', ['e1', 'e2']);
    expect(state().kept).toEqual(['e1', 'e2']);
    expect(state().pendingIds()).toEqual(['e0']);
    expect(state().pendingGroups().map((f) => f.file)).toEqual(['printer.cfg']);
  });

  it('undoing a section does not re-decide an already-kept one', () => {
    state().setFromStream('req-1', payload());
    state().keepSection('printer.cfg', 'printer', ['e0']);
    state().undoSection('printer.cfg', 'stepper_x');
    expect(state().kept).toEqual(['e0']);
    expect(state().undone).toEqual(['e1']);
    expect(state().decidedIds()).toEqual(['e0', 'e1']);
  });

  it('re-undosing the same section does not duplicate the ledger', () => {
    state().setFromStream('req-1', payload());
    state().undoSection('printer.cfg', 'stepper_x');
    state().undoSection('printer.cfg', 'stepper_x');
    expect(state().undone).toEqual(['e1']);
  });

  it('tracks unfolded rows per id and clears them with the request', () => {
    state().setFromStream('req-1', payload());
    state().toggleExpanded('e0');
    expect(state().expanded).toEqual(['e0']);
    state().toggleExpanded('e0');
    expect(state().expanded).toEqual([]);
    state().toggleExpanded('e0');
    state().setFromStream('req-2', payload());
    expect(state().expanded).toEqual([]);
  });

  it('an empty payload clears the view instead of stranding rows', () => {
    state().setFromStream('req-1', payload());
    state().setFromStream('req-1', null);
    expect(state().view).toBeNull();
    expect(state().unreviewedCount()).toBe(0);
    expect(state().pendingGroups()).toEqual([]);
  });
});
