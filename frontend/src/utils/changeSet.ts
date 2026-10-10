/**
 * Post-hoc edit review — the pure model behind the transcript rows and the
 * footer summary.
 *
 * The backend's change set is the request's whole edit history: rows in the
 * order the model made them, plus a summary grouped by file and section.
 * The rules from the plan live HERE, where they can be tested without a DOM:
 *
 *  1. **The transcript is history; the summary is a decision surface.** Rows
 *     are flat and chronological (a superseded row stays visible and says so);
 *     the summary lists what is still UNDECIDED and counts only that.
 *  2. **Identity is file + section (+ key), never a line number.** Line
 *     numbers are navigation plumbing, and a row that displayed one would
 *     invite the user to reason in a coordinate space the change set does not
 *     use.
 *  3. **A decided edit leaves the summary.** Keep and undo both end a
 *     decision; what stays on screen is exactly what still needs one.
 *
 * Nothing here talks to the network or to React. `changeSetStore` owns the
 * decisions; `ChatDialog` performs the replay the undos imply.
 */
import type { ChangeSetEdit, ChangeSetFile, ChangeSetPayload } from '../services/api';
import { summarizeAdvisorySeverities, type AdvisorySeverityCounts } from './approvalDiff';

export interface ChangeSetRow extends ChangeSetEdit {
  /** Advisory badge counts (⚠ warn / ✕ error-severity / ℹ other). */
  badge: AdvisorySeverityCounts;
  /** `file / [section]` (plus the param for a set_param). */
  label: string;
  /**
   * Which request staged this edit, once several are merged into the running
   * total. Row ids are only unique within a request, so a merged row's id is
   * namespaced (see `namespacedId`).
   */
  requestId?: string;
}

export interface ChangeSetView {
  /** Chronological rows — one per edit, superseded ones included. */
  rows: ChangeSetRow[];
  /** Grouped by file and section — the decision surface. */
  files: ChangeSetFile[];
  totalAdded: number;
  totalRemoved: number;
  createdFiles: string[];
  /** Ids of the edits that still count (superseded rows excluded). */
  liveIds: string[];
  /**
   * file → the text that file had BEFORE the review's first edit to it.
   *
   * The text view's pane needs both halves of the document to show the WHOLE
   * file with the changed lines marked (SIR 2026-10-03); the current half it
   * already holds (it is the buffer), so only this one is carried. Merged
   * across requests the OLDEST segment wins: the pane's frame is "before the
   * review started", not "before the latest message".
   */
  frames: Record<string, string>;
}

/** One section's still-undecided edits, with a per-section decision. */
export interface PendingSection {
  file: string;
  section: string;
  added: number;
  removed: number;
  /** Ids still awaiting a decision in this section. */
  ids: string[];
  advisories: { error: number; warning: number; other: number };
}

/** One file's still-undecided edits, grouped for the summary. */
export interface PendingFile {
  file: string;
  added: number;
  removed: number;
  sections: PendingSection[];
}

/** `printer.cfg / [stepper_x] microsteps` — the row's collapsed label. */
export function changeRowLabel(row: {
  file: string;
  section: string;
  key?: string;
}): string {
  const file = row.file || '(unknown file)';
  if (!row.section) return file;
  return `${file} / ${sectionLabel(row)}`;
}

/**
 * `[stepper_x] microsteps` — the row's identity without the file.
 *
 * Used wherever the file is already on screen (the pane's header and its
 * navigation stops), so the two can never word the same change differently.
 */
export function sectionLabel(row: { section: string; key?: string; file?: string }): string {
  if (!row.section) return row.file ?? '';
  return row.key ? `[${row.section}] ${row.key}` : `[${row.section}]`;
}

/**
 * Build the review model, or null when there is nothing to review.
 *
 * A change set with no edits is null rather than an empty view: an empty
 * summary is a claim that something changed.
 */
