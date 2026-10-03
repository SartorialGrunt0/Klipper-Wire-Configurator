import { useEffect, useMemo, useRef, useState } from 'react';

import DiffLines from './DiffLines';
import type { ChangeSetRow } from '../utils/changeSet';
import type { PendingDiffModel } from '../utils/pendingDiff';
import type { ChangeStop } from '../utils/pendingChanges';

/**
 * The text view's pending-change surface.
 *
 * Two shapes over one model, so the pane and the card can never disagree about
 * which change is waiting:
 *
 *  - `PendingDiffPane` — the takeover. It renders the WHOLE file with the
 *    still-undecided changes marked (`buildUnreviewedDiffModel`), and it is a
 *    REVIEW surface: move between the changes, keep or undo one, keep or undo
 *    the file. The decisions are the same store actions the chat's footer bar
 *    calls (`services/changeSetReview`), never a second implementation.
 *  - `PendingDiffChip` — the header strip shown when the takeover was
 *    suppressed (the user is highlighting the very lines being changed) or
 *    declined ("Back to editing").
 *
 * The rows are a PROPOSAL, not current file text in the sense of "saved": the
 * frame is the document before the unreviewed changes, and undoing is a server
 * replay. A global change (a stale anchor, a failed apply) shows in `note` —
 * the same string the chat's footer shows, because it is the same field.
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

const KEEP_BUTTON_CLASS =
  'text-[10px] px-2 py-0.5 rounded bg-[var(--color-accent)] text-white '
  + 'transition-opacity hover:opacity-90 disabled:opacity-40';

const UNDO_BUTTON_CLASS =
  'text-[10px] px-2 py-0.5 rounded border border-[var(--color-bg-tertiary)] '
  + 'text-[var(--color-text-secondary)] transition-colors hover:border-[var(--color-error)] '
  + 'hover:text-[var(--color-error)] disabled:opacity-40';

const NAV_BUTTON_CLASS =
  'text-[10px] w-5 h-5 rounded border border-[var(--color-bg-tertiary)] '
  + 'text-[var(--color-text-secondary)] transition-colors hover:border-[var(--color-accent)] '
  + 'hover:text-[var(--color-accent)] disabled:opacity-30 disabled:hover:border-[var(--color-bg-tertiary)]';

export interface PaneDecisions {
  busy: boolean;
  note: string | null;
  onKeepSection: (file: string, section: string, ids: string[]) => void;
  onUndoSection: (file: string, section: string, ids: string[]) => void;
  onKeepFile: (file: string, ids: string[]) => void;
  onUndoFile: (file: string, ids: string[]) => void;
}

interface PaneProps extends PaneDecisions {
  model: PendingDiffModel;
  /** The file's still-undecided rows — what the decisions below act on. */
  rows: ChangeSetRow[];
  /** Where the changes are, in reading order. */
  stops: ChangeStop[];
  /** Other files still waiting on a decision, so the pane can offer them. */
  otherFiles: Array<{ file: string; count: number }>;
  onOpenFile: (file: string) => void;
  /** User asked to keep editing — the pane returns to the buffer. */
  onHide: () => void;
}

