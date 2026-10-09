// Appended by PR #36 round-1 fixes: blank-text join convention (B-2).
import { describe, expect, it } from 'vitest';
import { reviewRuns, keepRunsInFrame, undoRunsInLive } from '../reviewLedger';

describe('joinLines — blank-text edges (PR #36 B-2)', () => {
  it('keep-all of an empty frame vs a newline-only live stays newline-only', () => {
    const frame = '';
    const live = '\n';
    const runs = reviewRuns(frame, live);
    expect(keepRunsInFrame(frame, live, runs, new Set(runs.map((r) => r.key)))).toBe('\n');
  });

  it('undo-all to a newline-only frame returns the newline, not the empty string', () => {
    const frame = '\n';
    const live = '[sec]\n';
    const runs = reviewRuns(frame, live);
    expect(undoRunsInLive(frame, live, runs, new Set(runs.map((r) => r.key)))).toBe('\n');
  });

  it('a frame with no trailing-newline convention keeps none', () => {
    const frame = '';
    const live = '';
    const runs = reviewRuns(frame, live);
    expect(keepRunsInFrame(frame, live, runs, new Set(runs.map((r) => r.key)))).toBe('');
  });
});
