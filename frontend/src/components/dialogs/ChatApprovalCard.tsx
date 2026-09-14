import { useMemo } from 'react';
import type { ApprovalCard } from '../../services/api';
import { buildApprovalDiffLines, remainingApprovalSeconds } from '../../utils/approvalDiff';

interface Props {
  card: ApprovalCard;
  /** performance.now()-style ms when THIS card payload arrived (the
   *  countdown degrades gracefully between polls). */
  receivedAtMs: number;
  /** ms timestamp driving countdown re-renders. */
  nowMs: number;
  /** Whether a decision request is in flight (buttons disabled). */
  busy: boolean;
  /** Shown when the backend refused an approve ('invalidated'). */
  invalidation: string | null;
  onApprove: () => void;
  onDecline: () => void;
}

/**
 * In-chat approval card for a validated tool-mediated edit (Phase 2).
 * The diff is computed from the server-prepared before/after text via
 * configDiff (same classification as DiffDialog), NOT from model prose —
 * card and applied result cannot diverge. Auto-declines at the timeout
 * the backend reports; the countdown is display-only (the backend timer
 * is the authority).
 */
export default function ChatApprovalCard({
  card, receivedAtMs, nowMs, busy, invalidation, onApprove, onDecline,
}: Props) {
  const diffLines = useMemo(
    () => (card.diff
      ? buildApprovalDiffLines(card.diff.file, card.diff.before, card.diff.after)
      : []),
    [card],
  );
  const seconds = remainingApprovalSeconds(card.timeoutSeconds, receivedAtMs, nowMs);
  const expiringSoon = seconds <= 10;

  return (
    <div className="rounded-lg border border-[var(--color-accent)]/40 bg-[var(--color-bg-secondary)] px-3 py-2.5 mb-2">
      <div className="flex items-center gap-2 mb-1.5">
        <span className="text-[11px] font-semibold text-[var(--color-accent)]">
          Approve config change?
        </span>
        <span className="text-[10px] text-[var(--color-text-secondary)] truncate">
          {card.file} · {card.op}
        </span>
        <span
          className={`ml-auto shrink-0 text-[10px] font-mono tabular-nums ${
            expiringSoon ? 'text-[var(--color-error)]' : 'text-[var(--color-text-secondary)]'
          }`}
          title="Auto-declines when this reaches zero"
        >
          {seconds}s
        </span>
      </div>

      <p className="text-xs text-[var(--color-text-primary)] mb-1.5">{card.summary}</p>

      {card.advisories.length > 0 && (
        <ul className="mb-1.5 space-y-0.5">
          {card.advisories.slice(0, 4).map((adv, i) => (
            <li key={i} className="text-[10px] text-yellow-500/90">
              ⚠ {adv.section ? `[${adv.section}] ` : ''}{adv.message}
            </li>
          ))}
        </ul>
      )}

      {diffLines.length > 0 && (
        <div className="rounded-md border border-[var(--color-bg-tertiary)] overflow-hidden mb-2">
          <pre className="text-[10px] leading-4 font-mono overflow-x-auto max-h-44 overflow-y-auto">
            {diffLines.map((line, i) => (
              <div
                key={i}
                className={
                  line.type === 'added'
                    ? 'w-max min-w-full bg-green-500/15 text-green-400 px-2'
                    : line.type === 'removed'
                      ? 'w-max min-w-full bg-red-500/15 text-red-400 px-2'
                      : line.type === 'header'
                        ? 'w-max min-w-full bg-blue-500/10 text-blue-400 px-2'
                        : 'w-max min-w-full text-[var(--color-text-secondary)] px-2'
                }
              >
                <span className="select-none opacity-50 mr-1.5">
                  {line.type === 'added' ? '+' : line.type === 'removed' ? '-' : ' '}
                </span>
                {line.content || '\u00A0'}
              </div>
            ))}
          </pre>
        </div>
      )}

      {invalidation && (
        <p className="text-[10px] text-[var(--color-error)] mb-1.5">
          {invalidation}
        </p>
      )}

      <div className="flex items-center gap-2">
        <button
          onClick={onApprove}
          disabled={busy}
          className="px-3 py-1 rounded text-[11px] font-medium bg-green-500/20 text-green-400 hover:bg-green-500/30 transition-colors disabled:opacity-50"
        >
          Approve
        </button>
        <button
          onClick={onDecline}
          disabled={busy}
          className="px-3 py-1 rounded text-[11px] font-medium bg-red-500/20 text-red-400 hover:bg-red-500/30 transition-colors disabled:opacity-50"
        >
          Decline
        </button>
        <span className="ml-auto text-[10px] text-[var(--color-text-secondary)]">
          staged, not saved
        </span>
      </div>
    </div>
  );
}
