/**
 * The live change set of the request being reviewed (post-hoc edit review).
 *
 * A store, not component state: the transcript rows, the footer bar and the
 * save gate all read the SAME set, and the set outlives any one of them (the
 * rows render inside the message list, the bar sits above the composer, and
 * the text view's pane is a third reader). `pendingEditStore` set the
 * precedent — one dumb holder, pure logic in `utils/changeSet`.
 *
 * Decisions are tracked as ids, never as text: undoing is a REPLAY of the
 * kept ops on the backend (`POST /ai/chat/changes/resolve`), so this store
 * only records which edits survive and lets the server produce the text.
 *
 * Lifecycle: a NEW request replaces the set and clears the decisions (the
 * previous set has been kept or undone by then — the save gate keeps it in
 * front of the user until they decide).
 */
import { create } from 'zustand';

import type { ChangeSetPayload } from '../services/api';
import {
  allEditIds,
  buildChangeSetView,
  fileEditIds,
  remainingTotals,
  sectionEditIds,
  unreviewedIds,
  type ChangeSetView,
} from '../utils/changeSet';

export interface ChangeSetState {
  requestId: string | null;
  view: ChangeSetView | null;
  /** Ids the user has decided on (kept or undone) — the "reviewed" set. */
  decided: string[];
  /** Ids the user undid: their effect is gone from the working state. */
  undone: string[];
  /** Rows the user has unfolded (display only, per row id). */
  expanded: string[];

  /** Fold a payload from the progress rail or the finished reply. */
  setFromStream: (requestId: string | null, payload: ChangeSetPayload | null | undefined) => void;
  toggleExpanded: (id: string) => void;
  /** Keep everything: nothing to replay, the working state already holds it. */
  keepAll: () => void;
  /** Undo everything the request staged. */
  undoAll: () => void;
  undoSection: (file: string, section: string) => void;
  undoFile: (file: string) => void;
  clear: () => void;

  /** Ids to send as `keptEditIds` for the current decisions. */
  keptIds: () => string[];
  unreviewedCount: () => number;
}

const EMPTY = {
  view: null as ChangeSetView | null,
  decided: [] as string[],
  undone: [] as string[],
  expanded: [] as string[],
};

export const useChangeSetStore = create<ChangeSetState>((set, get) => ({
  requestId: null,
  ...EMPTY,

  setFromStream: (requestId, payload) => {
    const view = buildChangeSetView(payload);
    const current = get();
    if (current.requestId !== requestId) {
      // A new request: its change set is unreviewed from scratch.
      set({ requestId, view, decided: [], undone: [], expanded: [] });
      return;
    }
    // Same request, refreshed by the poll: keep every decision the user has
    // already made, and drop decisions about rows that no longer exist.
    const live = new Set(view ? allEditIds(view) : []);
    set({
      view,
      decided: current.decided.filter((id) => live.has(id)),
      undone: current.undone.filter((id) => live.has(id)),
      expanded: current.expanded.filter((id) => live.has(id)),
    });
  },

  toggleExpanded: (id) => {
    const { expanded } = get();
    set({
      expanded: expanded.includes(id)
        ? expanded.filter((candidate) => candidate !== id)
        : [...expanded, id],
    });
  },

  keepAll: () => {
    const { view } = get();
    if (!view) return;
    set({ decided: allEditIds(view), undone: [] });
  },

  undoAll: () => {
    const { view } = get();
    if (!view) return;
    set({ decided: allEditIds(view), undone: allEditIds(view) });
  },

  undoSection: (file, section) => {
    const { view, undone } = get();
    if (!view) return;
    const ids = sectionEditIds(view, file, section);
    if (ids.length === 0) return;
    set({
      decided: allEditIds(view),
      undone: [...new Set([...undone, ...ids])],
    });
  },

  undoFile: (file) => {
    const { view, undone } = get();
    if (!view) return;
    const ids = fileEditIds(view, file);
    if (ids.length === 0) return;
    set({
      decided: allEditIds(view),
      undone: [...new Set([...undone, ...ids])],
    });
  },

  clear: () => set({ requestId: null, ...EMPTY }),

  keptIds: () => {
    const { view, undone } = get();
    if (!view) return [];
    const gone = new Set(undone);
    return allEditIds(view).filter((id) => !gone.has(id));
  },

  unreviewedCount: () => {
    const { view, decided } = get();
    return view ? unreviewedIds(view, decided).length : 0;
  },
}));

/** Footer totals over the edits the user still holds. */
export function changeSetTotals(state: ChangeSetState): { added: number; removed: number } {
  if (!state.view) return { added: 0, removed: 0 };
  return remainingTotals(state.view, state.undone);
}
