import { useEffect, useRef } from 'react';

import DiffLines from './DiffLines';
import type { PendingDiffModel } from '../utils/pendingDiff';

/**
 * The text view's pending-change surface.
 *
 * Two shapes over one model, so the pane and the card can never disagree about
 * which change is waiting:
 *
 *  - `PendingDiffPane` — the takeover. Renders the card's own rows (same
 *    builder, same renderer) instead of the buffer while an edit waits on
 *    approve/decline. Read-only, and deliberately WITHOUT Approve/Decline
 *    buttons: the card in the chat is the only decision surface, and a second
 *    one would be a second place to get the decision wrong.
 *  - `PendingDiffChip` — the header strip shown when the takeover was
 *    suppressed (the user is highlighting the very lines being changed) or
 *    declined ("Back to editing").
 *
 * The rows are a PROPOSAL, not the current file: `before`/`after` are as of the
 * moment the model asked. The header says so, because an approve can be
 * refused later ("config changed since this proposal") if the file moved on.
 */

function CountsBadge({ model }: { model: PendingDiffModel }) {
  return (
    <span className="shrink-0 text-[10px] font-mono tabular-nums text-[var(--color-text-secondary)]">
      <span className="text-green-400">+{model.added}</span>{' '}
      <span className="text-red-400">−{model.removed}</span>
    </span>
  );
}

function PendingHeader({ model, children }: { model: PendingDiffModel; children?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 px-3 py-1.5 border-b border-[var(--color-bg-tertiary)] bg-[var(--color-bg-secondary)]">
      <span className="shrink-0 text-[11px] font-semibold text-[var(--color-accent)]">
        Pending AI change
      </span>
      <span className="text-[10px] text-[var(--color-text-secondary)] truncate">
        {model.file} · {model.op}
      </span>
      <CountsBadge model={model} />
      <span className="ml-auto flex items-center gap-2 shrink-0">{children}</span>
    </div>
  );
}

const BUTTON_CLASS =
  'text-[10px] px-2 py-0.5 rounded border border-[var(--color-accent)]/40 '
  + 'text-[var(--color-accent)] hover:bg-[var(--color-accent)]/10 transition-colors';

interface PaneProps {
  model: PendingDiffModel;
  /** User asked to keep editing — the pane returns to the buffer. */
  onHide: () => void;
}

export default function PendingDiffPane({ model, onHide }: PaneProps) {
  const rowsRef = useRef<HTMLPreElement>(null);

  // Land on the change, not on the top of the hunk header. `firstChangedRow`
  // is an index into the rows we render, and the rows are in the same order
  // the card shows them.
  useEffect(() => {
    const container = rowsRef.current;
    if (!container || model.firstChangedRow < 0) return;
    const row = container.children[model.firstChangedRow] as HTMLElement | undefined;
    if (!row) return;
    const offset = row.offsetTop - container.clientHeight * 0.2;
    container.scrollTop = Math.max(0, offset);
  }, [model]);

  return (
    <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
      <PendingHeader model={model}>
        <span className="text-[10px] text-[var(--color-text-secondary)]">
          review & decide in the AI chat
        </span>
        <button onClick={onHide} className={BUTTON_CLASS}>
          Back to editing
        </button>
      </PendingHeader>
      <div className="flex-1 min-h-0 overflow-hidden bg-[var(--color-bg-primary)]">
        <DiffLines
          lines={model.lines}
          containerRef={rowsRef}
          className="h-full text-xs leading-relaxed overflow-auto py-2"
        />
      </div>
    </div>
  );
}

export function PendingDiffChip({ model, onShow }: { model: PendingDiffModel; onShow: () => void }) {
  return (
    <PendingHeader model={model}>
      <button onClick={onShow} className={BUTTON_CLASS}>
        Show diff
      </button>
    </PendingHeader>
  );
}
