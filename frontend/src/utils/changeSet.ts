/**
 * Post-hoc edit review — the pure model behind the transcript rows and the
 * footer bar.
 *
 * The backend's change set is the request's whole edit history: rows in the
 * order the model made them, plus a summary grouped by file and section.
 * Two rules from the plan live HERE, where they can be tested without a DOM:
 *
 *  1. **The transcript is history; the summary is a decision surface.** Rows
 *     are flat and chronological (a superseded row stays visible and says so);
 *     the totals and the keep/undo groups are the net surviving set.
 *  2. **Identity is file + section (+ key), never a line number.** Line
 *     numbers are navigation plumbing, and a row that displayed one would
 *     invite the user to reason in a coordinate space the change set does not
 *     use.
 *
 * Nothing here talks to the network or to React. `changeSetStore` owns the
 * decisions; `ChatDialog` performs the replay the decisions imply.
 */
import type { ChangeSetEdit, ChangeSetFile, ChangeSetPayload } from '../services/api';
import { summarizeAdvisorySeverities, type AdvisorySeverityCounts } from './approvalDiff';

export interface ChangeSetRow extends ChangeSetEdit {
  /** Advisory badge counts (⚠ warn / ✕ error-severity / ℹ other). */
  badge: AdvisorySeverityCounts;
  /** `file / [section]` (plus the param for a set_param). */
  label: string;
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
}

/** `printer.cfg / [stepper_x] microsteps` — the row's collapsed label. */
export function changeRowLabel(row: {
  file: string;
  section: string;
  key?: string;
}): string {
  const file = row.file || '(unknown file)';
  if (!row.section) return file;
  const section = `[${row.section}]`;
  return row.key ? `${file} / ${section} ${row.key}` : `${file} / ${section}`;
}

/**
 * Build the review model, or null when there is nothing to review.
 *
 * A change set with no edits is null rather than an empty view: an empty
 * footer bar is a claim that something changed.
 */
export function buildChangeSetView(set: ChangeSetPayload | null | undefined): ChangeSetView | null {
  if (!set || !set.edits || set.edits.length === 0) return null;
  const rows: ChangeSetRow[] = set.edits.map((edit) => ({
    ...edit,
    badge: summarizeAdvisorySeverities(edit.advisories ?? []),
    label: changeRowLabel(edit),
  }));
  return {
    rows,
    files: set.files ?? [],
    totalAdded: set.totalAdded ?? 0,
    totalRemoved: set.totalRemoved ?? 0,
    createdFiles: set.createdFiles ?? [],
    liveIds: rows.filter((row) => !row.superseded).map((row) => row.id),
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

/** Rows the user still has to look at: surviving, and not yet decided. */
export function unreviewedIds(
  view: ChangeSetView,
  decided: readonly string[],
): string[] {
  const seen = new Set(decided);
  return view.liveIds.filter((id) => !seen.has(id));
}

/** Totals over the edits the user still holds (undone ones do not count). */
export function remainingTotals(
  view: ChangeSetView,
  undone: readonly string[],
): { added: number; removed: number } {
  const gone = new Set(undone);
  let added = 0;
  let removed = 0;
  for (const row of view.rows) {
    if (row.superseded || gone.has(row.id)) continue;
    added += row.added;
    removed += row.removed;
  }
  return { added, removed };
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

/** Ids of one section group (what a per-section undo drops). */
export function sectionEditIds(
  view: ChangeSetView,
  file: string,
  section: string,
): string[] {
  const group = view.files
    .find((entry) => entry.file === file)
    ?.sections.find((entry) => entry.section === section);
  return group ? [...group.edits] : [];
}

/** Ids of every surviving edit in one file (what a per-file undo drops). */
export function fileEditIds(view: ChangeSetView, file: string): string[] {
  const entry = view.files.find((candidate) => candidate.file === file);
  if (!entry) return [];
  return entry.sections.flatMap((section) => section.edits);
}
