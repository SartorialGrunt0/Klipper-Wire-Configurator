import { describe, expect, it } from 'vitest';

import { buildReviewStops, changeStops, stopIndexForAnchor } from '../pendingChanges';
import { buildUnreviewedDiffModel } from '../pendingDiff';
import { changeRowLabel, sectionLabel, type ChangeSetRow } from '../changeSet';

/**
 * Navigation stops: where the pending changes are, in reading order.
 *
 * Built from the model the pane actually renders (the whole-file frame), so
 * these tests exercise the real pairing the component uses rather than a
 * hand-made row list.
 */

const row = (over: Partial<ChangeSetRow> = {}): ChangeSetRow => ({
  id: 'req-1:e0',
  file: 'printer.cfg',
  section: 'printer',
  key: 'max_accel',
  op: 'set_param',
  summary: '',
  added: 1,
  removed: 1,
  diffText: '@@ -2,3 +2,3 @@\n-max_accel: 1000\n+max_accel: 3000',
  advisories: [],
  superseded: false,
  supersededBy: '',
  badge: { error: 0, warning: 0, other: 0 },
  label: 'printer.cfg / [printer] max_accel',
  requestId: 'req-1',
  ...over,
});

const FILE_BEFORE = [
  '[printer]',            // 1
  'kinematics: corexy',   // 2
  'max_accel: 1000',      // 3
  'max_velocity: 300',    // 4
  '',                     // 5
  '[stepper_x]',          // 6
  'microsteps: 16',       // 7
  'rotation_distance: 40',// 8
  '',                     // 9
  '[stepper_z]',          // 10
  'microsteps: 16',       // 11
  '',
].join('\n');

/** The model the pane renders for a frame — no hand-written rows. */
function modelFor(rows: ChangeSetRow[], after: string) {
  return buildUnreviewedDiffModel(rows, 'printer.cfg', { before: FILE_BEFORE, after })!;
}

const afterChanging = (from: string, to: string) => FILE_BEFORE.replace(from, to);

describe('changeStops', () => {
  it('is empty when nothing in the rendered file belongs to a pending row', () => {
    // The frame and the document agree: nothing is pending any more.
    const stops = changeStops(modelFor([row()], FILE_BEFORE), [row()]);
    expect(stops).toEqual([]);
  });

  it('reports one stop per separated change, in document order', () => {
    const rows = [
      row({ id: 'req-1:e1', section: 'stepper_z', key: 'microsteps',
        diffText: '@@ -11,2 +11,2 @@\n-microsteps: 16\n+microsteps: 32' }),
      row(),   // the [printer] change, which sits EARLIER in the file
    ];
    const after = FILE_BEFORE
      .replace('max_accel: 1000', 'max_accel: 3000')
      .replace('[stepper_z]\nmicrosteps: 16', '[stepper_z]\nmicrosteps: 32');
    const model = modelFor(rows, after);
    const stops = changeStops(model, rows);

    expect(stops).toHaveLength(2);
    // Document order, not the order the model made them in.
    expect(stops[0].label).toBe('[printer] max_accel');
    expect(stops[1].label).toBe('[stepper_z] microsteps');
    // The stop's row index is where its first changed row is rendered, in
    // document order — the order the strip walks.
    expect(stops[0].row).toBeLessThan(stops[1].row);
    expect(model.lines[stops[0].row].type).toBe('removed');
    expect(model.lines[stops[1].row].type).toBe('removed');
  });

  it('merges adjacent changes into ONE stop that names both rows', () => {
    const rows = [
      row(),
      row({ id: 'req-1:e1', key: 'max_velocity', section: 'printer',
        diffText: '@@ -4,2 +4,2 @@\n-max_velocity: 300\n+max_velocity: 600' }),
    ];
    const model = modelFor(rows, FILE_BEFORE
      .replace('max_accel: 1000', 'max_accel: 3000')
      .replace('max_velocity: 300', 'max_velocity: 600'));
    const stops = changeStops(model, rows);

    expect(stops).toHaveLength(1);
    expect(stops[0].ids).toEqual(['req-1:e0', 'req-1:e1']);
    expect(stops[0].label).toBe('[printer] max_accel, [printer] max_velocity');
    // One stop for the run: its anchor is the run's first changed row.
    expect(model.lines[stops[0].row].type).toBe('removed');
  });

  it('gives a stop no owner when its lines are not any pending row\u2019s', () => {
    // A hand edit the frame also carries (the frame is the pre-review text,
    // the document is now): the stop is real, its owner is not a row.
    const rows = [row()];
    const model = modelFor(rows, FILE_BEFORE
      .replace('max_accel: 1000', 'max_accel: 3000')
      .replace('rotation_distance: 40', 'rotation_distance: 20'));
    const stops = changeStops(model, rows);

    expect(stops).toHaveLength(2);
    expect(stops[1].ids).toEqual([]);
    expect(stops[1].label).toBe('');
  });

  it('never names a row twice across stops', () => {
    const rows = [
      row({ id: 'req-1:e0' }),
      row({ id: 'req-1:e1', section: 'stepper_x', key: 'microsteps',
        diffText: '@@ -7,2 +7,2 @@\n-microsteps: 16\n+microsteps: 32' }),
      row({ id: 'req-1:e2', section: 'stepper_z', key: 'microsteps',
        diffText: '@@ -11,2 +11,2 @@\n-microsteps: 16\n+microsteps: 32' }),
    ];
    // Two sections carry the SAME before/after text — the ambiguous case.
    const model = modelFor(rows, FILE_BEFORE
      .replace('max_accel: 1000', 'max_accel: 3000')
      .replace('[stepper_x]\nmicrosteps: 16', '[stepper_x]\nmicrosteps: 32')
      .replace('[stepper_z]\nmicrosteps: 16', '[stepper_z]\nmicrosteps: 32'));
    const stops = changeStops(model, rows);

    const claimed = stops.flatMap((stop) => stop.ids);
    expect(claimed).toHaveLength(new Set(claimed).size);
    expect(new Set(claimed)).toEqual(new Set(['req-1:e0', 'req-1:e1', 'req-1:e2']));
  });
});

