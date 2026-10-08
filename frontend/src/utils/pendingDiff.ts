/**
 * The pending-change model behind the text view's diff takeover.
 *
 * When an edit waits on an approve/decline card, the text pane can show the
 * change instead of the buffer. This module owns everything about that, and it
 * is deliberately pure (no React, no store, no DOM) so the two things that can
 * silently rot are pinned by tests:
 *
 *  1. **Same rows as the card.** The rows come from `buildApprovalDiffLines` — the
 *     card's own builder — so the pane cannot drift into a lookalike. Same
 *     server data (`card.diff.before/after`), same classification, same order.
 *     Two deliberate differences (Cliff, 2026-10-02): the pane is uncapped where
 *     the card stops at `APPROVAL_DIFF_MAX_LINES`, and it diffs with the WHOLE
 *     FILE as context instead of the card's 2 lines — the pane is standing in
 *     for the buffer, so it shows all of it with the changed lines marked, not
 *     just the neighbourhood of the change.
 *  2. **Where the change lands.** The rows are diff rows; the editor's
 *     selection is in *file line numbers*. `changedLines` bridges the two, so
 *     the takeover rule can ask a real question ("is the user highlighting the
 *     lines we are about to change?") instead of guessing from focus.
 *
 * The pane is UNCAPPED where the card stops at `APPROVAL_DIFF_MAX_LINES`: the
 * cap exists to keep a chat bubble readable, not to withhold the diff.
 */
import type { ApprovalCard } from '../services/api';
import type { DiffLine } from './configDiff';
import type { ChatReference } from './chatReferences';
import { buildApprovalDiffLines } from './approvalDiff';
import { parsePatch } from './configDiff';
import type { ChangeSetRow } from './changeSet';
import { sectionLabel } from './changeSet';
import { diffLines } from 'diff';

export interface PendingDiffModel {
  /** Identity of the card this came from (stale-response guard). */
  approvalId: string;
  file: string;
  op: string;
  summary: string;
  /** The rows to render — identical to what the approval card renders. */
  lines: DiffLine[];
  added: number;
  removed: number;
  /** Index into `lines` of the first added/removed row; -1 when there is none. */
  firstChangedRow: number;
  /**
   * 1-based line numbers of the BEFORE file that the change touches (an
   * insertion reports the line it lands on). This is the editor's coordinate
   * space — see the caveat in `changedBeforeLines`.
   */
  changedLines: number[];
}

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/;

/**
 * Context for the pane's diff: the whole file. Large rather than Infinity so
 * `createPatch` compares numbers normally; one hunk then spans the document and
 * every unchanged line comes back as a context row.
 */
export const PANE_DIFF_CONTEXT = 1_000_000;

/**
 * Walk the diff rows and report the BEFORE-file line numbers the change touches.
 *
 * A removed row consumes a before-line; an added row does not (it is new text),
 * so it reports the line it lands on. Context rows advance the counter.
 *
 * Replacement runs share ONE position: an added row inside a run that already
 * removed lines lands where those lines were (the classic value change is
 * removed@4 + added@4, not 4 and 5). A pure insertion — no removals in the run
 * — lands at the line it is inserted before.
 *
 * Caveat, deliberately accepted: the card's builder diffs
 * `normalizeDiffText`-ed texts, which collapse *consecutive blank lines*. In a
 * file with doubled blank lines above a hunk the numbers can be off by the
 * collapsed count. The consequence is confined to this guard (which decides
 * chip-vs-takeover), never to the rendered rows, which are unaffected.
 */
export function changedBeforeLines(rows: DiffLine[]): number[] {
  const changed = new Set<number>();
  let before = 1;
  /** First before-line of the change run we are inside, if any. */
  let run: number | null = null;
  for (const row of rows) {
    if (row.type === 'header') {
      const m = row.content.match(HUNK_HEADER_RE);
      if (m) before = Number(m[1]);
      run = null;
      continue;
    }
    if (row.type === 'added') {
      changed.add(Math.max(1, run ?? before));
      continue;
    }
    if (row.type === 'removed') {
      if (run === null) run = before;
      changed.add(Math.max(1, before));
      before += 1;
      continue;
    }
    run = null;
    before += 1;
  }
  return [...changed].sort((a, b) => a - b);
}

