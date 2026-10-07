import { useEffect, useMemo, useRef, useState } from 'react';

import DiffLines from './DiffLines';
import EditDecisionPair from './EditDecisionPair';
import type { PendingDiffModel } from '../utils/pendingDiff';
import { documentLineNumbers } from '../utils/configDiff';
import { stopIndexForAnchor } from '../utils/pendingChanges';
import type { ReviewStop } from '../services/reviewEngine';

/**
 * The text view's review surfaces.
 *
 *  - `PendingReviewStrip` — the review cursor: prev/next, `change 2 of 5 ·
 *    printer.cfg · [stepper_x]`, and Keep/Undo **for the run it is showing**.
 *    It is chrome, so it sits above the live editor (the Zed-model takeover,
 *    Sir 2026-10-05) where the pending tints paint the buffer in place. The
 *    stops are the mechanical ledger's RUNS now (Sir, 2026-10-07): the cursor
 *    is keyed on a run's `key`, and reveal is a scroll-only to its live line.
 *    Whole-file/per-run decisions and the `+N −M` totals also live in the
 *    chat's summary bar — this strip keeps one job.
 *  - `PendingDiffPane` — the read-only whole-document takeover for the APPROVAL
 *    CARD path (a proposal not yet in the buffer). It keeps the existing
 *    behaviour; the live change-set path uses the compact `ReviewMirrorPane`
 *    instead.
 *  - `PendingDiffChip` — the header strip shown when the takeover was
 *    suppressed (the user is highlighting the very lines being changed) or
 *    declined ("Back to editing").
 *
 * Decisions go through `services/reviewEngine` — the same engine the chat's
 * footer bar calls.
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

export interface PendingReviewStripProps {
  /**
   * Every undecided run in the review, across EVERY file, in walk order. The
   * one the cursor names may live in another file — see `onOpenFile`.
   */
  stops: ReviewStop[];
  /** The file rendered right now; the cursor opens on its first run. */
  activeFile: string;
  /** Keep / undo the run currently shown. */
  onKeepRun: (file: string, key: string) => void;
  onUndoRun: (file: string, key: string) => void;
  /**
   * The run the arrow moved to lives in another file, so the text view has to
   * show it: the cursor's file and the rendered document must agree.
   */
  onOpenFile: (file: string) => void;
  /** Fold the strip away (Back to editing). */
  onHide: () => void;
  /**
   * The cursor moved (or the review re-pointed it): reveal the run. The live
   * editor scrolls to the run's LIVE line. `revealedByCursor` is false for the
   * opening reveal of a freshly mounted strip — a surface that just appeared
   * should not yank the reader's scroll.
   */
  onRevealStop?: (stop: ReviewStop, revealedByCursor: boolean) => void;
}

/**
 * The review cursor — one instance per surface, the same walk across every
 * file. State lives here: the cursor index and the run key it was anchored to,
 * so a decision made elsewhere cannot drag the reader off this run.
 */