export function buildChangeSetView(set: ChangeSetPayload | null | undefined): ChangeSetView | null {
  if (!set || !set.edits || set.edits.length === 0) return null;
  const rows: ChangeSetRow[] = set.edits.map((edit) => ({
    ...edit,
    badge: summarizeAdvisorySeverities(edit.advisories ?? []),
    label: changeRowLabel(edit),
  }));
  const frames: Record<string, string> = {};
  for (const file of set.files ?? []) {
    // A payload from before the frame existed simply has no entry: the pane
    // then falls back to the rows' own diffs rather than claiming a document.
    if (typeof file.beforeText === 'string') frames[file.file] = file.beforeText;
  }
  return {
    rows,
    files: set.files ?? [],
    totalAdded: set.totalAdded ?? 0,
    totalRemoved: set.totalRemoved ?? 0,
    createdFiles: set.createdFiles ?? [],
    liveIds: rows.filter((row) => !row.superseded).map((row) => row.id),
    frames,
  };
}

/** What a superseded row says instead of pretending it is still the change. */
export function supersededNote(row: ChangeSetRow): string {
  return row.superseded ? 'replaced by a later edit' : '';
}

/** Every edit id in the set (superseded rows included — replay tolerates them). */
export function allEditIds(view: ChangeSetView): string[] {
  return view.rows.map((row) => row.id);
}

/** Rows the user still has to decide about: surviving, and not yet decided. */
export function unreviewedIds(
  view: ChangeSetView,
  decided: readonly string[],
): string[] {
  const seen = new Set(decided);
  return view.liveIds.filter((id) => !seen.has(id));
}

/** `+A −R` over a chosen set of edit ids (superseded rows never count). */
export function totalsForIds(
  view: ChangeSetView,
  ids: readonly string[],
): { added: number; removed: number } {
  const wanted = new Set(ids);
  let added = 0;
  let removed = 0;
  for (const row of view.rows) {
    if (row.superseded || !wanted.has(row.id)) continue;
    added += row.added;
    removed += row.removed;
  }
  return { added, removed };
}

/**
 * The summary's rows: only what is still undecided, grouped by file and
 * section. A fully decided section (or file) disappears — the summary is a
 * to-do list, not a receipt.
 */
export function pendingGroups(
  view: ChangeSetView,
  decided: readonly string[],
): PendingFile[] {
  const seen = new Set(decided);
  return groupRows(view.rows.filter((row) => !row.superseded && !seen.has(row.id)));
}

/** Group rows by file and section, summing their counts and advisories. */
export function groupRows(rows: readonly ChangeSetRow[]): PendingFile[] {
  const byFile = new Map<string, PendingFile>();
  for (const row of rows) {
    if (row.superseded) continue;
    let file = byFile.get(row.file);
    if (!file) {
      file = { file: row.file, added: 0, removed: 0, sections: [] };
      byFile.set(row.file, file);
    }
    let section = file.sections.find((candidate) => candidate.section === row.section);
    if (!section) {
      section = {
        file: row.file,
        section: row.section,
        added: 0,
        removed: 0,
        ids: [],
        advisories: { error: 0, warning: 0, other: 0 },
      };
      file.sections.push(section);
    }
    section.added += row.added;
    section.removed += row.removed;
    section.ids.push(row.id);
    section.advisories.error += row.badge.error;
    section.advisories.warning += row.badge.warning;
    section.advisories.other += row.badge.other;
    file.added += row.added;
    file.removed += row.removed;
  }
  return [...byFile.values()];
}

/**
 * The keep list after undoing `undoneIds`: kept is everything NOT undone.
 *
 * Undo is expressed as a replay of the kept ops (backend hard rule 4), so
 * the client never computes a new text — it only says what survives.
 */
export function keptIdsAfterUndo(
  view: ChangeSetView,
  undoneIds: readonly string[],
): string[] {
  const gone = new Set(undoneIds);
  return allEditIds(view).filter((id) => !gone.has(id));
}

