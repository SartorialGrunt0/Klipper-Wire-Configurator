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
    expect(state().unreviewedCount()).toBe(2);
    expect(state().pendingIds()).toEqual(['req-1:e0', 'req-1:e1']);
  });

  it('KEEPS a running total across messages (Sir, 2026-10-02)', () => {
    state().setFromStream('req-1', payload());
    state().setFromStream('req-2', secondPayload());
    // Both requests are still listed, oldest first, with namespaced ids.
    expect(state().segments.map((segment) => segment.requestId)).toEqual(['req-1', 'req-2']);
    expect(state().pendingIds()).toEqual([
      'req-1:e0', 'req-1:e1', 'req-2:e0',
    ]);
    expect(state().unreviewedCount()).toBe(3);
    expect(changeSetTotals(state())).toEqual({ added: 3, removed: 3 });
  });

  it('a decision on an older request survives a newer one', () => {
    state().setFromStream('req-1', payload());
    state().keepSection('printer.cfg', 'printer', ['req-1:e0']);
    state().setFromStream('req-2', secondPayload());
    expect(state().kept).toEqual(['req-1:e0']);
    expect(state().pendingIds()).toEqual(['req-1:e1', 'req-2:e0']);
  });

  it('the pane frame is the OLDEST request\'s pre-edit text', () => {
    // The pane shows the document before the REVIEW, not before the latest
    // message: a later request's frame already contains the earlier one's
    // edits, so it must not win.
    state().setFromStream('req-1', payload({
      files: [{ ...payload().files[0], beforeText: 'BEFORE THE REVIEW' }],
    }));
    state().setFromStream('req-2', secondPayload());
    state().setFromStream('req-3', payload({
      files: [{ ...payload().files[0], beforeText: 'AFTER REQUEST 1' }],
    }));
    expect(state().view?.frames['printer.cfg']).toBe('BEFORE THE REVIEW');
  });

  it('re-publishing the SAME request refreshes it without duplicating', () => {
    state().setFromStream('req-1', payload());
    state().setFromStream('req-1', payload());
    expect(state().segments).toHaveLength(1);
    expect(state().unreviewedCount()).toBe(2);
  });

  it('keeps decisions when the same request refreshes from the poll', () => {
    state().setFromStream('req-1', payload());
    state().undoSection('printer.cfg', 'stepper_x');
    state().setFromStream('req-1', payload());
    expect(state().undone).toEqual(['req-1:e1']);
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

  it('builds the resolve chain per request, oldest first', () => {
    state().setFromStream('req-1', payload());
    state().setFromStream('req-2', secondPayload());
    state().undoSection('printer.cfg', 'stepper_x');   // drops req-1:e1
    expect(state().resolveSegments()).toEqual([
      { requestId: 'req-1', keptEditIds: ['e0'] },
      { requestId: 'req-2', keptEditIds: ['e0'] },
    ]);
  });

  it('keepAll decides every undecided edit without touching the text', () => {
    state().setFromStream('req-1', payload());
    state().setFromStream('req-2', secondPayload());
    state().keepAll();
    expect(state().unreviewedCount()).toBe(0);
    expect(state().kept).toEqual(['req-1:e0', 'req-1:e1', 'req-2:e0']);
    expect(state().undone).toEqual([]);
  });

  it('undoAll drops every undecided edit and leaves the kept ones alone', () => {
    state().setFromStream('req-1', payload());
    state().keepSection('printer.cfg', 'printer', ['req-1:e0']);
    state().undoAll();
    expect(state().undone).toEqual(['req-1:e1']);
    expect(state().resolveSegments()).toEqual([
      { requestId: 'req-1', keptEditIds: ['e0'] },
    ]);
    expect(state().unreviewedCount()).toBe(0);
    expect(changeSetTotals(state())).toEqual({ added: 0, removed: 0 });
  });

  it('a decided edit leaves the summary, and the totals follow', () => {
    state().setFromStream('req-1', payload());
    expect(changeSetTotals(state())).toEqual({ added: 2, removed: 2 });

    state().keepSection('printer.cfg', 'printer', ['req-1:e0']);
    expect(state().pendingGroups()[0].sections.map((s) => s.section)).toEqual(['stepper_x']);
    expect(changeSetTotals(state())).toEqual({ added: 1, removed: 1 });

    state().undoSection('printer.cfg', 'stepper_x');
    expect(state().pendingGroups()).toEqual([]);   // nothing left to review
    expect(changeSetTotals(state())).toEqual({ added: 0, removed: 0 });
  });

  it('groups a section that two requests both touched under one entry', () => {
    state().setFromStream('req-1', payload());
    state().setFromStream('req-2', secondPayload());
    const groups = state().pendingGroups();
    expect(groups).toHaveLength(1);
    expect(groups[0].sections[0].ids).toEqual(['req-1:e0', 'req-2:e0']);
    expect(groups[0].sections[0].added).toBe(2);
  });

  it('lists the undecided rows of one file for the text view pane', () => {
    state().setFromStream('req-1', payload());
    state().setFromStream('req-2', secondPayload());
    expect(state().pendingRowsForFile('printer.cfg').map((row) => row.id))
      .toEqual(['req-1:e0', 'req-1:e1', 'req-2:e0']);
    state().keepSection('printer.cfg', 'printer', ['req-1:e0', 'req-2:e0']);
    expect(state().pendingRowsForFile('printer.cfg').map((row) => row.id))
      .toEqual(['req-1:e1']);
    expect(state().pendingRowsForFile('other.cfg')).toEqual([]);
  });

  it('tracks unfolded rows per id', () => {
    state().setFromStream('req-1', payload());
    state().toggleExpanded('req-1:e0');
    expect(state().expanded).toEqual(['req-1:e0']);
    state().toggleExpanded('req-1:e0');
    expect(state().expanded).toEqual([]);
  });

  it('an empty payload removes that request, leaving the rest of the total', () => {
    state().setFromStream('req-1', payload());
    state().setFromStream('req-2', secondPayload());
    state().setFromStream('req-2', null);
    expect(state().segments.map((segment) => segment.requestId)).toEqual(['req-1']);
    expect(state().pendingIds()).toEqual(['req-1:e0', 'req-1:e1']);
  });

  it('clear forgets everything (new chat / loading another conversation)', () => {
    state().setFromStream('req-1', payload());
    state().keepAll();
    state().clear();
    expect(state().view).toBeNull();
    expect(state().segments).toEqual([]);
    expect(state().kept).toEqual([]);
    expect(state().pendingGroups()).toEqual([]);
  });
});
