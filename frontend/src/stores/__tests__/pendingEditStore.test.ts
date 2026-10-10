import { beforeEach, describe, expect, it } from 'vitest';

import { usePendingEditStore } from '@/stores/pendingEditStore';
import type { ApprovalCard } from '@/services/api';

const BEFORE = '[printer]\nmax_accel: 8000\n';
const AFTER = '[printer]\nmax_accel: 12000\n';

const card = (over: Partial<ApprovalCard> = {}): ApprovalCard => ({
  approvalId: 'a1',
  file: 'printer.cfg',
  op: 'set_param',
  summary: 'set max_accel to 12000',
  diff: { file: 'printer.cfg', before: BEFORE, after: AFTER },
  advisories: [],
  timeoutSeconds: 90,
  ...over,
});

beforeEach(() => {
  usePendingEditStore.setState({ pending: null, takeover: 'auto' });
});

describe('pendingEditStore', () => {
  it('publishes a card as a pending diff model', () => {
    usePendingEditStore.getState().setPending(card());
    const { pending } = usePendingEditStore.getState();
    expect(pending?.approvalId).toBe('a1');
    expect(pending?.added).toBe(1);
    expect(pending?.removed).toBe(1);
    expect(pending?.changedLines).toEqual([2]);
  });

  it('starts every new card on the automatic takeover decision', () => {
    usePendingEditStore.getState().setPending(card());
    usePendingEditStore.getState().showDiff();
    expect(usePendingEditStore.getState().takeover).toBe('shown');

    // A NEW card must re-decide from scratch, not inherit the last choice.
    usePendingEditStore.getState().setPending(card({ approvalId: 'a2' }));
    expect(usePendingEditStore.getState().takeover).toBe('auto');
  });

  it('resetTakeover lands the live path back on its default view', () => {
    // Show diff → mirror; Back to editing resets to auto, which on the live
    // path IS the review (the buffer with its tints), never the chip.
    usePendingEditStore.getState().showDiff();
    expect(usePendingEditStore.getState().takeover).toBe('shown');
    usePendingEditStore.getState().resetTakeover();
    expect(usePendingEditStore.getState().takeover).toBe('auto');
  });

  it('keeps the user choice when the same card is re-published by the poll', () => {
    usePendingEditStore.getState().setPending(card());
    usePendingEditStore.getState().hideDiff();
    usePendingEditStore.getState().setPending(card());
    expect(usePendingEditStore.getState().takeover).toBe('hidden');
    expect(usePendingEditStore.getState().pending?.approvalId).toBe('a1');
  });

  it('clears a diff-less card instead of stranding the previous rows', () => {
    usePendingEditStore.getState().setPending(card());
    usePendingEditStore.getState().setPending(card({ approvalId: 'a2', diff: null }));
    expect(usePendingEditStore.getState().pending).toBeNull();
    expect(usePendingEditStore.getState().takeover).toBe('auto');
  });

  it('ignores a stale clear (late response for a card already replaced)', () => {
    usePendingEditStore.getState().setPending(card({ approvalId: 'a2' }));
    usePendingEditStore.getState().clearPending('a1');
    expect(usePendingEditStore.getState().pending?.approvalId).toBe('a2');
  });

  it('clears when the id matches, and when no id is given', () => {
    usePendingEditStore.getState().setPending(card());
    usePendingEditStore.getState().clearPending('a1');
    expect(usePendingEditStore.getState().pending).toBeNull();

    usePendingEditStore.getState().setPending(card());
    usePendingEditStore.getState().clearPending();
    expect(usePendingEditStore.getState().pending).toBeNull();
    expect(usePendingEditStore.getState().takeover).toBe('auto');
  });
});
