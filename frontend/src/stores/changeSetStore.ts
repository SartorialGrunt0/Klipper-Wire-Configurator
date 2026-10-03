/**
 * The live change set under review (post-hoc edit review).
 *
 * A store, not component state: the transcript rows, the footer summary, the
 * text view's diff pane and the save gate all read the SAME set.
 *
 * **It is a running total, not a per-reply set** (Sir, 2026-10-02). Sending
 * another message must not clear the edits the last one staged: segments
 * accumulate, oldest first, and a decision can cover edits from several
 * requests. That is also why decisions are tracked as ids, never as text —
 * undoing is a REPLAY of the kept ops on the backend
 * (`POST /ai/chat/changes/resolve`, which takes the whole chain), so the
 * server produces the text and the client only says what survives.
 *
 * Decision semantics: keep and undo both END a decision, and a decided edit
 * leaves the summary — the summary is a to-do list. Keeping changes nothing in
 * the text (it is already applied); undoing removes the edit and its effect.
 */
import { create } from 'zustand';

import type { ChangeSetPayload } from '../services/api';
import {
  buildChangeSetView,
  fileEditIds,
  groupRows,
  mergeChangeSetViews,
  namespacedId,
  sectionEditIds,
  totalsForIds,
  unreviewedIds,
  type ChangeSetView,
  type PendingFile,
} from '../utils/changeSet';

/** One request's share of the running total. */
export interface ChangeSetSegment {
  requestId: string;
  view: ChangeSetView;
}

export interface ChangeSetState {
  /** Oldest first: the order the requests were made in. */
  segments: ChangeSetSegment[];
  /** The merged review view over every segment (null when nothing is staged). */
  view: ChangeSetView | null;
  /** Namespaced ids the user KEPT (`requestId:rowId`). */
  kept: string[];
  /** Namespaced ids the user UNDID: their effect is gone from the text. */
  undone: string[];
  /** Rows the user has unfolded (display only, per namespaced id). */
  expanded: string[];
  /**
   * A decision is being replayed right now.
   *
   * Shared, not per-surface: the chat's footer bar and the text view's pane
   * are two views of ONE review, so a button in either must be disabled while
   * the other's request is in flight (2026-10-03).
   */
  busy: boolean;
  /** Honest note from the last resolution (stale ops, failures, a gone set). */
  note: string | null;

  /** Upsert one request's change set (progress rail or the finished reply). */
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
  /** Forget everything — a new chat, or loading another conversation. */
  clear: () => void;

  /** Every id the user has decided on (kept or undone). */
  decidedIds: () => string[];
  /** Edits still awaiting a decision. */
  pendingIds: () => string[];
  /** The summary's rows: undecided edits, grouped, with decided ones gone. */
  pendingGroups: () => PendingFile[];
  /** Undecided edits for ONE file (what the text view's pane shows). */
  pendingRowsForFile: (file: string) => ChangeSetView['rows'];
  /** `+A −R` over what is still undecided. */
  pendingTotals: () => { added: number; removed: number };
  /** How many edits still need a decision. */
  unreviewedCount: () => number;
  /** The local ids one request may keep (its row ids minus the undone ones). */
  keptIdsFor: (requestId: string) => string[];
  /** The whole chain's keep lists, oldest first, for the resolve call. */
  resolveSegments: () => Array<{ requestId: string; keptEditIds: string[] }>;
}

const EMPTY = {
  segments: [] as ChangeSetSegment[],
  view: null as ChangeSetView | null,
  kept: [] as string[],
  undone: [] as string[],
  expanded: [] as string[],
  busy: false,
  note: null as string | null,
};

function mergedView(segments: ChangeSetSegment[]): ChangeSetView | null {
  return mergeChangeSetViews(segments);
}

export const useChangeSetStore = create<ChangeSetState>((set, get) => ({
  ...EMPTY,

  setFromStream: (requestId, payload) => {
    if (!requestId) return;
    const view = buildChangeSetView(payload);
    const { segments } = get();
    const index = segments.findIndex((segment) => segment.requestId === requestId);
    let next: ChangeSetSegment[];
    if (view === null) {
      // Nothing staged (or the payload was cleared): the segment goes away.
      if (index < 0) return;
      next = segments.filter((segment) => segment.requestId !== requestId);
    } else if (index < 0) {
      next = [...segments, { requestId, view }];
    } else {
      next = segments.map((segment, i) => (i === index ? { requestId, view } : segment));
    }
    // Decisions survive the refresh, but only for rows that still exist —
    // a segment that shrank must not leave orphan decisions behind.
    const merged = mergedView(next);
    const live = new Set(merged?.rows.map((row) => row.id) ?? []);
    set({
      segments: next,
      view: merged,
      kept: get().kept.filter((id) => live.has(id)),
      undone: get().undone.filter((id) => live.has(id)),
      expanded: get().expanded.filter((id) => live.has(id)),
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
    if (!get().view) return;
    set({ kept: [...new Set([...get().kept, ...get().pendingIds()])] });
  },

  undoAll: () => {
    if (!get().view) return;
    set({ undone: [...new Set([...get().undone, ...get().pendingIds()])] });
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

  clear: () => set({ ...EMPTY }),

  decidedIds: () => {
    const { kept, undone } = get();
    return [...new Set([...kept, ...undone])];
  },

  pendingIds: () => {
    const { view } = get();
    return view ? unreviewedIds(view, get().decidedIds()) : [];
  },

  pendingGroups: () => {
    const { view } = get();
    if (!view) return [];
    const decided = new Set(get().decidedIds());
    return groupRows(view.rows.filter((row) => !row.superseded && !decided.has(row.id)));
  },

  pendingRowsForFile: (file) => {
    const { view } = get();
    if (!view) return [];
    const decided = new Set(get().decidedIds());
    return view.rows.filter(
      (row) => !row.superseded && !decided.has(row.id) && row.file === file,
    );
  },

  pendingTotals: () => {
    const { view } = get();
    if (!view) return { added: 0, removed: 0 };
    return totalsForIds(view, get().pendingIds());
  },

  unreviewedCount: () => get().pendingIds().length,

  keptIdsFor: (requestId) => {
    const { segments, undone } = get();
    const segment = segments.find((candidate) => candidate.requestId === requestId);
    if (!segment) return [];
    const gone = new Set(undone);
    return segment.view.rows
      .map((row) => row.id)
      .filter((localId) => !gone.has(namespacedId(requestId, localId)));
  },

  resolveSegments: () => get().segments.map((segment) => ({
    requestId: segment.requestId,
    keptEditIds: get().keptIdsFor(segment.requestId),
  })),
}));

/** Summary totals over the edits the user still has to decide. */
export function changeSetTotals(state: ChangeSetState): { added: number; removed: number } {
  if (!state.view) return { added: 0, removed: 0 };
  return totalsForIds(state.view, state.pendingIds());
}
