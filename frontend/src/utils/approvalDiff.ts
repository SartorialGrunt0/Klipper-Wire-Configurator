import { createConfigPatch, parsePatch, type DiffLine } from './configDiff';

/** Cap for the in-card diff so a replace_section of a huge section can't
 *  flood the chat dialog. The DECISION is never affected — this only
 *  trims what is DISPLAYED (the full file is one expansion away later). */
export const APPROVAL_DIFF_MAX_LINES = 120;

/**
 * Mini-diff-LOOK lines for an approval card: computed SERVER-SIDE data
 * only (the prepared op's before/after text), never model prose. Same
 * createConfigPatch + parsePatch classification the DiffDialog uses, so
 * card colors mean exactly what the review diff colors mean.
 */
export function buildApprovalDiffLines(
  file: string,
  before: string,
  after: string,
  maxLines: number = APPROVAL_DIFF_MAX_LINES,
): DiffLine[] {
  const patch = createConfigPatch(file, before, after, 'before', 'after', 2);
  const lines = parsePatch(patch);
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  kept.push({
    type: 'context',
    content: `… ${lines.length - maxLines} more diff lines (approve to see the full result in the editor)`,
  });
  return kept;
}

/** Seconds remaining, clamped — display helper for the card countdown. */
export function remainingApprovalSeconds(
  serverRemaining: number,
  receivedAtMs: number,
  nowMs: number,
): number {
  const elapsed = Math.max(0, (nowMs - receivedAtMs) / 1000);
  return Math.max(0, Math.ceil(serverRemaining - elapsed));
}
