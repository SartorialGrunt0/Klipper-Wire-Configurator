/**
 * The mechanical review ledger (Sir's law, 2026-10-07).
 *
 * The review is ONE computation with no server involvement:
 *
 *     review(file) = diff(FRAME, LIVE)
 *
 * The FRAME is the document as far as the decisions go — the ledger. LIVE is
 * the editor's current text. Every run of changed lines between them is a
 * stop: green lines (live, not in frame) and red lines (frame, not in live),
 * "as written" — a human edit inside a run joins it, and the stop describes
 * exactly what the buffer holds.
 *
 * Decisions are splices, not replays:
 *  - KEEP a stop  → the frame takes the live version of that run (text does
 *    not move; the stop stops being a difference).
 *  - UNDO a stop  → live takes the frame version of that run (the green lines
 *    are deleted as written and the red lines come back as written).
 *
 * That is the whole engine. "The model added a section then removed it" nets
 * to zero difference, so it is not a stop and nothing asks for review. Chat
 * and text view show the same edits because they read the same ledger.
 *
 * Stale operations cannot exist here: there is no op replay, no anchors to
 * re-resolve, and no server session that can expire mid-review.
 *
 * Pure: no React, no store, no DOM. Coordinates are 1-based line numbers in
 * each text (the same space the editor's gutter and the bands use).
 */
import { diffLines } from 'diff';

/** One contiguous difference between the frame and the live text. */
export interface ReviewRun {
  /** Stable-ish identity: position in BOTH texts plus shape. Recomputed
   * every keystroke, so a hand edit re-keys only the runs it touched. */
  key: string;
  /** First/last live line of the run (1-based). For a pure deletion that
   * consumes frame lines with no live lines, `liveStart` is the live line the
   * removal would return to and `liveEnd` = liveStart - 1 (empty range). */
  liveStart: number;
  liveEnd: number;
  /** First frame line of the run (1-based) and how many frame lines it takes. */
  frameStart: number;
  frameCount: number;
  /** The live lines of the run (green, as written). */
  added: string[];
  /** The frame lines the run removed (red, as written). */
  removed: string[];
}

/** Count the lines a diff part carries (a trailing '\n' does not add a line). */
function partLineCount(value: string): number {
  if (value === '') return 0;
  const lines = value.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines.length;
}