/** Build the pane's view of a card, or null when there is nothing to show. */
export function buildPendingDiffModel(card: ApprovalCard | null): PendingDiffModel | null {
  const diff = card?.diff;
  if (!card || !diff) return null;
  const lines = buildApprovalDiffLines(
    diff.file, diff.before, diff.after, Number.POSITIVE_INFINITY, PANE_DIFF_CONTEXT,
  );
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.type === 'added') added += 1;
    else if (line.type === 'removed') removed += 1;
  }
  return {
    approvalId: card.approvalId,
    file: diff.file,
    op: card.op,
    summary: card.summary,
    lines,
    added,
    removed,
    firstChangedRow: lines.findIndex((l) => l.type === 'added' || l.type === 'removed'),
    changedLines: changedBeforeLines(lines),
  };
}

/**
 * The two halves of one file the pane diffs to draw the document.
 *
 * `before` is server truth — the file as it stood before the review's first
 * edit (shipped per file on the change-set payload). `after` is the text the
 * editor is holding right now: it is the buffer, so it is current by
 * construction, which is also what makes an UNDO show up here without a
 * round trip.
 */
export interface PendingFrame {
  before: string;
  after: string;
}

/**
 * The pane's view of the UNREVIEWED change set for one file.
 *
 * Same surface as `buildPendingDiffModel`, different source: the post-hoc
 * review's rows (each carrying its op's own unified diff) instead of an
 * approval card. That is what makes the pane behave identically whichever
 * chat made the edits — the top-bar AI Chat dialog and the docked text-view
 * panel both write into the same change set, so switching to the text view
 * shows the red and green lines either way (Sir, 2026-10-02).
 *
 * **With a frame, the pane renders the WHOLE DOCUMENT** — every unchanged
 * line as context, the changed ones marked — through the same uncapped,
 * whole-file-context builder the approval card path uses. That is the law
 * (Sir 2026-10-02, re-affirmed 2026-10-03 after the pane was repointed at
 * the change set and silently went back to showing a hunk window): standing
 * in for the buffer means showing all of it.
 *
 * Without a frame — a payload from a server that predates it — it falls back
 * to concatenating the rows' own compact unified diffs, which renders the
 * neighbourhood of each change rather than the document.
 *
 * `approvalId` is deliberately stable per file: deciding one edit must not
 * re-take the pane over after the user asked to keep editing.
 */
export function buildUnreviewedDiffModel(
  rows: readonly ChangeSetRow[],
  file: string,
  frame?: PendingFrame | null,
): PendingDiffModel | null {
  if (!file || rows.length === 0) return null;
  const labels: string[] = [];
  for (const row of rows) {
    const label = sectionLabel(row);
    if (!labels.includes(label)) labels.push(label);
  }
  const lines: DiffLine[] = frame
    ? buildApprovalDiffLines(
      file, frame.before, frame.after, Number.POSITIVE_INFINITY, PANE_DIFF_CONTEXT,
    )
    : rows.flatMap((row) => parsePatch(row.diffText));
  // Counted from the rows actually rendered, so the header's `+A −R` always
  // describes what is on screen.
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.type === 'added') added += 1;
    else if (line.type === 'removed') removed += 1;
  }
  return {
    approvalId: `changeset:${file}`,
    file,
    op: labels.join(', '),
    summary: `${rows.length} unreviewed change${rows.length === 1 ? '' : 's'}`,
    lines,
    added,
    removed,
    firstChangedRow: lines.findIndex((line) => line.type === 'added' || line.type === 'removed'),
    changedLines: changedBeforeLines(lines),
  };
}

/**
 * Does the user's highlight cover a line this change touches?
 *
 * A bare caret publishes no selection at all (`publishSelectionReference` nulls
 * the slot when `selectionStart === selectionEnd`), so this is false for a
 * click — which is the intended reading: *highlighting lines IS pointing at
 * them*, merely standing in the file is not.
 */
export function selectionOverlapsChange(
  model: PendingDiffModel,
  selection: ChatReference | null,
): boolean {
  if (!selection || selection.kind !== 'lines') return false;
  const { startLine, endLine } = selection;
  if (startLine == null || endLine == null) return false;
  const lo = Math.min(startLine, endLine);
  const hi = Math.max(startLine, endLine);
  return model.changedLines.some((line) => line >= lo && line <= hi);
}