export default function PendingDiffPane({
  model, rows, stops, otherFiles,
  busy, note,
  onKeepSection, onUndoSection, onKeepFile, onUndoFile,
  onOpenFile, onHide,
}: PaneProps) {
  const rowsRef = useRef<HTMLPreElement>(null);
  const [index, setIndex] = useState(0);
  // A new model (another file, or the marks moving under a decision) must not
  // leave the cursor on a stop that no longer exists.
  const safeIndex = Math.min(index, Math.max(0, stops.length - 1));

  const scrollToStop = (stopIndex: number) => {
    const container = rowsRef.current;
    const stop = stops[stopIndex];
    if (!container || !stop) return;
    const row = container.children[stop.row] as HTMLElement | undefined;
    if (!row) return;
    container.scrollTop = Math.max(0, row.offsetTop - container.clientHeight * 0.2);
  };

  // Land on the first change when the model changes (a new card, another file,
  // or after a decision re-frames the diff).
  useEffect(() => {
    setIndex(0);
    const container = rowsRef.current;
    if (!container || model.firstChangedRow < 0) return;
    const row = container.children[model.firstChangedRow] as HTMLElement | undefined;
    if (!row) return;
    container.scrollTop = Math.max(0, row.offsetTop - container.clientHeight * 0.2);
  }, [model]);

  const stop = stops[safeIndex];
  // Section-level decisions: the whole section the current change belongs to
  // (section is the atomic decision unit — a stop is navigation).
  const section = useMemo(() => {
    const owner = stop?.ids[0];
    if (!owner) return null;
    const row = rows.find((candidate) => candidate.id === owner);
    if (!row || !row.section) return null;
    const ids = rows
      .filter((candidate) => candidate.section === row.section && candidate.file === row.file)
      .map((candidate) => candidate.id);
    return { file: row.file, section: row.section, ids };
  }, [stop, rows]);
  const fileIds = rows.map((row) => row.id);

  return (
    <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
      <PendingHeader model={model}>
        {otherFiles.map((other) => (
          <button
            key={other.file}
            onClick={() => onOpenFile(other.file)}
            className={BUTTON_CLASS}
            title={`Show ${other.file}`}
          >
            +{other.count} in {other.file}
          </button>
        ))}
        <button onClick={onHide} className={BUTTON_CLASS}>
          Back to editing
        </button>
      </PendingHeader>

      <div className="flex flex-wrap items-center gap-2 px-3 py-1 border-b border-[var(--color-bg-tertiary)] bg-[var(--color-bg-secondary)]">
        <span className="flex items-center gap-1">
          <button
            type="button"
            className={NAV_BUTTON_CLASS}
            onClick={() => { const next = Math.max(0, safeIndex - 1); setIndex(next); scrollToStop(next); }}
            disabled={safeIndex <= 0}
            title="Previous change"
          >
            ‹
          </button>
          <button
            type="button"
            className={NAV_BUTTON_CLASS}
            onClick={() => {
              const next = Math.min(stops.length - 1, safeIndex + 1);
              setIndex(next);
              scrollToStop(next);
            }}
            disabled={safeIndex >= stops.length - 1}
            title="Next change"
          >
            ›
          </button>
        </span>
        <span className="text-[10px] text-[var(--color-text-secondary)]">
          {stops.length === 0
            ? 'no unreviewed change in this file'
            : `change ${safeIndex + 1} of ${stops.length}`}
          {stop?.label ? ` · ${stop.label}` : ''}
        </span>
        <span className="ml-auto flex items-center gap-2">
          {section && (
            <>
              <button
                type="button"
                className={UNDO_BUTTON_CLASS}
                disabled={busy}
                onClick={() => onUndoSection(section.file, section.section, section.ids)}
                title={`Drop every change to [${section.section}]`}
              >
                Undo [{section.section}]
              </button>
              <button
                type="button"
                className={KEEP_BUTTON_CLASS}
                disabled={busy}
                onClick={() => onKeepSection(section.file, section.section, section.ids)}
                title={`Keep every change to [${section.section}]`}
              >
                Keep [{section.section}]
              </button>
            </>
          )}
          {/* A card-shaped model (the dormant gate) has no change set behind
              it, so there is nothing for these to act on. */}
          {rows.length > 0 && (
            <>
              <button
                type="button"
                className={UNDO_BUTTON_CLASS}
                disabled={busy}
                onClick={() => onUndoFile(model.file, fileIds)}
                title={`Drop every change to ${model.file}`}
              >
                Undo file
              </button>
              <button
                type="button"
                className={KEEP_BUTTON_CLASS}
                disabled={busy}
                onClick={() => onKeepFile(model.file, fileIds)}
                title={`Keep every change to ${model.file}`}
              >
                Keep file
              </button>
            </>
          )}
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
