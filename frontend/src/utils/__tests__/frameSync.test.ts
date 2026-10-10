import { describe, expect, it } from 'vitest';
import { syncFrameOutsideRuns } from '../reviewLedger';
import { reviewRuns } from '../reviewLedger';

const L = (...lines: string[]) => lines.join('\n') + '\n';

/**
 * `syncFrameOutsideRuns(frame, prevLive, newLive)` folds hand edits made
 * OUTSIDE the pending runs of diff(frame, prevLive) into the frame, so
 * diff(frame, newLive) keeps showing ONLY the AI's change (Sir, 2026-10-10):
 *
 *  - a hand edit outside the AI lines is invisible to the review;
 *  - a hand edit on/inside the AI lines joins the run (protected);
 *  - deleting the whole AI run nets it to zero;
 *  - after all runs are decided (frame == live) later typing diffs against
 *    nothing — the reported bug.
 *
 * The invariant test is the SCENARIO, not the frame string: seed
 * frame→aiLive, hand-edit aiLive→handLive, sync, and assert the runs over
 * (newFrame, handLive) are exactly the AI's runs.
 */

/** Run shape summary for assertions: `+added@liveStart -removed` per run. */
const shape = (frame: string, live: string) => reviewRuns(frame, live)
  .map((r) => `+${r.added.join('|') || ''}−${r.removed.join('|') || ''}@${r.liveStart}`);

function scenario(
  name: string,
  frame: string,
  aiLive: string,
  handLive: string,
  expectShapes: string[],
) {
  it(name, () => {
    const f2 = syncFrameOutsideRuns(frame, aiLive, handLive);
    expect(shape(f2, handLive)).toEqual(expectShapes);
  });
}

describe('syncFrameOutsideRuns — the invariant', () => {
  scenario('type a comment above the AI run: run survives, comment invisible',
    L('[p]', 'max_accel: 1000'), L('[p]', 'max_accel: 3000'), L('# mine', '[p]', 'max_accel: 3000'),
    ['+max_accel: 3000−max_accel: 1000@3']);

  scenario('type below the AI run: run survives, comment invisible',
    L('[p]', 'max_accel: 1000', '[x]', 'a: 1'), L('[p]', 'max_accel: 3000', '[x]', 'a: 1'),
    L('[p]', 'max_accel: 3000', '[x]', 'a: 1', '# tail'),
    ['+max_accel: 3000−max_accel: 1000@2']);

  scenario('edit an AI line: it joins the run',
    L('[p]', 'max_accel: 1000'), L('[p]', 'max_accel: 3000'), L('[p]', 'max_accel: 3500'),
    ['+max_accel: 3500−max_accel: 1000@2']);

  scenario('delete the AI line: the AI change nets against the original as a deletion',
    L('[p]', 'max_accel: 1000', '[x]'), L('[p]', 'max_accel: 3000', '[x]'), L('[p]', '[x]'),
    ['+−max_accel: 1000@2']);

  scenario('AI deleted a line (ghost); typing above keeps the ghost',
    L('[p]', 'gone: 1', '[x]'), L('[p]', '[x]'), L('# top', '[p]', '[x]'),
    ['+−gone: 1@3']);

  scenario('two AI runs; hand edit between them leaves both intact',
    L('a: 1', 'mid', 'z: 9'), L('A: 1', 'mid', 'Z: 9'), L('A: 1', '# mid2', 'mid', 'Z: 9'),
    ['+A: 1−a: 1@1', '+Z: 9−z: 9@4']);

  scenario('deleting the line adjacent to a ghost anchor keeps the ghost',
    L('[p]', 'gone: 1', '[x]', 'k: 2'), L('[p]', '[x]', 'k: 2'), L('[p]', 'k: 2'),
    ['+−gone: 1@2']);

  scenario('replacing context on both sides of an inserted AI line: edits absorbed, insertion kept',
    // 'a'→'x' and 'c'→'y' are hand edits OUTSIDE the AI insertion: invisible.
    L('a', 'b', 'c'), L('a', 'b', 'NEW', 'c'), L('x', 'b', 'NEW', 'y'),
    ['+NEW−@3']);

  scenario('repeated hand edits keep folding (two rounds)',
    L('[p]', 'max_accel: 1000'), L('[p]', 'max_accel: 3000'),
    L('# one', '[p]', 'max_accel: 3000'), ['+max_accel: 3000−max_accel: 1000@3']);
});

describe('syncFrameOutsideRuns — unit edges', () => {
  it('no runs: the frame simply follows the live text', () => {
    expect(syncFrameOutsideRuns(L('a', 'b'), L('a', 'b'), L('a', 'x', 'b'))).toBe(L('a', 'x', 'b'));
  });

  it('identical texts: identity (same reference semantics: equal string)', () => {
    expect(syncFrameOutsideRuns(L('a', 'd'), L('a', 'D'), L('a', 'D'))).toBe(L('a', 'd'));
  });

  it('the newline convention follows the live text', () => {
    expect(syncFrameOutsideRuns('a\nd', 'a\nD', 'a\nD\nz')).toBe('a\nd\nz');
    expect(syncFrameOutsideRuns('a\nd\n', 'a\nD\n', 'a\nD\nz')).toBe('a\nd\nz');
    expect(syncFrameOutsideRuns('a\nd', 'a\nD', 'a\nD\nz\n')).toBe('a\nd\nz\n');
  });

  it('the second fold continues from the first', () => {
    const frame = L('[p]', 'max_accel: 1000');
    const ai = L('[p]', 'max_accel: 3000');
    const hand1 = L('# one', '[p]', 'max_accel: 3000');
    const f1 = syncFrameOutsideRuns(frame, ai, hand1);
    const hand2 = L('# one', '[p]', 'max_accel: 3000', '# two');
    const f2 = syncFrameOutsideRuns(f1, hand1, hand2);
    expect(f2).toBe(L('# one', '[p]', 'max_accel: 1000', '# two'));
  });

  it('after decide-all (frame == live), typing diffs against nothing', () => {
    const kept = L('# one', '[p]', 'max_accel: 3000');
    const typed = L('# one', '# two', '[p]', 'max_accel: 3000');
    const f2 = syncFrameOutsideRuns(kept, kept, typed);
    expect(reviewRuns(f2, typed)).toEqual([]);
  });
});
