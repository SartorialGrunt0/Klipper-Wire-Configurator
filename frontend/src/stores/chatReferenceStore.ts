/**
 * The docked chat panel's reference slots.
 *
 * Three slots, and the difference between them is *intent*, not content:
 *
 *  - `pinned`    — the user attached this deliberately. Sent with the message.
 *  - `preview`   — a suggestion the panel raised (today: a tree row the user
 *                  just clicked). **Replace-only, never accumulates**, and
 *                  NOT sent — `+` promotes it into `pinned`, which is the
 *                  only way it reaches the model. Without that rule, browsing
 *                  the tree would silently grow the prompt.
 *  - `selection` — the editor's current non-empty highlight. Sent with the
 *                  message; `×` dismisses it for as long as that exact range
 *                  stays selected (re-showing it on every keystroke while the
 *                  user works would be noise).
 *
 * Nothing here is persisted: a reference points at a line range in a document
 * that may not exist next session.
 */
import { create } from 'zustand';

import { addReference, dedupeReferences, type ChatReference } from '../utils/chatReferences';

export interface ChatReferenceState {
  pinned: ChatReference[];
  preview: ChatReference | null;
  selection: ChatReference | null;
  /** Id of the selection the user dismissed, if any (see module doc). */
  dismissedSelectionId: string | null;

  /** Replace the preview slot. `null` clears it. Never accumulates. */
  setPreview: (reference: ChatReference | null) => void;
  /** Move the preview into `pinned` and free the slot. */
  promotePreview: () => ChatReference | null;
  addPinned: (reference: ChatReference) => void;
  removePinned: (id: string) => void;
  /** Replace the selection slot (dismissal-aware). `null` clears it. */
  setSelection: (reference: ChatReference | null) => void;
  dismissSelection: () => void;
  /** Drop every slot — after a send, and on New Chat. */
  clear: () => void;
  /** Pinned + selection, in that order, deduped. What actually gets sent. */
  attachedReferences: () => ChatReference[];
  /**
   * Take the attached references for one send AND empty every slot.
   *
   * One call on purpose. The snapshot and the clear must happen together, in
   * that order: a caller that reads `attachedReferences()` and then calls
   * `clear()` sends an EMPTY list the moment those two statements are
   * reordered. (That is not hypothetical — it shipped into the first live
   * build of the dock and was caught by driving the real UI.)
   */
  takeAttachedReferences: () => ChatReference[];
}

const EMPTY = {
  pinned: [] as ChatReference[],
  preview: null as ChatReference | null,
  selection: null as ChatReference | null,
  dismissedSelectionId: null as string | null,
};

export const useChatReferenceStore = create<ChatReferenceState>((set, get) => ({
  ...EMPTY,

  setPreview: (preview) => set({ preview }),

  promotePreview: () => {
    const { preview, pinned } = get();
    if (!preview) return null;
    set({ pinned: addReference(pinned, preview), preview: null });
    return preview;
  },

  addPinned: (reference) => set((state) => ({ pinned: addReference(state.pinned, reference) })),

  removePinned: (id) =>
    set((state) => ({ pinned: state.pinned.filter((reference) => reference.id !== id) })),

  setSelection: (reference) => {
    const state = get();
    if (!reference) {
      // Already clear: bail WITHOUT calling set. The editor publishes its
      // selection on every keystroke and click, and zustand's set always
      // allocates a new state object — re-notifying subscribers on every
      // caret move for no change is pure churn.
      if (state.selection === null && state.dismissedSelectionId === null) return;
      // The selection collapsed (or the editor moved): forget the dismissal
      // too, so re-selecting the same range later raises the chip again.
      set({ selection: null, dismissedSelectionId: null });
      return;
    }
    if (reference.id === state.dismissedSelectionId) {
      if (state.selection !== null) set({ selection: null });
      return;
    }
    if (state.selection?.id === reference.id) return;
    set({ selection: reference, dismissedSelectionId: null });
  },

  dismissSelection: () =>
    set((state) => ({
      selection: null,
      dismissedSelectionId: state.selection?.id ?? state.dismissedSelectionId,
    })),

  clear: () => set({ ...EMPTY, pinned: [] }),

  attachedReferences: () => {
    const { pinned, selection } = get();
    return dedupeReferences(selection ? [...pinned, selection] : [...pinned]);
  },

  takeAttachedReferences: () => {
    const attached = get().attachedReferences();
    set({ ...EMPTY, pinned: [] });
    return attached;
  },
}));
