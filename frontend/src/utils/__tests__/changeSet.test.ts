import { describe, expect, it } from 'vitest';

import type { ChangeSetPayload } from '@/services/api';
import {
  buildChangeSetView,
  changeRowLabel,
  fileEditIds,
  keptIdsAfterUndo,
  pendingGroups,
  sectionEditIds,
  supersededNote,
  totalsForIds,
  unreviewedIds,
} from '@/utils/changeSet';

const edit = (over: Partial<ChangeSetPayload['edits'][number]> = {}) => ({
  id: 'e0',
  file: 'printer.cfg',
  section: 'printer',
  key: 'max_accel',
  op: 'set_param',
  summary: 'set max_accel to 3000',
  added: 1,
  removed: 1,
  diffText: '',
  advisories: [],
  superseded: false,
  supersededBy: '',
  ...over,
});

const payload = (over: Partial<ChangeSetPayload> = {}): ChangeSetPayload => ({
  edits: [
    edit(),
    edit({ id: 'e1', key: 'max_velocity', summary: 'set max_velocity to 300' }),
    edit({ id: 'e2', section: 'stepper_x', key: 'microsteps', op: 'set_param' }),
  ],
  files: [
    {
      file: 'printer.cfg',
      added: 2,
      removed: 2,
      sections: [
        {
          file: 'printer.cfg',
          section: 'printer',
          added: 2,
          removed: 2,
          edits: ['e0', 'e1'],
          advisories: { error: 0, warning: 0, other: 0 },
        },
        {
          file: 'printer.cfg',
          section: 'stepper_x',
          added: 1,
          removed: 1,
          edits: ['e2'],
          advisories: { error: 0, warning: 0, other: 0 },
        },
      ],
    },
  ],
  totalAdded: 3,
  totalRemoved: 3,
  createdFiles: [],
  ...over,
});

describe('changeRowLabel', () => {
  it('names the file and section, and the param for a set_param', () => {
    expect(changeRowLabel({ file: 'printer.cfg', section: 'stepper_x', key: 'microsteps' }))
      .toBe('printer.cfg / [stepper_x] microsteps');
    expect(changeRowLabel({ file: 'printer.cfg', section: 'gcode_macro PARK' }))
      .toBe('printer.cfg / [gcode_macro PARK]');
  });

  it('degrades to the file alone when there is no section', () => {
    expect(changeRowLabel({ file: 'macros.cfg', section: '' })).toBe('macros.cfg');
    expect(changeRowLabel({ file: '', section: '' })).toBe('(unknown file)');
  });
});

describe('buildChangeSetView', () => {
  it('is null when there is nothing to review', () => {
    expect(buildChangeSetView(null)).toBeNull();
    expect(buildChangeSetView(undefined)).toBeNull();
    expect(buildChangeSetView(payload({ edits: [] }))).toBeNull();
  });

  it('keeps rows chronological and the summary grouped', () => {
    const view = buildChangeSetView(payload())!;
    expect(view.rows.map((row) => row.id)).toEqual(['e0', 'e1', 'e2']);
    expect(view.files[0].sections.map((section) => section.section))
      .toEqual(['printer', 'stepper_x']);
    expect(view.totalAdded).toBe(3);
  });

  it('badges each row from its own advisories, never from prose', () => {
    const view = buildChangeSetView(payload({
      edits: [edit({
        advisories: [
          { severity: 'warning', message: 'unknown command' },
          { severity: 'error', message: 'bad pin' },
          { severity: 'info', message: 'note' },
        ],
      })],
    }))!;
    expect(view.rows[0].badge).toEqual({ error: 1, warning: 1, other: 1 });
  });

  it('excludes superseded rows from the live ids the totals count', () => {
    const view = buildChangeSetView(payload({
      edits: [
        edit({ id: 'e0', superseded: true, supersededBy: 'e1' }),
        edit({ id: 'e1' }),
      ],
    }))!;
    expect(view.rows).toHaveLength(2);        // history keeps both
    expect(view.liveIds).toEqual(['e1']);
    expect(supersededNote(view.rows[0])).toBe('replaced by a later edit');
    expect(supersededNote(view.rows[1])).toBe('');
  });

  it('carries the file\'s pre-review text as the pane\'s frame', () => {
    const before = '[printer]\nmax_accel: 1000\n';
    const view = buildChangeSetView(payload({
      files: [{ ...payload().files[0], beforeText: before }],
    }))!;
    expect(view.frames).toEqual({ 'printer.cfg': before });
  });

  it('has no frame for a file the server did not send one for', () => {
    // A payload from a server that predates the frame: the pane falls back to
    // the rows' own diffs, and must not claim to be showing the document.
    const view = buildChangeSetView(payload())!;
    expect(view.frames).toEqual({});
  });
});

