/**
 * Navigation for the text view's review pane: WHERE the pending changes are,
 * in the order the reader meets them.
 *
 * The list spans EVERY file the review touched (Sir, 2026-10-04): the strip's
 * `change i of n` counts all of them, and the arrows walk out of one file and
 * into the next, so the unit the arrows move between is a stop plus the file
 * it lives in (`PendingStop`). Each file's stops are in ITS document order and
 * the files themselves are in the order the model first touched them.
 *
 * A **change stop** is a run of adjacent changed rows in the pane's rendered
 * diff. Two edits on adjacent lines are ONE stop (that is what the eye sees);
 * edits apart are separate stops, listed in DOCUMENT order even when the model
 * made them out of order.
 *
 * Each stop carries the pending rows that own it, matched by CONTENT — the
 * row's own `diffText` ± lines against the stop's, read in the SAME space on
 * both sides (`normalizeChangeLines`). Line numbers play no part: a row's hunk
 * headers are numbered in the file as it stood when that op ran, and the
 * pane's frame is numbered as it stood when the review began. Content is the
 * same in both spaces; offsets are not recoverable without replaying the ops
 * in the client, which this codebase deliberately never does.
 *
 * Pure: no React, no store, no DOM.
 */
import { parsePatch, normalizeChangeLines, type DiffLine } from './configDiff';
import { buildUnreviewedDiffModel, type PendingDiffModel } from './pendingDiff';
import { sectionLabel, type ChangeSetRow } from './changeSet';

export interface ChangeStop {
  /** Index into `model.lines` where the stop's first changed row sits. */
  row: number;
  /** Ids of the pending rows this stop belongs to, in row order. */
  ids: string[];
  /** `[stepper_x] microsteps` — one label per owning row. */
  label: string;
}

/**
 * A stop plus the file it lives in — the unit the strip walks.
 *
 * The strip's `change i of n` counts every undecided change the model made, in
 * EVERY file (Sir, 2026-10-04), so a stop has to name its file: `row` is a
 * position inside ONE rendered document and means nothing without it.
 *
 * Stops deliberately carry no LINE numbers. They stopped being read when the
 * cursor became identity-based (a change is found by its row ids), and a line
 * range here is a trap: this list spans files, and line numbers are numbered
 * inside one document.
 */
export interface PendingStop extends ChangeStop {
  file: string;
}

/** One file's undecided rows, with the two texts the pane diffs for it. */
export interface ReviewFileInput {
  file: string;
  rows: readonly ChangeSetRow[];
  /** The file before the review's first edit to it — the pane's frame. */
  before?: string | null;
  /** The client's current text for the file; null when it is not loaded. */
  after?: string | null;
}

export interface ReviewStops {
  /** file → the document the pane renders for it. No stop, no model. */
  models: Record<string, PendingDiffModel>;
  /** Every change across every file, in walk order. */
  stops: PendingStop[];
}

/**
 * The whole review as ONE list, and the documents it can be walked over.
 *
 * Built per file — each file's stops are in its own document order, which is
 * the order a reader meets them — then concatenated in the order the files
 * appear in the change set (the order the model first touched them). That is
 * the order a reader walks: the strip's arrows cross from the last change in
 * one file into the first change in the next, switching the text view as they
 * go.
 *
 * A file whose changes own no stop — they were hand-edited away, or the frame
 * no longer carries them — contributes no model and no stops: it is not a
 * place the walk can stop, so it must not be a document the pane can render
 * with the cursor pointing somewhere else.
 */
export function buildReviewStops(files: readonly ReviewFileInput[]): ReviewStops {
  const models: Record<string, PendingDiffModel> = {};
  const stops: PendingStop[] = [];
  for (const input of files) {
    if (input.rows.length === 0) continue;
    const framed = typeof input.before === 'string' && typeof input.after === 'string';
    const model = buildUnreviewedDiffModel(
      input.rows,
      input.file,
      framed ? { before: input.before as string, after: input.after as string } : null,
    );
    if (!model) continue;
    const fileStops = changeStops(model, input.rows);
    if (fileStops.length === 0) continue;
    models[input.file] = model;
    for (const stop of fileStops) stops.push({ ...stop, file: input.file });
  }
  return { models, stops };
}