export function PendingReviewStrip({
  stops, activeFile, onKeepRun, onUndoRun, onOpenFile, onHide, onRevealStop,
}: PendingReviewStripProps) {
  // The cursor is an index into the WHOLE review, not into this file. It opens
  // on this file's first run — the review never opens pointing at a run the
  // reader cannot see.
  const firstHere = stops.findIndex((entry) => entry.file === activeFile);
  const [index, setIndex] = useState(() => (firstHere >= 0 ? firstHere : 0));
  // The run the cursor is on, by IDENTITY: a run's key survives a rebuild of
  // the list, so a decision made elsewhere cannot drag the reader off it.
  const anchorKeys = useRef<string[]>([]);
  const stop = stops[index];
  const key = stop?.key ?? '';
  const where = stop ? (stop.label ? `${stop.file} · ${stop.label}` : stop.file) : '';
  const current = `change ${index + 1} of ${stops.length}${where ? ` · ${where}` : ''}`;
  // True once the USER has moved the cursor (an arrow). Until then the surface
  // should not yank the reader's scroll: a freshly-appeared review opens where
  // the editor already is.
  const movedRef = useRef(false);
  // `stopIndexForAnchor` matches on identity; a run's identity is its key.
  const idStops = useMemo(() => stops.map((entry) => ({ ids: [entry.key] })), [stops]);

  /** Move the cursor, and record what it landed on. */
  const land = (next: number) => {
    setIndex(next);
    anchorKeys.current = stops[next] ? [stops[next].key] : [];
  };

  // The review moved under the cursor (a decision, a fresh request): stay on
  // the run the reader was on, else take whatever replaced it.
  useEffect(() => {
    if (stops.length === 0) return;
    setIndex((currentIndex) => {
      const next = stopIndexForAnchor(idStops, anchorKeys.current, currentIndex);
      return next < 0 ? 0 : next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stops]);

  // The editor is showing a different file (the tree, a jump, the strip's own
  // request): the cursor belongs to the file on screen.
  useEffect(() => {
    if (firstHere < 0) return;
    if (stops[index]?.file === activeFile) return;
    land(firstHere);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeFile, stops, firstHere, index]);

  // Reveal the run the cursor is on. A cross-file move renders the other
  // document first, so this runs on the render AFTER the switch lands.
  useEffect(() => {
    const target = stops[index];
    if (!target || target.file !== activeFile) return;
    anchorKeys.current = [target.key];
    onRevealStop?.(target, movedRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, stops, activeFile]);

  /** The arrows: one step through the whole review, switching files if need be. */
  const stepTo = (next: number) => {
    const target = stops[next];
    if (!target) return;
    movedRef.current = true;
    land(next);
    if (target.file !== activeFile) onOpenFile(target.file);
  };

  return (
    <>
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
            busy={false}
            disabled={!stop}
            size="md"
            onUndo={() => { if (stop) onUndoRun(stop.file, stop.key); }}
            onKeep={() => { if (stop) onKeepRun(stop.file, stop.key); }}
          />
        </span>
      </div>
    </>
  );
}

export interface PendingDiffPaneProps {
  model: PendingDiffModel;
  stops: ReviewStop[];
  /** Keep / undo the run currently shown. */
  onKeepRun: (file: string, key: string) => void;
  onUndoRun: (file: string, key: string) => void;
  onOpenFile: (file: string) => void;
  /** User asked to keep editing — the pane returns to the buffer. */
  onHide: () => void;
}

/** The read-only takeover: strip + whole-document diff + per-run pairs. */
export default function PendingDiffPane({
  model, stops, onKeepRun, onUndoRun, onOpenFile, onHide,
}: PendingDiffPaneProps) {
  const rowsRef = useRef<HTMLPreElement>(null);
  // The live line each rendered row claims; a removed row claims none. Built
  // once per model so a stop's live line finds its row.
  const rowForLine = useMemo(() => {
    const numbers = documentLineNumbers(model.lines);
    const map = new Map<number, number>();
    numbers.forEach((line, row) => {
      if (line != null && !map.has(line)) map.set(line, row);
    });
    return map;
  }, [model.lines]);

  /** The strip's cursor: scroll the rendered rows to its stop. */
  const revealStop = (stop: ReviewStop) => {
    const container = rowsRef.current;
    if (!container) return;
    const rowIndex = rowForLine.get(stop.line);
    if (rowIndex == null) return;
    const row = container.children[rowIndex] as HTMLElement | undefined;
    if (!row) return;
    container.scrollTop = Math.max(0, row.offsetTop - container.clientHeight * 0.2);
  };

  // One Keep/Undo pair per run, anchored at the run's first live row. Only the
  // rendered file's runs have rows here — a line number means nothing in
  // another document.
  const actionsByRow = useMemo(() => {
    const map = new Map<number, React.ReactNode>();
    for (const entry of stops) {
      if (entry.file !== model.file) continue;
      const rowIndex = rowForLine.get(entry.line);
      if (rowIndex == null) continue;
      map.set(rowIndex, (
        <span className={ROW_PAIR_CLASS}>
          <EditDecisionPair
            busy={false}
            onUndo={() => onUndoRun(entry.file, entry.key)}
            onKeep={() => onKeepRun(entry.file, entry.key)}
          />
        </span>
      ));
    }
    return map;
  }, [stops, model.file, rowForLine, onKeepRun, onUndoRun]);

  return (
    <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
      <PendingReviewStrip
        stops={stops}
        activeFile={model.file}
        onKeepRun={onKeepRun}
        onUndoRun={onUndoRun}
        onOpenFile={onOpenFile}
        onHide={onHide}
        onRevealStop={(stop) => revealStop(stop)}
      />

      <div className="flex-1 min-h-0 overflow-hidden bg-[var(--color-bg-primary)]">
        <DiffLines
          lines={model.lines}
          containerRef={rowsRef}
          lineNumbers
          rowExtras={(rowIndex) => actionsByRow.get(rowIndex) ?? null}
          className="h-full text-xs leading-relaxed overflow-auto py-2"
        />
      </div>
    </div>
  );
}

export function PendingDiffChip({ file, label, onShow }: { file: string; label: string; onShow: () => void }) {
  return (
    <div className="flex items-center gap-2 px-3 py-1.5 border-b border-[var(--color-bg-tertiary)] bg-[var(--color-bg-secondary)]">
      <span className="shrink-0 text-[11px] font-semibold text-[var(--color-accent)]">
        Pending AI change
      </span>
      <span className="text-[10px] text-[var(--color-text-secondary)] truncate">
        {file} · {label}
      </span>
      <span className="ml-auto shrink-0">
        <button onClick={onShow} className={BUTTON_CLASS}>
          Show diff
        </button>
      </span>
    </div>
  );
}
