import { useEffect, useMemo, useRef, useState } from 'react';

import DiffLines from './DiffLines';
import EditDecisionPair from './EditDecisionPair';
import type { PendingDiffModel } from '../utils/pendingDiff';
import { stopIndexForAnchor, type PendingStop } from '../utils/pendingChanges';

/**
 * The text view's pending-change surface.
 *
 * Two shapes over one model, so the pane and the card can never disagree about
 * which change is waiting:
 *
 *  - `PendingDiffPane` — the takeover. It renders the WHOLE document with the
 *    still-undecided changes marked (`buildUnreviewedDiffModel`), and its top
 *    strip reviews them: prev/next, `change 2 of 5 · printer.cfg ·
 *    [stepper_x] microsteps`, and Keep/Undo **for the change it is showing**.
 *    Whole-file and per-section decisions, and the `+N −M` totals, live in the
 *    chat's summary bar — this strip keeps one job.
 *
 *    The count and the arrows span EVERY file in the review (Sir, 2026-10-04),
 *    so the arrows cross files: moving to a change that lives elsewhere asks
 *    the text view to switch to that file, and the strip names the file it is
 *    about to show.
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

const NAV_BUTTON_CLASS =
  'text-[10px] w-5 h-5 rounded border border-[var(--color-bg-tertiary)] '
  + 'text-[var(--color-text-secondary)] transition-colors hover:border-[var(--color-accent)] '
  + 'hover:text-[var(--color-accent)] disabled:opacity-30 disabled:hover:border-[var(--color-bg-tertiary)]';

/**
 * The frame the per-change pair sits in, in the diff row: a rectangular box
 * with a rim and a FILLED background (Sir, 2026-10-04) — the floating
 * treatment, in the app's standard shape. The fill is what keeps the green/red
 * band from showing through the gap between the two verbs and reading as a
 * notch cut out of the band; the rim and shadow make it a surface on top of
 * it. The verbs themselves are `EditDecisionPair` — never a local copy.
 */
const ROW_PAIR_CLASS =
  'flex items-center rounded border border-[var(--color-bg-tertiary)] '
  + 'bg-[var(--color-bg-secondary)] p-0.5 shadow-lg';

export interface PendingDiffPaneProps {
  model: PendingDiffModel;
  /**
   * Every undecided change in the review, across EVERY file, in walk order.
   * The one the cursor names may live in another file — see `onOpenFile`.
   */
  stops: PendingStop[];
  busy: boolean;
  note: string | null;
  /** Keep / undo the change currently shown. */
  onKeepEdits: (file: string, ids: string[]) => void;
  onUndoEdits: (file: string, ids: string[]) => void;
  /**
   * The change the arrow moved to lives in another file, so the text view has
   * to show it: the cursor's file and the rendered document must agree.
   */
  onOpenFile: (file: string) => void;
  /** User asked to keep editing — the pane returns to the buffer. */
  onHide: () => void;
}

export default function PendingDiffPane({
  model, stops, busy, note, onKeepEdits, onUndoEdits, onOpenFile, onHide,
}: PendingDiffPaneProps) {
  const rowsRef = useRef<HTMLPreElement>(null);
  // The cursor is an index into the WHOLE review, not into this file. It opens
  // on this file's first change — the review never opens pointing at a change
  // the reader cannot see.
  const firstHere = stops.findIndex((entry) => entry.file === model.file);
  const [index, setIndex] = useState(() => (firstHere >= 0 ? firstHere : 0));
  // The change the cursor is on, by IDENTITY: ids survive a rebuild of the
  // list, so a decision made elsewhere cannot drag the reader off this change.
  const anchorIds = useRef<string[]>([]);
  const stop = stops[index];
  const ids = stop?.ids ?? [];
  const where = stop ? (stop.label ? `${stop.file} · ${stop.label}` : stop.file) : '';
  const current = `change ${index + 1} of ${stops.length}${where ? ` · ${where}` : ''}`;

  /** Move the cursor, and record what it landed on. */
  const land = (next: number) => {
    setIndex(next);
    anchorIds.current = stops[next]?.ids ?? [];
  };

  // The review moved under the cursor (a decision, a fresh request): stay on
  // the change the reader was on, else take whatever replaced it.
  useEffect(() => {
    if (stops.length === 0) return;
    setIndex((currentIndex) => {
      const next = stopIndexForAnchor(stops, anchorIds.current, currentIndex);
      return next < 0 ? 0 : next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stops]);

  // The editor is showing a different file (the tree, a jump, the strip's own
  // request): the cursor belongs to the file on screen.
  useEffect(() => {
    if (firstHere < 0) return;
    if (stops[index]?.file === model.file) return;
    land(firstHere);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model.file, stops, firstHere, index]);

  // Keep the change on screen. Scrolling waits for the cursor's file to BE the
  // rendered document, which is why a cross-file move renders first and scrolls
  // on the render after the switch.
  useEffect(() => {
    const container = rowsRef.current;
    const target = stops[index];
    if (!container || !target || target.file !== model.file) return;
    const row = container.children[target.row] as HTMLElement | undefined;
    if (!row) return;
    anchorIds.current = target.ids;
    container.scrollTop = Math.max(0, row.offsetTop - container.clientHeight * 0.2);
  }, [index, stops, model]);

  /** The arrows: one step through the whole review, switching files if need be. */
  const stepTo = (next: number) => {
    const target = stops[next];
    if (!target) return;
    land(next);
    if (target.file !== model.file) onOpenFile(target.file);
  };

  // One Keep/Undo pair per change, anchored at the change's FIRST row, so the
  // decision is next to the edit it acts on instead of only up in the strip.
  // Both exist on purpose: the strip is where the reader is walking through the
  // review, the row is where the reader has stopped. Only the rendered file's
  // stops have rows here — a row index means nothing in another document.
  const actionsByRow = useMemo(() => {
    const map = new Map<number, React.ReactNode>();
    stops.forEach((entry, stopIndex) => {
      if (entry.file !== model.file || entry.ids.length === 0) return;
      const currentStop = stopIndex === index;
      map.set(entry.row, (
        <span className={ROW_PAIR_CLASS}>
          <EditDecisionPair
            busy={busy}
            onUndo={() => onUndoEdits(entry.file, entry.ids)}
            onKeep={() => onKeepEdits(entry.file, entry.ids)}
          >
            {currentStop && (
              <span className="w-1 self-stretch rounded-full bg-[var(--color-accent)]/60" aria-hidden />
            )}
          </EditDecisionPair>
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
          onClick={() => stepTo(Math.max(0, index - 1))}
          disabled={index <= 0}
          title="Previous change"
        >
          ↑
        </button>
        <button
          type="button"
          className={NAV_BUTTON_CLASS}
          onClick={() => stepTo(Math.min(stops.length - 1, index + 1))}
          disabled={index >= stops.length - 1}
          title="Next change"
        >
          ↓
        </button>
        <span className="text-[10px] text-[var(--color-text-secondary)] truncate">
          {stops.length === 0 ? 'no unreviewed change' : current}
        </span>
        <span className="ml-auto flex items-center gap-2 shrink-0">
          <button type="button" onClick={onHide} className={BUTTON_CLASS}>
            Back to editing
          </button>
          <EditDecisionPair
            busy={busy}
            disabled={ids.length === 0}
            size="md"
            onUndo={() => onUndoEdits(stop?.file ?? model.file, ids)}
            onKeep={() => onKeepEdits(stop?.file ?? model.file, ids)}
          />
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