/**
 * `auto`   — take over unless the user is pointing at the changed lines.
 * `shown`  — the user asked for the diff (chip click).
 * `hidden` — the user asked to keep editing (Back to editing).
 */
export type PaneTakeover = 'auto' | 'shown' | 'hidden';

/** What the pane renders right now. */
export type PendingPaneMode = 'editor' | 'review' | 'mirror' | 'diff' | 'chip';

/**
 * The takeover rule, in one place.
 *
 * Two gates, in this order:
 *  - **The text view must be the active view.** A card that lands while the
 *    user is in the graph view or the modal chat must not move anything; if
 *    they return to the text view while the card is still open, the diff shows
 *    then.
 *  - **A highlight over the changed lines wins.** Then we would be taking the
 *    pane out from under someone who is pointing at exactly those lines, so the
 *    header offers the chip instead.
 *
 * `review` is the Zed-model takeover (Sir, 2026-10-05): the review strip sits
 * above the NORMAL, still-editable editor, whose overlay carries the pending
 * tints — undecided changes never take the buffer out of edit mode.
 *
 * `live` says the pending rows are ALREADY IN the buffer — the post-hoc change
 * set (edits applied, awaiting keep/undo). Its source is the mechanical ledger
 * (`reviewEngine`), not a card model: `hasReview` says the ledger has runs.
 * `shown` on the live path now means the compact MIRROR (`mirror`) — only the
 * changed runs, mini-diff style — because the whole-document read-only takeover
 * (the card path's `diff`) no longer fits a review that keeps the buffer live
 * (Sir, 2026-10-07).
 *
 * `'hidden'` means nothing on the live path (2026-10-07): the fold-away it
 * came from was the card's, and on the live path the edit view IS the review
 * — the strip carries the decisions and the "Show diff" toggle, and it goes
 * away when the ledger is empty, not when the user folds. A stale `'hidden'`
 * from a declined card must not chip a live review into an uncolored buffer
 * with a lone "Show diff" (Sir's bug report: the chip's button doing nothing
 * useful, marks missing on return).
 *
 * The APPROVAL-CARD path — a proposal not yet applied, the buffer still showing
 * `before` — keeps the original rule verbatim: it cannot tint changes that are
 * not in the text, so the overlap check and the read-only `diff` takeover still
 * apply.
 */
export function paneModeFor(input: {
  model: PendingDiffModel | null;
  takeover: PaneTakeover;
  isActive: boolean;
  selection: ChatReference | null;
  /** The pending rows are applied to the live buffer (change-set path). */
  live?: boolean;
  /** The live path's review presence: the ledger has runs for this review. */
  hasReview?: boolean;
}): PendingPaneMode {
  const { model, takeover, isActive, selection, live, hasReview } = input;
  if (!isActive) return 'editor';
  if (live) {
    if (!model && !hasReview) return 'editor';
    if (takeover === 'shown') return 'mirror';
    return 'review';
  }
  if (!model) return 'editor';
  if (takeover === 'shown') return 'diff';
  if (takeover === 'hidden') return 'chip';
  return selectionOverlapsChange(model, selection) ? 'chip' : 'diff';
}


