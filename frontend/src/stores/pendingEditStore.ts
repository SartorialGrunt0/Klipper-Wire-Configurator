/**
 * The pending-change signal between the chat and the text view.
 *
 * A store, not a prop: the docked chat is portalled into the text view from
 * `Toolbar` (`ChatDock` publishes a host element), so the dialog that OWNS the
 * approval card is not in `TextEditor`'s React tree and has no prop channel to
 * it. `configStore.requestLineJump` is the existing precedent for exactly this
 * kind of one-shot cross-tree signal.
 *
 * Only the card's lifecycle writes here (ChatDialog: a new approvalId, a
 * resolution, a stop). The pane reads it. Deciding *what* to render is
 * `paneModeFor` in `utils/pendingDiff` — kept pure and tested there, so this
 * store stays a dumb holder.
 */
import { create } from 'zustand';

import type { ApprovalCard } from '../services/api';
import { buildPendingDiffModel, type PaneTakeover, type PendingDiffModel } from '../utils/pendingDiff';

export interface PendingEditState {
  pending: PendingDiffModel | null;
  /** `auto` until the user asks for the diff, or asks to keep editing. */
  takeover: PaneTakeover;

  /** Publish a card. A different approvalId restarts the takeover decision. */
  setPending: (card: ApprovalCard) => void;
  /**
   * Drop the pending view. Pass the approvalId the caller decided on: a stale
   * response (a late poll landing after a new card arrived) must not clear a
   * card the user has not decided yet — same rule as the card slot itself.
   */
  clearPending: (approvalId?: string) => void;
  /** User asked to see the diff (header chip). */
  showDiff: () => void;
  /** User asked to keep editing (Back to editing). */
  hideDiff: () => void;
  /**
   * Back to the DEFAULT view (the live path's "Back to editing").
   *
   * 'hidden' is a declined-CARD state: it chips the pane. The live review
   * path never chips — its edit view is the default `review` mode, so
   * returning from the mirror must UNDO the explicit 'shown' request rather
   * than decline the review. (2026-10-07: reusing hideDiff here made the
   * return land in chip mode, where pending tints are not computed — the
   * "marks vanish after Show diff" bug.)
   */
  resetTakeover: () => void;
}

const EMPTY = { pending: null as PendingDiffModel | null, takeover: 'auto' as PaneTakeover };

export const usePendingEditStore = create<PendingEditState>((set, get) => ({
  ...EMPTY,

  setPending: (card) => {
    const model = buildPendingDiffModel(card);
    if (!model) {
      // A card with no diff (nothing to show) must not leave a previous
      // card's rows on screen — the slot is one-card-deep by construction.
      set({ ...EMPTY });
      return;
    }
    if (get().pending?.approvalId === model.approvalId) {
      // Same card, refreshed payload (the ~1.5s poll): refresh the rows but
      // keep the user's explicit show/hide choice.
      set({ pending: model });
      return;
    }
    set({ pending: model, takeover: 'auto' });
  },

  clearPending: (approvalId) => {
    const current = get().pending;
    if (!current) return;
    if (approvalId && current.approvalId !== approvalId) return;
    set({ ...EMPTY });
  },

  showDiff: () => set({ takeover: 'shown' }),
  hideDiff: () => set({ takeover: 'hidden' }),
  resetTakeover: () => set({ takeover: 'auto' }),
}));
