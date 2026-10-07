/**
 * The live change set under review (post-hoc edit review).
 *
 * A store, not component state: the transcript rows, the footer summary and
 * the text view's review all read the SAME set.
 *
 * **It is a running total, not a per-reply set** (Sir, 2026-10-02). Sending
 * another message must not clear the edits the last one staged: segments
 * accumulate, oldest first, so the transcript can show every request's rows.
 * Those rows are now DISPLAY-ONLY history — nothing is decided by id.
 *
 * Decisions are the mechanical ledger's (Sir, 2026-10-07):
 *
 *     review(file) = diff(FRAME, LIVE)
 *
 * This store holds only the FRAME per file — the document as far as the
 * decisions go — seeded once from the change-set payload and thereafter
 * spliced by `services/reviewEngine`. There is no kept/undone id list: a
 * decided run self-records by no longer being a difference, so stale
 * operations cannot exist and no server call is involved.
 */
import { create } from 'zustand';

import type { ChangeSetPayload } from '../services/api';
import {
  buildChangeSetView,
  mergeChangeSetViews,
  type ChangeSetView,
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
  /** Rows the user has unfolded (display only, per namespaced id). */
  expanded: string[];
  /**
   * file → the review's FRAME. `null` means the review CREATED the file, so
   * its whole live text is one green run. A file with no entry is not under
   * review. Seeded once (`seedFrames`) and thereafter spliced by a keep — an
   * undo never changes a frame, because the frame is the pre-review state by
   * definition.
   */
  reviewFrames: Record<string, string | null>;

  /** Upsert one request's change set (progress rail or the finished reply). */
  setFromStream: (requestId: string | null, payload: ChangeSetPayload | null | undefined) => void;
  /**
   * Seed the FRAMES for a request, WITHOUT clobbering a review already in
   * progress: a file that already has a frame keeps it (the review the user is
   * in the middle of deciding must survive the next poll tick's payload).
   */
  seedFrames: (frames: Record<string, string | null>) => void;
  /** Replace ONE file's frame (the engine's keep splice). */
  setReviewFrame: (file: string, frame: string | null) => void;
  /** Drop ONE file's frame (a created file undone away). */
  removeReviewFrame: (file: string) => void;
  toggleExpanded: (id: string) => void;
  /** Forget everything — a new chat, or loading another conversation. */
  clear: () => void;
}

const EMPTY = {
  segments: [] as ChangeSetSegment[],
  view: null as ChangeSetView | null,
  expanded: [] as string[],
  reviewFrames: {} as Record<string, string | null>,
};

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
    const merged = mergeChangeSetViews(next);
    // Unfolded rows that no longer exist are dropped; the frame needs no such
    // pruning — a decided run has already left the diff by construction.
    const live = new Set(merged?.rows.map((row) => row.id) ?? []);
    set({
      segments: next,
      view: merged,
      expanded: get().expanded.filter((id) => live.has(id)),
    });
  },

  seedFrames: (frames) => {
    const current = get().reviewFrames;
    const next = { ...current };
    let changed = false;
    for (const [file, text] of Object.entries(frames)) {
      if (file in next) continue;
      next[file] = text;
      changed = true;
    }
    if (changed) set({ reviewFrames: next });
  },

  setReviewFrame: (file, frame) => {
    set((s) => ({ reviewFrames: { ...s.reviewFrames, [file]: frame } }));
  },

  removeReviewFrame: (file) => {
    set((s) => {
      if (!(file in s.reviewFrames)) return s;
      const next = { ...s.reviewFrames };
      delete next[file];
      return { reviewFrames: next };
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

  clear: () => set({ ...EMPTY }),
}));