/**
 * The pending marks IN THE LIVE EDITOR'S OWN COORDINATES.
 *
 * The review mode keeps the buffer live and types into it (Zed's one-buffer
 * model): the frame law already says a pending change is `before` vs whatever
 * `textForFile` holds right now, and this exposes exactly that as line marks.
 * A hand edit INSIDE a pending region shifts the marks along with the text,
 * because the marks are recomputed from the frame against the live buffer
 * every time, never patched.
 *
 * - `addedLines`     — 1-based live lines that are new vs the frame. Tinted
 *   green by the overlay.
 * - `removedAnchors` — live line -> how many frame lines are gone above it.
 *   A removal has no line to own in the live text, and inventing a phantom
 *   row would shift the textarea's line rhythm — the drift bug (e482e63) in
 *   a new costume. So the deletion is ANCHORED to the live line it would
 *   return to, with its count, shown in the gutter, not in the text.
 *   A deletion at end-of-file anchors to the last live line (count added to
 *   whatever anchor it already has); an empty live text anchors to line 1.
 *
 * The anchor is the run's TOP line (`runStart`), not the next context
 * boundary. A replacement run carries both sides — the frame line gone and
 * the live line that replaced it — and anchoring at the boundary after the
 * added lines advanced the counter would paint the innocent line BELOW the
 * run red while the green line whose old text is actually gone stayed
 * unmarked (Sir's bug report, 2026-10-08). For a pure deletion nothing in
 * the run advances the live counter, so runStart is still exactly the line
 * the removal would return to — the law above is unchanged there, and the
 * mark now shares the coordinate of the run's strip stop / inline pair
 * (`ReviewRun.liveStart`) instead of a third, drifting one.
 *
 * Chunk values from `diffLines` carry their own trailing newlines: a chunk
 * contributes lines by counting its newlines, and its unterminated tail
 * (only possible at end of text) is one more line.
 */
export interface LivePendingMarks {
  addedLines: Set<number>;
  removedAnchors: Map<number, number>;
  /** anchor line -> the removed lines' text, for the hover on the red rule. */
  removedContents: Map<number, string[]>;
}

export function livePendingLines(before: string, live: string): LivePendingMarks {
  const addedLines = new Set<number>();
  const removedAnchors = new Map<number, number>();
  const removedContents = new Map<number, string[]>();
  if (before === live) return { addedLines, removedAnchors, removedContents };

  // 1-based number of the NEXT live line.
  let line = 1;
  let pendingRemovals = 0;
  let pendingText: string[] = [];
  // The live line the current change run STARTS at — the anchor its removals
  // flush to. Captured before either side of the run is consumed, so a
  // replacement anchors at its own (green) line, not the innocent line the
  // counter had advanced to by the time the next context part arrived.
  let runStart = 1;
  let inRun = false;
  const absorbRemoval = (value: string) => {
    const ls = value.split('\n');
    if (ls.length > 0 && ls[ls.length - 1] === '') ls.pop();
    pendingText.push(...ls);
  };
  const flushRemoval = (anchor: number) => {
    if (pendingRemovals === 0) return;
    removedAnchors.set(anchor, (removedAnchors.get(anchor) ?? 0) + pendingRemovals);
    removedContents.set(anchor, [...(removedContents.get(anchor) ?? []), ...pendingText]);
    pendingRemovals = 0;
    pendingText = [];
  };
  const countLines = (value: string): number => {
    if (value.length === 0) return 0;
    const newlines = value.split('\n').length - 1;
    return value.endsWith('\n') ? newlines : newlines + 1;
  };
  const openRun = () => {
    if (!inRun) {
      runStart = line;
      inRun = true;
    }
  };
  for (const part of diffLines(before, live)) {
    const n = countLines(part.value);
    if (n === 0) continue;
    if (part.added) {
      openRun();
      for (let i = 0; i < n; i += 1) addedLines.add(line + i);
      line += n;
    } else if (part.removed) {
      openRun();
      pendingRemovals += n;
      absorbRemoval(part.value);
    } else {
      flushRemoval(runStart);
      inRun = false;
      line += n;
    }
  }
  // Deletions with no following live line: clamp the anchor to the last line
  // (or 1 if the live text is empty) so the gutter still says "N lines are
  // gone here". A run that reaches EOF started past the text or at its tail;
  // min(runStart, last) keeps both readings on a real line.
  flushRemoval(Math.min(runStart, Math.max(1, line - 1)));
  return { addedLines, removedAnchors, removedContents };
}

/**
 * The LIVE editor line a row of the pane's model falls on.
 *
 * The model's rows run through the whole document (frame law), so every
 * context row and every ADDED row is a live line; a removed row is not in
 * the live text and claims none. Counting the rows before `row` that do own
 * one gives the 1-based live line for the stop — the strip's arrows can
 * then scroll the live editor to the change they name.
 */
export function liveLineForContentRow(lines: readonly DiffLine[], row: number): number {
  let live = 1;
  for (let i = 0; i < row && i < lines.length; i += 1) {
    const type = lines[i].type;
    if (type === 'context' || type === 'added') live += 1;
  }
  return live;
}

