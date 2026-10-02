/**
 * The pending-change model behind the text view's diff takeover.
 *
 * When an edit waits on an approve/decline card, the text pane can show the
 * change instead of the buffer. This module owns everything about that, and it
 * is deliberately pure (no React, no store, no DOM) so the two things that can
 * silently rot are pinned by tests:
 *
 *  1. **1:1 with the card.** The rows come from `buildApprovalDiffLines` — the
 *     card's own builder — so the pane cannot drift into a lookalike. Same
 *     server data (`card.diff.before/after`), same classification, same order.
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
    diff.file, diff.before, diff.after, Number.POSITIVE_INFINITY,
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
export type PendingPaneMode = 'editor' | 'diff' | 'chip';

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
 */
export function paneModeFor(input: {
  model: PendingDiffModel | null;
  takeover: PaneTakeover;
  isActive: boolean;
  selection: ChatReference | null;
}): PendingPaneMode {
  const { model, takeover, isActive, selection } = input;
  if (!model || !isActive) return 'editor';
  if (takeover === 'shown') return 'diff';
  if (takeover === 'hidden') return 'chip';
  return selectionOverlapsChange(model, selection) ? 'chip' : 'diff';
}