/** Ids of one section group (what a per-section decision covers). */
export function sectionEditIds(
  view: ChangeSetView,
  file: string,
  section: string,
  decided: readonly string[] = [],
): string[] {
  const seen = new Set(decided);
  return view.rows
    .filter((row) => !row.superseded && !seen.has(row.id)
      && row.file === file && row.section === section)
    .map((row) => row.id);
}

/** Ids of every undecided edit in one file (a per-file decision). */
export function fileEditIds(
  view: ChangeSetView,
  file: string,
  decided: readonly string[] = [],
): string[] {
  const seen = new Set(decided);
  return view.rows
    .filter((row) => !row.superseded && !seen.has(row.id) && row.file === file)
    .map((row) => row.id);
}

// ── The running total (several requests' change sets) ──────────────────

/** A row id is only unique within its request; the merged set namespaces it. */
export function namespacedId(requestId: string, id: string): string {
  return `${requestId}:${id}`;
}

export interface ChangeSetSegmentView {
  requestId: string;
  view: ChangeSetView;
}

/**
 * The rows belonging to ONE request, oldest-first ordering preserved.
 *
 * `requestId === null` means "the newest segment" — what is streaming right
 * now, before any reply message exists to hang the rows on.
 */
export function rowsForRequest(
  segments: readonly ChangeSetSegmentView[],
  requestId: string | null,
): ChangeSetRow[] {
  const segment = requestId === null
    ? segments[segments.length - 1]
    : segments.find((candidate) => candidate.requestId === requestId);
  if (!segment) return [];
  return segment.view.rows.map((row) => ({
    ...row,
    id: namespacedId(segment.requestId, row.id),
    requestId: segment.requestId,
  }));
}

/**
 * Fold several requests' change sets into ONE review set, oldest first.
 *
 * The change set is a running total (Sir, 2026-10-02): sending another message
 * must not clear the edits the last one staged, so the summary spans requests
 * and a single decision can cover edits from several of them. Ids are
 * namespaced because each request numbers its edits from `e0` again.
 *
 * Rows stay in the order they were made — the transcript is history — and a
 * re-edit of the same target in a LATER request is a separate row on purpose:
 * the two are independent decisions (keeping the first and dropping the second
 * is a real state), so nothing is silently collapsed across requests.
 */
export function mergeChangeSetViews(
  segments: readonly ChangeSetSegmentView[],
): ChangeSetView | null {
  const kept = segments.filter((segment) => segment.view.rows.length > 0);
  if (kept.length === 0) return null;
  const rows: ChangeSetRow[] = [];
  const createdFiles = new Set<string>();
  // Oldest first wins: the pane's frame is the document before the REVIEW,
  // so an earlier request's pre-edit text beats a later one's (which already
  // contains the earlier request's edits).
  const frames: Record<string, string> = {};
  let totalAdded = 0;
  let totalRemoved = 0;
  for (const segment of kept) {
    for (const row of segment.view.rows) {
      rows.push({ ...row, id: namespacedId(segment.requestId, row.id), requestId: segment.requestId });
    }
    for (const [file, text] of Object.entries(segment.view.frames)) {
      if (!(file in frames)) frames[file] = text;
    }
    totalAdded += segment.view.totalAdded;
    totalRemoved += segment.view.totalRemoved;
    for (const file of segment.view.createdFiles) createdFiles.add(file);
  }
  return {
    rows,
    files: groupRows(rows).map((file) => ({
      file: file.file,
      added: file.added,
      removed: file.removed,
      sections: file.sections.map((section) => ({
        file: section.file,
        section: section.section,
        added: section.added,
        removed: section.removed,
        edits: section.ids,
        advisories: section.advisories,
      })),
    })),
    totalAdded,
    totalRemoved,
    createdFiles: [...createdFiles],
    liveIds: rows.filter((row) => !row.superseded).map((row) => row.id),
    frames,
  };
}
