import { describe, expect, it } from 'vitest';

import {
  keepRunsInFrame,
  reviewRuns,
  runSectionLabel,
  undoRunsInLive,
} from '../reviewLedger';

const L = (...lines: string[]) => lines.join('\n');

describe('reviewRuns — the ledger is diff(frame, live)', () => {
  it('no difference, no stops', () => {
    expect(reviewRuns(L('a', 'b', 'c'), L('a', 'b', 'c'))).toEqual([]);
  });

  it('an added line is one green run at its live position', () => {
    const runs = reviewRuns(L('a', 'c'), L('a', 'b', 'c'));
    expect(runs).toHaveLength(1);
    expect(runs[0].liveStart).toBe(2);
    expect(runs[0].liveEnd).toBe(2);
    expect(runs[0].added).toEqual(['b']);
    expect(runs[0].removed).toEqual([]);
  });

  it('a removed line is one red run with an empty live range at its return line', () => {
    const runs = reviewRuns(L('a', 'b', 'c'), L('a', 'c'));
    expect(runs).toHaveLength(1);
    expect(runs[0].added).toEqual([]);
    expect(runs[0].removed).toEqual(['b']);
    expect(runs[0].liveEnd).toBe(runs[0].liveStart - 1);
  });

  it('a replacement is ONE run carrying green and red as written', () => {
    const runs = reviewRuns(L('speed = 200', 'x'), L('speed = 300  # AI', 'x'));
    expect(runs).toHaveLength(1);
    expect(runs[0].added).toEqual(['speed = 300  # AI']);
    expect(runs[0].removed).toEqual(['speed = 200']);
  });

  it('a human edit joining an AI line is part of the run — the run is the buffer', () => {
    // The model wrote `speed = 300`; the human appended a comment to it.
    const runs = reviewRuns(L('speed = 300'), L('speed = 300  ; and mine'));
    expect(runs).toHaveLength(1);
    expect(runs[0].added).toEqual(['speed = 300  ; and mine']);
  });

  it('add then remove nets to zero: nothing to review', () => {
    const frame = L('[gcode_macro A]', 'gcode: X');
    const added = L('[gcode_macro A]', 'gcode: X', '[gcode_macro B]', 'gcode: Y');
    // ...then the model removes it again: live equals frame.
    expect(reviewRuns(frame, added.slice(0, frame.length))).toEqual([]);
  });

  it('two distant edits are two stops; the keys differ', () => {
    const frame = L('a', 'b', 'c', 'd', 'e');
    const live = L('A', 'b', 'c', 'd', 'E');
    const runs = reviewRuns(frame, live);
    expect(runs).toHaveLength(2);
    expect(new Set(runs.map((r) => r.key)).size).toBe(2);
  });

  it('a created file (null frame) is one green run over the whole text', () => {
    const runs = reviewRuns(null, L('x', 'y'));
    expect(runs).toHaveLength(1);
    expect(runs[0].added).toEqual(['x', 'y']);
  });

  it('a deleted file (null live) is one red run at live line 1', () => {
    const runs = reviewRuns(L('x', 'y'), null);
    expect(runs).toHaveLength(1);
    expect(runs[0].removed).toEqual(['x', 'y']);
    expect(runs[0].liveStart).toBe(1);
  });
});

describe('keepRunsInFrame — keep freezes the live run into the frame', () => {
  it('keeping every run makes the frame the live text (review empties)', () => {
    const frame = L('a', 'b', 'c');
    const live = L('a', 'B', 'c', 'd');
    const runs = reviewRuns(frame, live);
    const all = new Set(runs.map((r) => r.key));
    expect(keepRunsInFrame(frame, live, runs, all)).toBe(live);
    expect(reviewRuns(keepRunsInFrame(frame, live, runs, all), live)).toEqual([]);
  });

  it('keeping one run leaves the other pending', () => {
    const frame = L('a', 'b', 'c', 'd', 'e');
    const live = L('A', 'b', 'c', 'd', 'E');
    const runs = reviewRuns(frame, live);
    const kept = keepRunsInFrame(frame, live, runs, new Set([runs[0].key]));
    expect(kept.split('\n')[0]).toBe('A');
    const left = reviewRuns(kept, live);
    expect(left).toHaveLength(1);
    expect(left[0].removed).toEqual(['e']);
  });

  it('undo then keep of the REST restores exactly the live text elsewhere', () => {
    const frame = L('one', 'two', 'three');
    const live = L('ONE', 'two', 'THREE');
    const runs = reviewRuns(frame, live);
    const undone = undoRunsInLive(frame, live, runs, new Set([runs[0].key]));
    expect(undone).toBe(L('one', 'two', 'THREE'));
    // Second pass over the new pair: only THREE remains.
    const again = reviewRuns(frame, undone);
    expect(again).toHaveLength(1);
    expect(keepRunsInFrame(frame, undone, again, new Set([again[0].key]))).toBe(undone);
  });
});

describe('undoRunsInLive — undo restores the frame version as written', () => {
  it('undo deletes the green lines as written', () => {
    const frame = L('a', 'c');
    const live = L('a', 'b', 'c');
    const runs = reviewRuns(frame, live);
    expect(undoRunsInLive(frame, live, runs, new Set(runs.map((r) => r.key)))).toBe(frame);
  });

  it('undo brings the red lines back as written', () => {
    const frame = L('a', 'gone', 'c');
    const live = L('a', 'c');
    const runs = reviewRuns(frame, live);
    expect(undoRunsInLive(frame, live, runs, new Set(runs.map((r) => r.key)))).toBe(frame);
  });

  it('undo of a replacement restores the old line in place', () => {
    const frame = L('speed = 200');
    const live = L('speed = 300  # AI');
    const runs = reviewRuns(frame, live);
    expect(undoRunsInLive(frame, live, runs, new Set(runs.map((r) => r.key)))).toBe(frame);
  });

  it('multiple runs undo together in one pass (descending splices)', () => {
    const frame = L('a', 'b', 'c', 'd', 'e');
    const live = L('A', 'b', 'c', 'd', 'E');
    const runs = reviewRuns(frame, live);
    expect(undoRunsInLive(frame, live, runs, new Set(runs.map((r) => r.key)))).toBe(frame);
  });

  it('undo with no keys touched returns the live text unchanged', () => {
    const frame = L('a');
    const live = L('b');
    const runs = reviewRuns(frame, live);
    expect(undoRunsInLive(frame, live, runs, new Set())).toBe(live);
  });
});

describe('runSectionLabel', () => {
  it('names the section a run sits in, header above', () => {
    const live = L('[printer]', 'max_velocity: 300  # AI', '', '[extruder]', 'nozzle: 0.4');
    const runs = reviewRuns(L('[printer]', 'max_velocity: 200', '', '[extruder]', 'nozzle: 0.4'), live);
    expect(runSectionLabel(live, L('[printer]', 'max_velocity: 200', '', '[extruder]', 'nozzle: 0.4'), runs[0])).toBe('[printer]');
  });
});