function partLines(value: string): string[] {
  const lines = value.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * The stops of one file: diff(frame, live) walked into runs.
 *
 * Adjacent added/removed parts (a replacement) form ONE run — that is what
 * the reader sees and the unit keep/undo acts on. Context advances both
 * counters; removals advance only the frame; additions only the live.
 *
 * A missing frame text ('' for a file the review created) makes the whole
 * live text one green run; a missing live text (file deleted during review)
 * makes the whole frame one red run at live line 1. Callers pass null for a
 * text that genuinely does not exist (created/deleted file), '' for empty.
 */
export function reviewRuns(frame: string | null, live: string | null): ReviewRun[] {
  if (frame === null && live === null) return [];
  if (frame === null) {
    const lines = partLines(live ?? '');
    if (lines.length === 0) return [];
    return [{
      key: 'create-0', liveStart: 1, liveEnd: lines.length, frameStart: 1, frameCount: 0,
      added: lines, removed: [],
    }];
  }
  if (live === null) {
    const lines = partLines(frame);
    if (lines.length === 0) return [];
    return [{
      key: 'delete-0', liveStart: 1, liveEnd: 0, frameStart: 1, frameCount: lines.length,
      added: [], removed: lines,
    }];
  }
  const runs: ReviewRun[] = [];
  let liveLine = 1;
  let frameLine = 1;
  let current: ReviewRun | null = null;
  const close = () => {
    if (current && (current.added.length > 0 || current.removed.length > 0)) runs.push(current);
    current = null;
  };
  for (const part of diffLines(frame, live)) {
    const n = partLineCount(part.value);
    if (n === 0) continue;
    if (!part.added && !part.removed) {
      close();
      liveLine += n;
      frameLine += n;
      continue;
    }
    if (!current) {
      current = {
        key: '',
        liveStart: liveLine,
        liveEnd: liveLine - 1,
        frameStart: frameLine,
        frameCount: 0,
        added: [],
        removed: [],
      };
    }
    if (part.added) {
      current.added.push(...partLines(part.value));
      current.liveEnd = liveLine + n - 1;
      liveLine += n;
    } else {
      current.removed.push(...partLines(part.value));
      current.frameCount += n;
      frameLine += n;
    }
  }
  close();
  for (const run of runs) {
    run.key = `${run.frameStart}:${run.liveStart}+${run.added.length}-${run.removed.length}`;
  }
  return runs;
}

/**
 * KEEP: the frame takes the live version of the named runs.
 *
 * Text does not move — this returns the NEW frame for the file. Keeping every
 * run makes the frame equal the live text, which empties the review. Splices
 * are applied to the frame in DESCENDING frameStart order so earlier
 * coordinates stay valid while later ones are replaced.
 */
export function keepRunsInFrame(
  frame: string | null,
  live: string,
  runs: readonly ReviewRun[],
  keepKeys: ReadonlySet<string>,
): string {
  const targets = runs.filter((run) => keepKeys.has(run.key));
  if (targets.length === 0) return frame ?? '';
  const frameLines = partLines(frame ?? '');
  const ordered = [...targets].sort((a, b) => b.frameStart - a.frameStart);
  for (const run of ordered) {
    const at = Math.min(Math.max(run.frameStart - 1, 0), frameLines.length);
    frameLines.splice(at, run.frameCount, ...run.added);
  }
  return joinLines(frameLines, live);
}

/**
 * Rebuild text from spliced LINES keeping TEXT's trailing-newline convention.
 *
 * Config files end with a newline; `partLines` drops it and `join('\n')` would
 * silently cost it — the spliced text would then differ from disk by one byte
 * and `markCleanIfMatchesDisk` would call an untouched save dirty (E2E
 * 2026-10-07). The convention comes from the text whose region is being
 * written INTO the target (keep → live's convention, undo → frame's): the
 * decision writes that side's content, so its ending travels with it.
 */
function joinLines(lines: string[], conventionFrom: string): string {
  const joined = lines.join('\n');
  return conventionFrom.endsWith('\n') && joined !== '' ? joined + '\n' : joined;
}

/**
 * UNDO: the live text takes the frame version of the named runs.
 *
 * Returns the NEW live text: green lines removed as written, red lines back
 * as written. (For a created file — frame null — undo is deletion of the
 * file, which the caller handles; this function is not given that case.)
 */
export function undoRunsInLive(
  frame: string,
  live: string,
  runs: readonly ReviewRun[],
  undoKeys: ReadonlySet<string>,
): string {
  const targets = runs.filter((run) => undoKeys.has(run.key));
  if (targets.length === 0) return live;
  const liveLines = partLines(live);
  const frameLines = partLines(frame);
  const ordered = [...targets].sort((a, b) => b.liveStart - a.liveStart);
  for (const run of ordered) {
    const at = run.removed.length > 0 && run.added.length === 0
      // Pure deletion: the live range is empty and liveStart names the line
      // the removal returns to — insert the frame lines there.
      ? Math.min(Math.max(run.liveStart - 1, 0), liveLines.length)
      : Math.min(Math.max(run.liveStart - 1, 0), liveLines.length);
    const deleteCount = Math.max(0, run.liveEnd - run.liveStart + 1);
    liveLines.splice(at, deleteCount, ...run.removed);
  }
  return joinLines(liveLines, frame);
}

/**
 * The `[section]` a run belongs to.
 *
 * 1. A header INSIDE the run wins: a run carrying `[...]` in its added
 *    lines created or renamed a section (add_section at EOF starts the
 *    run at the blank separator, so the upward scan alone would label
 *    the NEW section with whatever sat above it — live report
 *    2026-10-09: `CIRCLE_HOME` + `gcode_arcs` shown as
 *    `[gcode_macro CANCEL_PRINT]`). First header wins — a run appending
 *    several sections is labelled by the first one it introduces.
 * 2. Else, for a run whose removed lines carry a header, that dead
 *    header — the section was deleted.
 * 3. Else the nearest header at or above the run's first live line
 *    (frame lines when the run is a pure deletion at EOF). Falls back
 *    to the file name. One scan per call — stops are few.
 */
export function runSectionLabel(live: string | null, frame: string, run: ReviewRun): string {
  const headerRe = /^\s*\[([^\]]+)\]/;
  for (const line of run.added) {
    const m = line.match(headerRe);
    if (m) return `[${m[1]}]`;
  }
  for (const line of run.removed) {
    const m = line.match(headerRe);
    if (m) return `[${m[1]}]`;
  }
  const source = run.removed.length > 0 && run.liveEnd < run.liveStart ? frame : (live ?? frame);
  const lines = partLines(source);
  const at = Math.min(Math.max(run.liveStart - 1, 0), Math.max(lines.length - 1, 0));
  for (let i = at; i >= 0; i -= 1) {
    const m = lines[i]?.match(headerRe);
    if (m) return `[${m[1]}]`;
  }
  return '';
}