/** The changed lines one pending row's own diff carries, by kind. */
function rowChangeTexts(row: ChangeSetRow): { added: string[]; removed: string[] } {
  const added: string[] = [];
  const removed: string[] = [];
  for (const line of parsePatch(row.diffText)) {
    if (line.type === 'added') added.push(line.content);
    else if (line.type === 'removed') removed.push(line.content);
  }
  return { added, removed };
}

/** Is every line of `wanted` present in `pool` (multiset, same kind)? */
function containsAll(pool: string[], wanted: string[]): boolean {
  const left = [...pool];
  for (const text of wanted) {
    const at = left.indexOf(text);
    if (at < 0) return false;
    left.splice(at, 1);
  }
  return true;
}

/** Does this stop carry exactly the change this row made? */
function stopOwns(stop: { added: string[]; removed: string[] }, texts: {
  added: string[];
  removed: string[];
}): boolean {
  // A row with no changed lines at all owns nothing; an empty SET is not a
  // match, but an empty SIDE is (a pure insertion has nothing removed, and a
  // pure deletion has nothing added).
  if (texts.added.length === 0 && texts.removed.length === 0) return false;
  // Both sides are normalized before comparing: the stop's lines come from the
  // pane's frame diff (normalized) while the row's come from the backend's raw
  // one, so a trailing space or a doubled blank would otherwise make an edit
  // that is plainly on screen own nothing.
  return containsAll(normalizeChangeLines(stop.added), normalizeChangeLines(texts.added))
    && containsAll(normalizeChangeLines(stop.removed), normalizeChangeLines(texts.removed));
}

/**
 * The stops in a rendered model, in document order.
 *
 * `rows` are the pending rows the model was built from — the same array the
 * pane renders from, so a stop can never name an edit that is not on screen.
 */
export function changeStops(
  model: PendingDiffModel,
  rows: readonly ChangeSetRow[],
): ChangeStop[] {
  const stops: Array<ChangeStop & { added: string[]; removed: string[] }> = [];
  let current: (typeof stops)[number] | null = null;

  const closeRun = () => {
    if (current) stops.push(current);
    current = null;
  };

  model.lines.forEach((line: DiffLine, index: number) => {
    // A run of adjacent changed rows is one stop — that is what the eye sees.
    if (line.type === 'context' || line.type === 'header') {
      closeRun();
      return;
    }
    if (!current) {
      current = { row: index, ids: [], label: '', added: [], removed: [] };
    }
    if (line.type === 'removed') current.removed.push(line.content);
    else current.added.push(line.content);
  });
  closeRun();

  // Owners: greedily, in document order, each row claimed once. A row whose
  // changed lines are not in any stop (it was decided, or a hand edit moved
  // it) simply owns nothing.
  const unclaimed = [...rows];
  for (const stop of stops) {
    const owners: ChangeSetRow[] = [];
    for (let i = 0; i < unclaimed.length; i += 1) {
      const row = unclaimed[i];
      const texts = rowChangeTexts(row);
      if (stopOwns(stop, texts)) {
        owners.push(row);
        unclaimed.splice(i, 1);
        i -= 1;
      }
    }
    stop.ids = owners.map((row) => row.id);
    stop.label = owners.map(sectionLabel).join(', ');
  }

  return stops.map(({ added: _added, removed: _removed, ...stop }) => stop);
}

/**
 * Where the cursor lands after the review moved under it.
 *
 * IDENTITY FIRST: if the change the reader was on is still in the list, the
 * cursor stays on it — so a change decided from somewhere else (the chat's
 * summary bar) must not drag the reader off what they are reading. Otherwise
 * the change is gone (decided, or undone): the cursor takes whatever now
 * occupies its slot, clamped to the last item, so reviewing downward stays
 * downward.
 *
 * Line numbers deliberately play no part. They are numbered inside ONE file,
 * and this list spans every file in the review; the rule this replaces ("the
 * first change at or below the one just decided") was written when the list
 * was a single file.
 */
export function stopIndexForAnchor(
  stops: readonly { ids: readonly string[] }[],
  anchorIds: readonly string[],
  fallbackIndex: number,
): number {
  if (stops.length === 0) return -1;
  const anchor = new Set(anchorIds);
  const at = stops.findIndex((stop) => stop.ids.some((id) => anchor.has(id)));
  if (at >= 0) return at;
  return Math.min(Math.max(fallbackIndex, 0), stops.length - 1);
}
