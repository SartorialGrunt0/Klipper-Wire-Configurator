/**
 * The post-hoc review summary, shown above the composer.
 *
 * This is the decision surface for a change set (the transcript rows are the
 * record). It shows ONLY what still needs a decision: keeping or undoing an
 * edit removes it from here, the counters count only the remainder, and when
 * nothing is left undecided the whole summary goes away.
 *
 * The header folds the per-file/section list out (▸/▾) — the same gesture as
 * the progress strip, rather than a separate "review" button.
 *
 * Undo is expressed as a KEEP LIST and replayed server-side; keep changes
 * nothing in the text (the edit is already applied) and only ends the
 * decision.
 */
import { useState } from 'react';
import type React from 'react';

import type { PendingFile } from '../../utils/changeSet';

export interface ChangeSetBarProps {
  /** Undecided edits, grouped by file and section (decided ones are gone). */
  groups: PendingFile[];
  totals: { added: number; removed: number };
  /** A resolve request is in flight — the row is not re-clickable. */
  busy: boolean;
  /** Honest note from the last resolution (stale ops, failures). */
  note?: string | null;
  onKeepAll: () => void;
  onUndoAll: () => void;
  onKeepSection: (file: string, section: string, ids: string[]) => void;
  onUndoSection: (file: string, section: string, ids: string[]) => void;
  onKeepFile: (file: string, ids: string[]) => void;
  onUndoFile: (file: string, ids: string[]) => void;
  /** Jump the editor to a file (navigation only). */
  onOpenFile?: (file: string) => void;
}

const GroupButtons: React.FC<{
  busy: boolean;
  onKeep: () => void;
  onUndo: () => void;
  keepLabel: string;
  undoLabel: string;
  keepTitle: string;
  undoTitle: string;
}> = ({ busy, onKeep, onUndo, keepLabel, undoLabel, keepTitle, undoTitle }) => (
  <span className="flex shrink-0 items-center gap-1">
    <button
      type="button"
      onClick={onUndo}
      disabled={busy}
      className="rounded border border-[var(--color-bg-tertiary)] px-1.5 text-[9px] text-[var(--color-text-secondary)] transition-colors hover:border-[var(--color-error)] hover:text-[var(--color-error)] disabled:opacity-40"
      title={undoTitle}
    >
      {undoLabel}
    </button>
    <button
      type="button"
      onClick={onKeep}
      disabled={busy}
      className="rounded border border-[var(--color-bg-tertiary)] px-1.5 text-[9px] text-[var(--color-text-secondary)] transition-colors hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] disabled:opacity-40"
      title={keepTitle}
    >
      {keepLabel}
    </button>
  </span>
);

const ChangeSetBar: React.FC<ChangeSetBarProps> = ({
  groups,
  totals,
  busy,
  note,
  onKeepAll,
  onUndoAll,
  onKeepSection,
  onUndoSection,
  onKeepFile,
  onUndoFile,
  onOpenFile,
}) => {
  const [open, setOpen] = useState(false);
  const pending = groups.reduce(
    (sum, file) => sum + file.sections.reduce((n, section) => n + section.ids.length, 0),
    0,
  );
  if (pending === 0) return null;

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
            {pending} unreviewed
          </span>
          {totals.added > 0 && <span className="normal-case text-green-400">+{totals.added}</span>}
          {totals.removed > 0 && <span className="normal-case text-red-400">−{totals.removed}</span>}
        </button>
        <div className="flex-1" />
        <button
          type="button"
          onClick={onUndoAll}
          disabled={busy}
          className="rounded border border-[var(--color-bg-tertiary)] px-2 py-0.5 font-medium text-[var(--color-text-secondary)] transition-colors hover:border-[var(--color-error)] hover:text-[var(--color-error)] disabled:opacity-40"
          title="Drop every unreviewed change from this reply"
        >
          Reject all
        </button>
        <button
          type="button"
          onClick={onKeepAll}
          disabled={busy}
          className="rounded bg-[var(--color-accent)] px-2 py-0.5 font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40"
          title="Keep every unreviewed change from this reply"
        >
          Keep all
        </button>
      </div>

      {note && <p className="mt-1 text-[var(--color-warning)]">{note}</p>}

      {open && (
        <div className="mt-2 max-h-56 space-y-2 overflow-y-auto">
          {groups.map((file) => (
            <div key={file.file} className="rounded border border-[var(--color-bg-tertiary)]">
              <div className="flex items-center gap-2 border-b border-[var(--color-bg-tertiary)] px-2 py-1">
                <button
                  type="button"
                  onClick={() => onOpenFile?.(file.file)}
                  className="min-w-0 flex-1 truncate text-left font-mono text-[var(--color-text-primary)] hover:text-[var(--color-accent)]"
                  title="Show this file"
                >
                  {file.file}
                </button>
                {file.added > 0 && <span className="text-green-400">+{file.added}</span>}
                {file.removed > 0 && <span className="text-red-400">−{file.removed}</span>}
                <GroupButtons
                  busy={busy}
                  keepLabel="Keep file"
                  undoLabel="Undo file"
                  keepTitle={`Keep every change to ${file.file}`}
                  undoTitle={`Drop every change to ${file.file}`}
                  onKeep={() => onKeepFile(file.file, file.sections.flatMap((s) => s.ids))}
                  onUndo={() => onUndoFile(file.file, file.sections.flatMap((s) => s.ids))}
                />
              </div>
              {file.sections.map((section) => (
                <div
                  key={`${file.file}:${section.section}`}
                  className="flex items-center gap-2 px-2 py-1"
                >
                  <span className="min-w-0 flex-1 truncate font-mono text-[var(--color-text-secondary)]">
                    [{section.section}]
                  </span>
                  {section.advisories.error > 0 && (
                    <span className="text-[var(--color-error)]">✕{section.advisories.error}</span>
                  )}
                  {section.advisories.warning > 0 && (
                    <span className="text-[var(--color-warning)]">⚠{section.advisories.warning}</span>
                  )}
                  {section.added > 0 && <span className="text-green-400">+{section.added}</span>}
                  {section.removed > 0 && <span className="text-red-400">−{section.removed}</span>}
                  <GroupButtons
                    busy={busy}
                    keepLabel="Keep"
                    undoLabel="Undo"
                    keepTitle={`Keep the changes to [${section.section}]`}
                    undoTitle={`Drop the changes to [${section.section}]`}
                    onKeep={() => onKeepSection(file.file, section.section, section.ids)}
                    onUndo={() => onUndoSection(file.file, section.section, section.ids)}
                  />
                </div>
              ))}
            </div>
          ))}
          <p className="text-[var(--color-text-secondary)]">
            Keeping leaves the change in the editor; undoing takes it out.
            Undoing a file the model created removes the file.
          </p>
        </div>
      )}
    </div>
  );
};

export default ChangeSetBar;