describe('decisions', () => {
  it('counts surviving undecided rows as unreviewed', () => {
    const view = buildChangeSetView(payload())!;
    expect(unreviewedIds(view, [])).toEqual(['e0', 'e1', 'e2']);
    expect(unreviewedIds(view, ['e0', 'e2'])).toEqual(['e1']);
    // A superseded row is not something anyone has to decide about.
    const withSuperseded = buildChangeSetView(payload({
      edits: [edit({ id: 'e0', superseded: true }), edit({ id: 'e1' })],
    }))!;
    expect(unreviewedIds(withSuperseded, [])).toEqual(['e1']);
  });

  it('expresses undo as the keep list, never as a new text', () => {
    const view = buildChangeSetView(payload())!;
    expect(keptIdsAfterUndo(view, [])).toEqual(['e0', 'e1', 'e2']);
    expect(keptIdsAfterUndo(view, ['e1'])).toEqual(['e0', 'e2']);
    expect(keptIdsAfterUndo(view, ['e0', 'e1', 'e2'])).toEqual([]);
  });

  it('drops whole sections and whole files by their group ids', () => {
    const view = buildChangeSetView(payload())!;
    expect(sectionEditIds(view, 'printer.cfg', 'printer')).toEqual(['e0', 'e1']);
    expect(sectionEditIds(view, 'printer.cfg', 'nope')).toEqual([]);
    expect(fileEditIds(view, 'printer.cfg')).toEqual(['e0', 'e1', 'e2']);
    expect(fileEditIds(view, 'other.cfg')).toEqual([]);
  });

  it('a per-group decision only covers what is still undecided', () => {
    const view = buildChangeSetView(payload())!;
    expect(sectionEditIds(view, 'printer.cfg', 'printer', ['e0'])).toEqual(['e1']);
    expect(fileEditIds(view, 'printer.cfg', ['e0', 'e2'])).toEqual(['e1']);
    expect(sectionEditIds(view, 'printer.cfg', 'printer', ['e0', 'e1'])).toEqual([]);
  });
});

describe('totals reflect only what still needs a decision', () => {
  it('counts just the given ids', () => {
    const view = buildChangeSetView(payload())!;
    expect(totalsForIds(view, ['e0', 'e1', 'e2'])).toEqual({ added: 3, removed: 3 });
    expect(totalsForIds(view, [])).toEqual({ added: 0, removed: 0 });
    expect(totalsForIds(view, ['e2'])).toEqual({ added: 1, removed: 1 });
  });

  it('never counts a superseded row', () => {
    const view = buildChangeSetView(payload({
      edits: [
        edit({ id: 'e0', superseded: true, added: 1, removed: 1 }),
        edit({ id: 'e1', added: 1, removed: 1 }),
      ],
    }))!;
    expect(totalsForIds(view, ['e0', 'e1'])).toEqual({ added: 1, removed: 1 });
  });
});

describe('pendingGroups', () => {
  it('lists every undecided edit, grouped by file and section', () => {
    const view = buildChangeSetView(payload())!;
    const groups = pendingGroups(view, []);
    expect(groups).toHaveLength(1);
    expect(groups[0].file).toBe('printer.cfg');
    expect(groups[0].added).toBe(3);
    expect(groups[0].sections.map((section) => section.section))
      .toEqual(['printer', 'stepper_x']);
    expect(groups[0].sections[0].ids).toEqual(['e0', 'e1']);
    expect(groups[0].sections[1].ids).toEqual(['e2']);
  });

  it('drops a decided section, and a file with nothing left', () => {
    const view = buildChangeSetView(payload())!;
    const afterSection = pendingGroups(view, ['e0', 'e1']);
    expect(afterSection).toHaveLength(1);
    expect(afterSection[0].sections.map((section) => section.section)).toEqual(['stepper_x']);
    expect(afterSection[0].added).toBe(1);

    expect(pendingGroups(view, ['e0', 'e1', 'e2'])).toEqual([]);
  });

  it('counts a group from its own rows, so a decision shrinks the numbers', () => {
    const view = buildChangeSetView(payload())!;
    const groups = pendingGroups(view, ['e1']);
    expect(groups[0].sections[0].ids).toEqual(['e0']);
    expect(groups[0].sections[0].added).toBe(1);
    expect(groups[0].added).toBe(2);          // e0 + e2
  });

  it('never lists a superseded row', () => {
    const view = buildChangeSetView(payload({
      edits: [
        edit({ id: 'e0', superseded: true }),
        edit({ id: 'e1' }),
      ],
    }))!;
    const groups = pendingGroups(view, []);
    expect(groups[0].sections[0].ids).toEqual(['e1']);
  });

  it('carries each section its own advisory counts', () => {
    const view = buildChangeSetView(payload({
      edits: [
        edit({ id: 'e0', advisories: [
          { severity: 'warning', message: 'w' },
          { severity: 'error', message: 'e' },
        ] }),
        edit({ id: 'e1', advisories: [{ severity: 'warning', message: 'w' }] }),
      ],
    }))!;
    const section = pendingGroups(view, [])[0].sections[0];
    expect(section.advisories).toEqual({ error: 1, warning: 2, other: 0 });
  });
});
