/**
 * The post-hoc review summary, shown above the composer.
 *
 * This is the chat's decision surface for the review; the transcript rows are
 * the history. It renders the LEDGER (Sir, 2026-10-07): one row per run of
 * `diff(FRAME, LIVE)`. A decision is a splice, not a server replay — keeping a
 * run freezes the live version into the frame and the run leaves the diff;
 * undoing puts the frame version back and it leaves the diff too. So the list
 * is exactly what still differs, and when nothing does the whole bar goes away.
 *
 * The header folds the per-file/per-run list out (▸/▾) — the same gesture as
 * the progress strip, rather than a separate "review" button.
 */
import { useState } from 'react';

import EditDecisionPair from '../EditDecisionPair';
import type { LedgerSectionFile } from '../../services/reviewEngine';

export interface ChangeSetBarProps {
  /** The review's files, each with its runs already labelled and previewed. */
  files: LedgerSectionFile[];
  onKeepAll: () => void;
  onUndoAll: () => void;
  onKeepFile: (file: string) => void;
  onUndoFile: (file: string) => void;
  onKeepRun: (file: string, key: string) => void;
  onUndoRun: (file: string, key: string) => void;
  /** Jump the editor to a file (navigation only). */
  onOpenFile?: (file: string) => void;
}

const ChangeSetBar: React.FC<ChangeSetBarProps> = ({
  files,
  onKeepAll,
  onUndoAll,
  onKeepFile,
  onUndoFile,
  onKeepRun,
  onUndoRun,
  onOpenFile,
}) => {
  const [open, setOpen] = useState(false);
  const totalRuns = files.reduce((sum, file) => sum + file.runs.length, 0);
  if (totalRuns === 0) return null;
  const totals = files.reduce(
    (acc, file) => ({ added: acc.added + file.added, removed: acc.removed + file.removed }),
    { added: 0, removed: 0 },
  );

  return (
    <div className="border-t border-[var(--color-bg-tertiary)] bg-[var(--color-bg-secondary)] px-3 py-2 text-[10px]">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setOpen((prev) => !prev)}
          className="flex items-center gap-1.5 font-semibold uppercase tracking-wider text-[var(--color-text-secondary)] transition-colors hover:text-[var(--color-text-primary)]"
          aria-expanded={open}
          title={open ? 'Hide the list of changes' : 'Show the list of changes'}
        >
          <span className="select-none opacity-60">{open ? '▾' : '▸'}</span>
          Changes
          <span className="rounded-full bg-[var(--color-warning)]/20 px-2 py-0.5 font-medium normal-case tracking-normal text-[var(--color-warning)]">
            {totalRuns} unreviewed
          </span>
          {totals.added > 0 && <span className="normal-case text-green-400">+{totals.added}</span>}
          {totals.removed > 0 && <span className="normal-case text-red-400">−{totals.removed}</span>}
        </button>
        <div className="flex-1" />
        <button
          type="button"
          onClick={onUndoAll}
          className="rounded border border-[var(--color-bg-tertiary)] px-2 py-0.5 font-medium text-[var(--color-text-secondary)] transition-colors hover:border-[var(--color-error)] hover:text-[var(--color-error)]"
          title="Put back every unreviewed change"
        >
          Undo all
        </button>
        <button
          type="button"
          onClick={onKeepAll}
          className="rounded bg-[var(--color-accent)] px-2 py-0.5 font-medium text-white transition-opacity hover:opacity-90"
          title="Keep every unreviewed change"
        >
          Keep all
        </button>
      </div>

      {open && (
        <div className="mt-2 max-h-56 space-y-2 overflow-y-auto">
          {files.map((file) => (
            <div key={file.file} className="rounded border border-[var(--color-bg-tertiary)]">
              <div className="flex items-center gap-2 border-b border-[var(--color-bg-tertiary)] px-2 py-1">
                <button
                  type="button"
                  onClick={() => onOpenFile?.(file.file)}
                  className="min-w-0 flex-1 truncate text-left font-mono text-[var(--color-text-primary)] hover:text-[var(--color-accent)]"
                  title="Show this file"
                >
                  {file.file}
                  {file.created && <span className="ml-1 italic text-[var(--color-text-secondary)]">(new file)</span>}
                </button>
                {file.added > 0 && <span className="text-green-400">+{file.added}</span>}
                {file.removed > 0 && <span className="text-red-400">−{file.removed}</span>}
                <EditDecisionPair
                  busy={false}
                  keepLabel="Keep file"
                  undoLabel="Undo file"
                  keepTitle={`Keep every change to ${file.file}`}
                  undoTitle={`Put back every change to ${file.file}`}
                  onKeep={() => onKeepFile(file.file)}
                  onUndo={() => onUndoFile(file.file)}
                />
              </div>
              {file.runs.map((run) => (
                <div key={run.key} className="flex items-center gap-2 px-2 py-1">
                  <span className="min-w-0 flex-1 truncate">
                    <span className="font-mono text-[var(--color-text-secondary)]">
                      {run.label || file.file}
                    </span>
                    {run.preview && (
                      <span className="ml-2 font-mono text-[var(--color-text-primary)]">{run.preview}</span>
                    )}
                  </span>
                  {run.added > 0 && <span className="text-green-400">+{run.added}</span>}
                  {run.removed > 0 && <span className="text-red-400">−{run.removed}</span>}
                  <EditDecisionPair
                    busy={false}
                    keepLabel="Keep"
                    undoLabel="Undo"
                    keepTitle={`Keep the change to ${run.label || file.file}`}
                    undoTitle={`Put back the change to ${run.label || file.file}`}
                    onKeep={() => onKeepRun(file.file, run.key)}
                    onUndo={() => onUndoRun(file.file, run.key)}
                  />
                </div>
              ))}
            </div>
          ))}
          <p className="text-[var(--color-text-secondary)]">
            Keeping leaves the change in the editor; undoing takes it out.
            Undoing every change to a file the model created removes the file.
          </p>
        </div>
      )}
    </div>
  );
};

export default ChangeSetBar;
