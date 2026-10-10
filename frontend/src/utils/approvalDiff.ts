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
  context = 2,
): DiffLine[] {
  const patch = createConfigPatch(file, before, after, 'before', 'after', context);
  const lines = parsePatch(patch);
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  kept.push({
    type: 'context',
    content: `… ${lines.length - maxLines} more diff lines (approve to see the full result in the editor)`,
  });
  return kept;
}

/**
 * Seconds remaining, clamped — display helper for the card countdown.
 *
 * `serverRemaining` is the backend's "seconds remaining" as of
 * `receivedAtMs`, so the local elapsed time is only the sub-poll
 * interpolation BETWEEN polls: pair the value with the arrival time of the
 * SAME payload (see `foldApprovalCountdown`). A stale anchor subtracts the
 * window twice — the countdown reaches zero at roughly half the real
 * deadline while the backend timer and the Approve/Decline buttons are
 * still live.
 */
export function remainingApprovalSeconds(
  serverRemaining: number,
  receivedAtMs: number,
  nowMs: number,
): number {
  const elapsed = Math.max(0, (nowMs - receivedAtMs) / 1000);
  return Math.max(0, Math.ceil(serverRemaining - elapsed));
}

/** Countdown anchor for the approval card: the arrival time of the payload
 *  the backend's remainder came with (`ApprovalCard.timeoutSeconds`). */
export interface ApprovalCountdownAnchor {
  /** approvalId `receivedAtMs` belongs to (a new card restarts the window). */
  approvalId: string;
  /** Date.now() when the payload carrying the current remainder arrived. */
  receivedAtMs: number;
}

/**
 * Fold one approval poll into the countdown anchor.
 *
 * The card payload is REPLACED by the ~1s poll and its `timeoutSeconds` is
 * ALREADY the backend's seconds-remaining for that poll. So every accepted
 * payload re-anchors the countdown at its own arrival time: carrying an
 * anchor over from the first sighting of an approvalId would make the
 * backend's decrement and the local clock count the same seconds twice
 * (a 90s card would read 0 after ~45s while the backend timer and the
 * buttons were still live).
 *
 * While a decision POST is in flight (`busy`) the previous anchor is kept —
 * the poll neither refreshes the card nor the countdown under the user.
 */
export function foldApprovalCountdown(
  prev: ApprovalCountdownAnchor | null,
  poll: { approvalId: string; timeoutSeconds: number },
  nowMs: number,
  busy: boolean,
): ApprovalCountdownAnchor | null {
  if (busy) return prev;
  return { approvalId: poll.approvalId, receivedAtMs: nowMs };
}

/** Per-severity counts over the delta-validation findings attached to an
 *  approval card. The card's severity badges render from this — purely
 *  mechanical (counts over server findings), never from model prose. */
export interface AdvisorySeverityCounts {
  error: number;
  warning: number;
  other: number;
}

export function summarizeAdvisorySeverities(
  advisories: Array<{ severity?: string }>,
): AdvisorySeverityCounts {
  const counts: AdvisorySeverityCounts = { error: 0, warning: 0, other: 0 };
  for (const adv of advisories ?? []) {
    const sev = (adv?.severity || '').toLowerCase();
    if (sev === 'error') counts.error += 1;
    else if (sev === 'warning') counts.warning += 1;
    else counts.other += 1;
  }
  return counts;
}