describe('changeStops — rows whose diff text is RAW', () => {
  // The row's `diffText` comes from the backend's difflib (raw text, n=3);
  // the pane's frame goes through createConfigPatch, which normalizes. The
  // two must still be read in the same space (reported 2026-10-04: a whole
  // section added by the AI showed no per-change Keep/Undo at all).
  const rawAdd = (extra: string) => row({
    id: 'req-1:e0',
    section: 'stepper_a',
    key: '',
    op: 'add_section',
    added: 3,
    removed: 0,
    diffText: '@@ -9,4 +9,7 @@\n [stepper_z]\n microsteps: 16\n+[stepper_a]\n'
      + `+step_pin: PA0${extra}\n+microsteps: 32`,
  });

  it('owns a whole-section add whose row text carries a trailing space', () => {
    const rows = [rawAdd(' ')];
    const after = `${FILE_BEFORE}[stepper_a]\nstep_pin: PA0 \nmicrosteps: 32\n`;
    const stops = changeStops(modelFor(rows, after), rows);

    expect(stops).toHaveLength(1);
    expect(stops[0].ids).toEqual(['req-1:e0']);
    expect(stops[0].label).toBe('[stepper_a]');
  });

  it('owns it when the row carries a doubled blank the frame collapses', () => {
    const rows = [row({
      id: 'req-1:e0',
      section: 'stepper_a',
      key: '',
      op: 'add_section',
      added: 5,
      removed: 0,
      diffText: '@@ -9,4 +9,8 @@\n [stepper_z]\n microsteps: 16\n'
        + '+[stepper_a]\n+step_pin: PA0\n+\n+\n+microsteps: 32',
    })];
    const after = `${FILE_BEFORE}[stepper_a]\nstep_pin: PA0\n\n\nmicrosteps: 32\n`;
    const stops = changeStops(modelFor(rows, after), rows);

    expect(stops).toHaveLength(1);
    expect(stops[0].ids).toEqual(['req-1:e0']);
  });

  it('still gives no owner to a row whose lines are not in the frame', () => {
    // Normalizing must not turn the match into a wildcard.
    const rows = [row({
      id: 'req-1:e0',
      section: 'stepper_a',
      key: '',
      op: 'add_section',
      added: 1,
      removed: 0,
      diffText: '@@ -9,4 +9,5 @@\n [stepper_z]\n microsteps: 16\n+nothing_like_this: 1',
    })];
    const after = `${FILE_BEFORE}[stepper_a]\nstep_pin: PA0\n`;
    const stops = changeStops(modelFor(rows, after), rows);

    expect(stops[0].ids).toEqual([]);
  });
});

