import { useEffect, useMemo, useRef, useState } from 'react';

import DiffLines from './DiffLines';
import type { PendingDiffModel } from '../utils/pendingDiff';
import type { ChangeStop } from '../utils/pendingChanges';
import { stopIndexAfterChange } from '../utils/pendingChanges';

/**
 * The text view's pending-change surface.
 *
 * Two shapes over one model, so the pane and the card can never disagree about
 * which change is waiting:
 *
 *  - `PendingDiffPane` — the takeover. It renders the WHOLE file with the
 *    still-undecided changes marked (`buildUnreviewedDiffModel`), and its top
 *    strip reviews them: prev/next, `change 2 of 5 · [stepper_x] microsteps`,
 *    and Keep/Undo **for the change it is showing**. Whole-file and per-section
 *    decisions, and the `+N −M` totals, live in the chat's summary bar — this
 *    strip keeps one job.
 *  - `PendingDiffChip` — the header strip shown when the takeover was
 *    suppressed (the user is highlighting the very lines being changed) or
 *    declined ("Back to editing").
 *
 * The rows are a PROPOSAL, not current file text in the sense of "saved": the
 * frame is the document before the unreviewed changes, and undoing is a server
 * replay. Decisions go through `services/changeSetReview` — the same engine the
 * chat's footer bar calls. A global outcome (a stale anchor, a failed apply)
 * shows in `note`, the same string the chat shows, because it is one field.
 */

const BUTTON_CLASS =
  'text-[10px] px-2 py-0.5 rounded border border-[var(--color-accent)]/40 '
  + 'text-[var(--color-accent)] hover:bg-[var(--color-accent)]/10 transition-colors';

const KEEP_BUTTON_CLASS =
  'text-[10px] px-2.5 py-1 rounded bg-[var(--color-accent)] text-white '
  + 'transition-opacity hover:opacity-90 disabled:opacity-40';

const UNDO_BUTTON_CLASS =
  'text-[10px] px-2.5 py-1 rounded border border-[var(--color-bg-tertiary)] '
  + 'text-[var(--color-text-secondary)] transition-colors hover:border-[var(--color-error)] '
  + 'hover:text-[var(--color-error)] disabled:opacity-40';

const NAV_BUTTON_CLASS =
  'text-[10px] w-5 h-5 rounded border border-[var(--color-bg-tertiary)] '
  + 'text-[var(--color-text-secondary)] transition-colors hover:border-[var(--color-accent)] '
  + 'hover:text-[var(--color-accent)] disabled:opacity-30 disabled:hover:border-[var(--color-bg-tertiary)]';

/** Per-change pair, anchored in the diff. Small, but never taller than a row. */
const ROW_KEEP_CLASS =
  'text-[10px] px-1.5 rounded bg-[var(--color-accent)] text-white hover:opacity-90 disabled:opacity-40';

const ROW_UNDO_CLASS =
  'text-[10px] px-1.5 rounded border border-[var(--color-bg-tertiary)] '
  + 'text-[var(--color-text-secondary)] hover:border-[var(--color-error)] '
  + 'hover:text-[var(--color-error)] disabled:opacity-40';

export interface PendingDiffPaneProps {
  model: PendingDiffModel;
  /** Where the changes are, in reading order. */
  stops: ChangeStop[];
  busy: boolean;
  note: string | null;
  /** Keep / undo the change currently shown. */
  onKeepEdits: (file: string, ids: string[]) => void;
  onUndoEdits: (file: string, ids: string[]) => void;
  /** User asked to keep editing — the pane returns to the buffer. */
  onHide: () => void;
}

