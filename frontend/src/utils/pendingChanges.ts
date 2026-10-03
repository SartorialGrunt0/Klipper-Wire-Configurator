/**
 * Navigation for the text view's review pane: WHERE the pending changes are,
 * in the order the reader meets them.
 *
 * A **change stop** is a run of adjacent changed rows in the pane's rendered
 * diff — the unit a `‹ ›` button moves between. Two edits on adjacent lines
 * are ONE stop (that is what the eye sees); edits apart are separate stops,
 * listed in DOCUMENT order even when the model made them out of order.
 *
 * Each stop carries the pending rows that own it. Ownership is matched by
 * CONTENT — the row's own `diffText` ±  lines against the stop's — never by
 * arithmetic on line numbers, because a row's hunk headers are numbered in the
 * file as it stood when that op ran, and the pane's frame is numbered in the
 * file as it stood when the review began. Content is the same in both spaces;
 * offsets are not recoverable without replaying the ops in the client, which
 * this codebase deliberately never does.
 *
 * Pure: no React, no store, no DOM.
 */
import { parsePatch, type DiffLine } from './configDiff';
import type { PendingDiffModel } from './pendingDiff';
import { sectionLabel, type ChangeSetRow } from './changeSet';

export interface ChangeStop {
  /** Index into `model.lines` where the stop's first changed row sits. */
  row: number;
  /** First and last line the stop touches, in the file's BEFORE space. */
  lineStart: number;
  lineEnd: number;
  /** Ids of the pending rows this stop belongs to, in row order. */
  ids: string[];
  /** `[stepper_x] microsteps` — one label per owning row. */
  label: string;
}

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/;

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
  return containsAll(stop.added, texts.added) && containsAll(stop.removed, texts.removed);
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
  let before = 1;
  /** First before-line of the run we are inside, if any (see changedBeforeLines). */
  let runStart: number | null = null;
  let current: (typeof stops)[number] | null = null;

  const closeRun = () => {
    if (current) stops.push(current);
    current = null;
    runStart = null;
  };

  model.lines.forEach((line: DiffLine, index: number) => {
    if (line.type === 'header') {
      const match = line.content.match(HUNK_HEADER_RE);
      if (match) before = Number(match[1]);
      closeRun();
      return;
    }
    if (line.type === 'context') {
      closeRun();
      before += 1;
      return;
    }
    const lineNumber = line.type === 'removed'
      ? before
      : Math.max(1, runStart ?? before);
    if (!current) {
      current = {
        row: index,
        lineStart: lineNumber,
        lineEnd: lineNumber,
        ids: [],
        label: '',
        added: [],
        removed: [],
      };
    }
    current.lineEnd = Math.max(current.lineEnd, lineNumber);
    if (line.type === 'removed') {
      if (runStart === null) runStart = before;
      current.removed.push(line.content);
      before += 1;
    } else {
      current.added.push(line.content);
    }
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
 * Where the cursor should land after a decision moved the marks under it.
 *
 * `lastLineStart` is the line the reader was on before the file was re-diffed.
 * Reviewing downward should stay downward: take the first change at or below
 * it, and fall back to the last change when the decided one was at the end of
 * the file. An empty list has no index to give, so callers get -1.
 */
export function stopIndexAfterChange(
  stops: readonly ChangeStop[],
  lastLineStart: number,
): number {
  if (stops.length === 0) return -1;
  const next = stops.findIndex((stop) => stop.lineStart >= lastLineStart);
  return next === -1 ? stops.length - 1 : next;
}
