import { describe, expect, it } from 'vitest';

import { changeStops, stopIndexAfterChange } from '../pendingChanges';
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
    expect(stops[0].lineStart).toBe(3);
    expect(stops[1].label).toBe('[stepper_z] microsteps');
    expect(stops[1].lineStart).toBe(11);
    // The stop's row index is where its first changed row is rendered.
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
    expect(stops[0].lineStart).toBe(3);
    expect(stops[0].lineEnd).toBe(4);
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

describe('stopIndexAfterChange', () => {
  const twoStops = () => {
    const rows = [
      row({ id: 'req-1:e0' }),
      row({
        id: 'req-1:e1',
        section: 'stepper_z',
        key: 'microsteps',
        diffText: '@@ -100,1 +100,1 @@\n-microsteps: 16\n+microsteps: 32\n',
      }),
    ];
    const model = modelFor(rows, afterChanging('max_accel: 1000', 'max_accel: 3000')
      .replace('microsteps: 16', 'microsteps: 32'));
    return changeStops(model, rows);
  };

  it('stays on the change the reader was at when it survives the decision', () => {
    const stops = twoStops();
    expect(stops).toHaveLength(2);
    expect(stopIndexAfterChange(stops, stops[1].lineStart)).toBe(1);
  });

  it('moves down to the next change when the decided one is gone', () => {
    const stops = twoStops();
    // The reader was on the first change; it has just been decided away, so
    // the cursor belongs on the one below it — not back at the top.
    expect(stopIndexAfterChange(stops.slice(1), stops[0].lineStart)).toBe(0);
  });

  it('falls back to the last change when the decided one was at the end', () => {
    const stops = twoStops();
    expect(stopIndexAfterChange(stops.slice(0, 1), stops[1].lineStart)).toBe(0);
  });

  it('has no index to give when nothing is left', () => {
    expect(stopIndexAfterChange([], 12)).toBe(-1);
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