describe('stopIndexForAnchor', () => {
  const stop = (ids: string[]) => ({ ids });

  it('stays on the change the reader was on when it survives', () => {
    // A change decided from the CHAT, above the cursor: it must not drag the
    // reader off what they are reading.
    const before = [stop(['a']), stop(['b']), stop(['c'])];
    const after = [stop(['b']), stop(['c'])];
    expect(stopIndexForAnchor(after, ['b'], 1)).toBe(0);
  });

  it('takes the slot the decided change left behind', () => {
    const stops = [stop(['a']), stop(['c'])];
    // 'b' is gone: the reader was on it, so they land where it was — the next
    // change, not the top of the list.
    expect(stopIndexForAnchor(stops, ['b'], 1)).toBe(1);
  });

  it('clamps to the last change when the slot is past the end', () => {
    expect(stopIndexForAnchor([stop(['a'])], ['c'], 4)).toBe(0);
  });

  it('clamps a negative fallback to the first change', () => {
    expect(stopIndexForAnchor([stop(['a']), stop(['b'])], [], -3)).toBe(0);
  });

  it('falls back to the slot when the anchor names nothing', () => {
    // No ids at all (a stop that owns no row): the fallback decides.
    expect(stopIndexForAnchor([stop([]), stop(['b'])], [], 1)).toBe(1);
  });

  it('has no index to give when nothing is left', () => {
    expect(stopIndexForAnchor([], ['a'], 0)).toBe(-1);
  });
});

describe('buildReviewStops', () => {
  const rowIn = (file: string, over: Partial<ChangeSetRow> = {}): ChangeSetRow => ({
    id: `${file}:e0`, file, section: 'printer', key: 'max_accel', op: 'set_param',
    summary: '', added: 1, removed: 1,
    diffText: '@@ -3,5 +3,5 @@\n [printer]\n kinematics: corexy\n-max_accel: 1000\n+max_accel: 3000\n max_velocity: 300',
    advisories: [], superseded: false, supersededBy: '',
    badge: { error: 0, warning: 0, other: 0 }, label: `${file} / [printer] max_accel`,
    ...over,
  });

  const TEXT = ['[printer]', 'kinematics: corexy', 'max_accel: 1000', 'max_velocity: 300', ''].join('\n');

  it('walks every file: file order, then document order inside each file', () => {
    const { stops, models } = buildReviewStops([
      { file: 'a.cfg', rows: [rowIn('a.cfg')], before: TEXT, after: TEXT.replace('1000', '3000') },
      { file: 'b.cfg', rows: [rowIn('b.cfg')], before: TEXT, after: TEXT.replace('1000', '3000') },
    ]);

    expect(stops.map((entry) => entry.file)).toEqual(['a.cfg', 'b.cfg']);
    expect(Object.keys(models).sort()).toEqual(['a.cfg', 'b.cfg']);
    // Every stop can name itself: the count spans files, so identity needs one.
    expect(stops[0]).toMatchObject({ file: 'a.cfg', label: '[printer] max_accel' });
  });

  it('gives a file with no ownable change neither a stop nor a document', () => {
    // The frame carries no such change (a hand edit, or a payload that lost
    // it): the walk must not stop there.
    const { stops, models } = buildReviewStops([
      { file: 'a.cfg', rows: [rowIn('a.cfg')], before: TEXT, after: TEXT },
      { file: 'b.cfg', rows: [rowIn('b.cfg')], before: TEXT, after: TEXT.replace('1000', '3000') },
    ]);

    expect(stops.map((entry) => entry.file)).toEqual(['b.cfg']);
    expect(models['a.cfg']).toBeUndefined();
    expect(models['b.cfg']).toBeDefined();
  });

  it('still walks a file the editor is not holding (no frame)', () => {
    // No before/after: the model falls back to the rows' own diffs.
    const { stops, models } = buildReviewStops([
      { file: 'new.cfg', rows: [rowIn('new.cfg')], before: null, after: null },
    ]);

    expect(stops).toHaveLength(1);
    expect(stops[0].file).toBe('new.cfg');
    expect(models['new.cfg']).toBeDefined();
  });

  it('is empty when there is nothing to walk', () => {
    expect(buildReviewStops([])).toEqual({ models: {}, stops: [] });
    expect(buildReviewStops([{ file: 'a.cfg', rows: [], before: TEXT, after: TEXT }]))
      .toEqual({ models: {}, stops: [] });
  });
});

describe('sectionLabel', () => {
  it('names the section and the param, and falls back to the file', () => {
    expect(sectionLabel({ section: 'stepper_x', key: 'microsteps' })).toBe('[stepper_x] microsteps');
    expect(sectionLabel({ section: 'stepper_x' })).toBe('[stepper_x]');
    expect(sectionLabel({ section: '', file: 'macros.cfg' })).toBe('macros.cfg');
  });

  it('is what the row label is built from, so the two cannot drift', () => {
    const r = row();
    expect(changeRowLabel(r)).toBe(`printer.cfg / ${sectionLabel(r)}`);
    expect(changeRowLabel(r)).toBe('printer.cfg / [printer] max_accel');
  });
});
