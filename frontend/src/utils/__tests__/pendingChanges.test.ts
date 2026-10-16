import { describe, expect, it } from 'vitest';

import { stopIndexForAnchor } from '../pendingChanges';

/**
 * The review strip's cursor anchor.
 *
 * The stops are the mechanical ledger's runs now (Sir, 2026-10-07); the old
 * change-stop pairing (matching a rendered diff row to a pending row's own
 * diff text) is gone. Only the identity rule survives, and it is easy to get
 * subtly wrong: a decision made elsewhere must not drag the reader off the run
 * they are reading.
 */
describe('stopIndexForAnchor', () => {
  const stop = (key: string) => ({ ids: [key] });

  it('stays on the change the reader was on when it survives', () => {
    // A run decided from the CHAT, above the cursor: it must not move the
    // reader off what they are reading.
    const before = [stop('a'), stop('b'), stop('c')];
    const after = [stop('b'), stop('c')];
    expect(stopIndexForAnchor(after, ['b'], 1)).toBe(0);
  });

  it('takes the slot the decided change left behind', () => {
    const stops = [stop('a'), stop('c')];
    // 'b' is gone: the reader was on it, so they land where it was — the next
    // change, not the top of the list.
    expect(stopIndexForAnchor(stops, ['b'], 1)).toBe(1);
  });

  it('clamps to the last change when the slot is past the end', () => {
    expect(stopIndexForAnchor([stop('a')], ['c'], 4)).toBe(0);
  });

  it('clamps a negative fallback to the first change', () => {
    expect(stopIndexForAnchor([stop('a'), stop('b')], [], -3)).toBe(0);
  });

  it('falls back to the slot when the anchor names nothing', () => {
    expect(stopIndexForAnchor([{ ids: [] }, stop('b')], [], 1)).toBe(1);
  });

  it('has no index to give when nothing is left', () => {
    expect(stopIndexForAnchor([], ['a'], 0)).toBe(-1);
  });
});