export default function PendingDiffPane({
  model, stops, busy, note, onKeepEdits, onUndoEdits, onHide,
}: PendingDiffPaneProps) {
  const rowsRef = useRef<HTMLPreElement>(null);
  const [index, setIndex] = useState(0);
  // Where the cursor was, so a decision doesn't throw the reader back to the
  // top of the file: after a keep/undo the marks move and the cursor lands on
  // the next change at or below the one just decided.
  const lastLineStart = useRef<number | null>(null);
  const stop = stops[index];
  const current = stop?.label ? `change ${index + 1} of ${stops.length} · ${stop.label}`
    : `change ${index + 1} of ${stops.length}`;

  const scrollToStop = (stopIndex: number) => {
    const container = rowsRef.current;
    const target = stops[stopIndex];
    if (!container || !target) return;
    lastLineStart.current = target.lineStart;
    const row = container.children[target.row] as HTMLElement | undefined;
    if (!row) return;
    container.scrollTop = Math.max(0, row.offsetTop - container.clientHeight * 0.2);
  };

  // Land on the first change when the model arrives, and stay in place across
  // decisions (the model is rebuilt every time the marks move).
  useEffect(() => {
    const next = lastLineStart.current === null
      ? 0
      : stopIndexAfterChange(stops, lastLineStart.current);
    setIndex(next);
    const container = rowsRef.current;
    if (!container) return;
    const target = stops[next] ?? stops[0];
    const row = container.children[target ? target.row : model.firstChangedRow] as HTMLElement | undefined;
    if (!row) return;
    container.scrollTop = Math.max(0, row.offsetTop - container.clientHeight * 0.2);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, stops]);

  const ids = stop?.ids ?? [];

  // One Keep/Undo pair per change, anchored at the change's FIRST row, so the
  // decision is next to the edit it acts on instead of only up in the strip.
  // Both exist on purpose: the strip is where the reader is walking through the
  // file, the row is where the reader has stopped.
  const actionsByRow = useMemo(() => {
    const map = new Map<number, React.ReactNode>();
    stops.forEach((entry, stopIndex) => {
      if (entry.ids.length === 0) return;
      const currentStop = stopIndex === index;
      map.set(entry.row, (
        <span className="flex items-center gap-1 rounded bg-[var(--color-bg-primary)]/85 pl-1">
          <button
            type="button"
            className={ROW_UNDO_CLASS}
            disabled={busy}
            onClick={() => onUndoEdits(model.file, entry.ids)}
            title="Drop this change"
          >
            Undo
          </button>
          <button
            type="button"
            className={ROW_KEEP_CLASS}
            disabled={busy}
            onClick={() => onKeepEdits(model.file, entry.ids)}
            title="Keep this change"
          >
            Keep
          </button>
          {currentStop && (
            <span className="w-1 self-stretch rounded-full bg-[var(--color-accent)]/60" aria-hidden />
          )}
        </span>
      ));
    });
    return map;
  }, [stops, index, busy, model.file, onKeepEdits, onUndoEdits]);

  return (
    <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-1 border-b border-[var(--color-bg-tertiary)] bg-[var(--color-bg-secondary)]">
        <button
          type="button"
          className={NAV_BUTTON_CLASS}
          onClick={() => { const next = Math.max(0, index - 1); setIndex(next); scrollToStop(next); }}
          disabled={index <= 0}
          title="Previous change"
        >
          ↑
        </button>
        <button
          type="button"
          className={NAV_BUTTON_CLASS}
          onClick={() => { const next = Math.min(stops.length - 1, index + 1); setIndex(next); scrollToStop(next); }}
          disabled={index >= stops.length - 1}
          title="Next change"
        >
          ↓
        </button>
        <span className="text-[10px] text-[var(--color-text-secondary)] truncate">
          {stops.length === 0 ? 'no unreviewed change in this file' : current}
        </span>
        <span className="ml-auto flex items-center gap-2 shrink-0">
          <button type="button" onClick={onHide} className={BUTTON_CLASS}>
            Back to editing
          </button>
          <button
            type="button"
            className={UNDO_BUTTON_CLASS}
            disabled={busy || ids.length === 0}
            onClick={() => onUndoEdits(model.file, ids)}
            title="Drop this change"
          >
            Undo
          </button>
          <button
            type="button"
            className={KEEP_BUTTON_CLASS}
            disabled={busy || ids.length === 0}
            onClick={() => onKeepEdits(model.file, ids)}
            title="Keep this change"
          >
            Keep
          </button>
        </span>
      </div>

      {note && (
        <p className="px-3 py-1 text-[10px] text-[var(--color-warning)] bg-[var(--color-bg-secondary)]">
          {note}
        </p>
      )}

      <div className="flex-1 min-h-0 overflow-hidden bg-[var(--color-bg-primary)]">
        <DiffLines
          lines={model.lines}
          containerRef={rowsRef}
          rowExtras={(rowIndex) => actionsByRow.get(rowIndex) ?? null}
          className="h-full text-xs leading-relaxed overflow-auto py-2"
        />
      </div>
    </div>
  );
}

export function PendingDiffChip({ model, onShow }: { model: PendingDiffModel; onShow: () => void }) {
  return (
    <div className="flex items-center gap-2 px-3 py-1.5 border-b border-[var(--color-bg-tertiary)] bg-[var(--color-bg-secondary)]">
      <span className="shrink-0 text-[11px] font-semibold text-[var(--color-accent)]">
        Pending AI change
      </span>
      <span className="text-[10px] text-[var(--color-text-secondary)] truncate">
        {model.file} · {model.op}
      </span>
      <span className="ml-auto shrink-0">
        <button onClick={onShow} className={BUTTON_CLASS}>
          Show diff
        </button>
      </span>
    </div>
  );
}
