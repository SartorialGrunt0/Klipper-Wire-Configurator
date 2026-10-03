/**
 * The live change set of the request being reviewed (post-hoc edit review).
 *
 * A store, not component state: the transcript rows, the footer summary and
 * the save gate all read the SAME set, and the set outlives any one of them
 * (the rows render inside the message list, the summary sits above the
 * composer, and the text view's pane is a third reader). `pendingEditStore`
 * set the precedent — one dumb holder, pure logic in `utils/changeSet`.
 *
 * Decisions are tracked as ids, never as text: undoing is a REPLAY of the
 * kept ops on the backend (`POST /ai/chat/changes/resolve`), so this store
 * only records which edits survive and lets the server produce the text.
 *
 * Decision semantics (Sir, 2026-10-02): keep and undo both END a decision,
 * and a decided edit leaves the summary — the summary is a to-do list.
 * Keeping changes nothing in the text (it is already applied); undoing
 * removes the edit, and its effect with it.
 *
 * Lifecycle: a NEW request replaces the set and clears the decisions (the
 * previous set has been decided by then — the save gate keeps it in front of
 * the user until it is).
 */
import { create } from 'zustand';

import type { ChangeSetPayload } from '../services/api';
import {
  allEditIds,
  buildChangeSetView,
  fileEditIds,
  pendingGroups,
  sectionEditIds,
  totalsForIds,
  unreviewedIds,
  type ChangeSetView,
  type PendingFile,
} from '../utils/changeSet';

export interface ChangeSetState {
  requestId: string | null;
  view: ChangeSetView | null;
  /** Ids the user KEPT (decided: the edit stays, the row leaves the summary). */
  kept: string[];
  /** Ids the user UNDID: their effect is gone from the working state. */
  undone: string[];
  /** Rows the user has unfolded (display only, per row id). */
  expanded: string[];

  /** Fold a payload from the progress rail or the finished reply. */
  setFromStream: (requestId: string | null, payload: ChangeSetPayload | null | undefined) => void;
  toggleExpanded: (id: string) => void;

  /** Keep every edit that is still undecided. No replay: it is already applied. */
  keepAll: () => void;
  /** Undo every edit that is still undecided. */
  undoAll: () => void;
  keepSection: (file: string, section: string, ids?: readonly string[]) => void;
  undoSection: (file: string, section: string, ids?: readonly string[]) => void;
  keepFile: (file: string, ids?: readonly string[]) => void;
  undoFile: (file: string, ids?: readonly string[]) => void;
  clear: () => void;

  /** Every id the user has decided on (kept or undone). */
  decidedIds: () => string[];
  /** Ids to send as `keptEditIds` for the current decisions. */
  keptIds: () => string[];
  /** Edits still awaiting a decision. */
  pendingIds: () => string[];
  /** The summary's rows: undecided edits, grouped, with decided ones gone. */
  pendingGroups: () => PendingFile[];
  /** `+A −R` over what is still undecided. */
  pendingTotals: () => { added: number; removed: number };
  /** How many edits still need a decision. */
  unreviewedCount: () => number;
}

const EMPTY = {
  view: null as ChangeSetView | null,
  kept: [] as string[],
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
      set({ requestId, view, kept: [], undone: [], expanded: [] });
      return;
    }
    // Same request, refreshed by the poll: keep every decision the user has
    // already made, and drop decisions about rows that no longer exist.
    const live = new Set(view ? allEditIds(view) : []);
    set({
      view,
      kept: current.kept.filter((id) => live.has(id)),
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
    const { view, kept } = get();
    if (!view) return;
    set({ kept: [...new Set([...kept, ...get().pendingIds()])] });
  },

  undoAll: () => {
    const { undone } = get();
    set({ undone: [...new Set([...undone, ...get().pendingIds()])] });
  },

  keepSection: (file, section, ids) => {
    const state = get();
    if (!state.view) return;
    const target = ids ?? sectionEditIds(state.view, file, section, state.decidedIds());
    if (target.length === 0) return;
    set({ kept: [...new Set([...state.kept, ...target])] });
  },

  undoSection: (file, section, ids) => {
    const state = get();
    if (!state.view) return;
    const target = ids ?? sectionEditIds(state.view, file, section, state.decidedIds());
    if (target.length === 0) return;
    set({ undone: [...new Set([...state.undone, ...target])] });
  },

  keepFile: (file, ids) => {
    const state = get();
    if (!state.view) return;
    const target = ids ?? fileEditIds(state.view, file, state.decidedIds());
    if (target.length === 0) return;
    set({ kept: [...new Set([...state.kept, ...target])] });
  },

  undoFile: (file, ids) => {
    const state = get();
    if (!state.view) return;
    const target = ids ?? fileEditIds(state.view, file, state.decidedIds());
    if (target.length === 0) return;
    set({ undone: [...new Set([...state.undone, ...target])] });
  },

  clear: () => set({ requestId: null, ...EMPTY }),

  decidedIds: () => {
    const { kept, undone } = get();
    return [...new Set([...kept, ...undone])];
  },

  keptIds: () => {
    const { view, undone } = get();
    if (!view) return [];
    const gone = new Set(undone);
    return allEditIds(view).filter((id) => !gone.has(id));
  },

  pendingIds: () => {
    const { view } = get();
    return view ? unreviewedIds(view, get().decidedIds()) : [];
  },

  pendingGroups: () => {
    const { view } = get();
    return view ? pendingGroups(view, get().decidedIds()) : [];
  },

  pendingTotals: () => {
    const { view } = get();
    if (!view) return { added: 0, removed: 0 };
    return totalsForIds(view, get().pendingIds());
  },

  unreviewedCount: () => get().pendingIds().length,
}));

/** Summary totals over the edits the user still has to decide. */
export function changeSetTotals(state: ChangeSetState): { added: number; removed: number } {
  if (!state.view) return { added: 0, removed: 0 };
  return totalsForIds(state.view, state.pendingIds());
}
