/**
 * The ONE Keep/Undo pair.
 *
 * Every surface that decides a change renders this component: the chat's
 * per-file and per-section rows, the text view's per-change row pair, and the
 * review pane's header strip. Sir's rule (2026-10-04) is that a keep/undo pair
 * looks the same everywhere it appears, so a second copy of these classes is
 * how two surfaces start to disagree about what "Keep" looks like.
 *
 * Keep is the accent blue everywhere — the same blue as "Keep all", because
 * keeping is the affirmative action wherever it appears. Undo is a bordered
 * ghost that turns red on hover.
 *
 * Two sizes, because the strip is the surface's PRIMARY action while a row
 * pair is a per-item one: `sm` matches the chat's file/section rows, `md` the
 * pane's header. They are the same design at two weights, not two designs.
 *
 * `children` renders INSIDE the pair, after Keep — the pane uses it for the
 * "this is the change the arrows are on" mark.
 */
import type React from 'react';

export type DecisionSize = 'sm' | 'md';

/**
 * Both verbs are the SAME BOX: `inline-flex` + centred label, and the same 1px
 * border on each (Keep's is transparent). Without that they are 2px apart in
 * height and the pair looks misaligned — Sir, 2026-10-04: "make sure keep and
 * undo are centered in their box".
 */
const UNDO_CLASS: Record<DecisionSize, string> = {
  sm: 'inline-flex items-center justify-center rounded border border-[var(--color-bg-tertiary)] '
    + 'px-1.5 py-0.5 text-[9px] font-medium text-[var(--color-text-secondary)] '
    + 'transition-colors hover:border-[var(--color-error)] hover:text-[var(--color-error)] '
    + 'disabled:opacity-40',
  md: 'inline-flex items-center justify-center rounded border border-[var(--color-bg-tertiary)] '
    + 'px-2.5 py-1 text-[10px] text-[var(--color-text-secondary)] transition-colors '
    + 'hover:border-[var(--color-error)] hover:text-[var(--color-error)] disabled:opacity-40',
};

const KEEP_CLASS: Record<DecisionSize, string> = {
  sm: 'inline-flex items-center justify-center rounded border border-transparent '
    + 'bg-[var(--color-accent)] px-1.5 py-0.5 text-[9px] font-medium text-white '
    + 'transition-opacity hover:opacity-90 disabled:opacity-40',
  md: 'inline-flex items-center justify-center rounded border border-transparent '
    + 'bg-[var(--color-accent)] px-2.5 py-1 text-[10px] text-white '
    + 'transition-opacity hover:opacity-90 disabled:opacity-40',
};

export interface EditDecisionPairProps {
  /** A resolve request is in flight — neither verb is re-clickable. */
  busy: boolean;
  onKeep: () => void;
  onUndo: () => void;
  keepLabel?: string;
  undoLabel?: string;
  keepTitle?: string;
  undoTitle?: string;
  /** Extra reason to disable BOTH verbs (the pane: nothing is selected). */
  disabled?: boolean;
  size?: DecisionSize;
  /** Rendered after Keep, inside the pair. */
  children?: React.ReactNode;
}

export default function EditDecisionPair({
  busy,
  onKeep,
  onUndo,
  keepLabel = 'Keep',
  undoLabel = 'Undo',
  keepTitle = 'Keep this change',
  undoTitle = 'Drop this change',
  disabled = false,
  size = 'sm',
  children,
}: EditDecisionPairProps) {
  const off = busy || disabled;
  return (
    <span className="flex shrink-0 items-center gap-1">
      <button
        type="button"
        onClick={onUndo}
        disabled={off}
        className={UNDO_CLASS[size]}
        title={undoTitle}
      >
        {undoLabel}
      </button>
      <button
        type="button"
        onClick={onKeep}
        disabled={off}
        className={KEEP_CLASS[size]}
        title={keepTitle}
      >
        {keepLabel}
      </button>
      {children}
    </span>
  );
}
