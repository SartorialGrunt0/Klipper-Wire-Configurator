/**
 * The post-hoc review action bar, shown above the composer.
 *
 * This is the decision surface for a change set (the transcript rows are the
 * record). It carries the totals, keep-all / reject-all, per-file and
 * per-section keep/undo, and the `N unreviewed` state — the state that must
 * stay visible until every edit has been kept or undone, including at Save.
 *
 * Undo is expressed as a KEEP LIST, never as a text edit: the backend
 * replays the kept ops onto the request's baseline, so dropping an edit
 * cannot leave residue behind.
 */
import { useState } from 'react';
import type React from 'react';

import type { ChangeSetView } from '../../utils/changeSet';

export interface ChangeSetBarProps {
  view: ChangeSetView;
  totals: { added: number; removed: number };
  unreviewed: number;
  undone: readonly string[];
  /** A resolve request is in flight — the bar is not re-clickable. */
  busy: boolean;
  /** Honest note from the last resolution (stale ops, failures). */
  note?: string | null;
  onKeepAll: () => void;
  onUndoAll: () => void;
  onUndoSection: (file: string, section: string) => void;
  onUndoFile: (file: string) => void;
  /** Jump the editor to a file (navigation only). */
  onOpenFile?: (file: string) => void;
}

const ChangeSetBar: React.FC<ChangeSetBarProps> = ({
  view,
  totals,
  unreviewed,
  undone,
  busy,
  note,
  onKeepAll,
  onUndoAll,
  onUndoSection,
  onUndoFile,
  onOpenFile,
}) => {
  const [open, setOpen] = useState(false);
  const gone = new Set(undone);
  const undoneCount = view.rows.filter((row) => gone.has(row.id)).length;

  return (
    <div className="border-t border-[var(--color-bg-tertiary)] bg-[var(--color-bg-secondary)] px-3 py-2 text-[10px]">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold uppercase tracking-wider text-[var(--color-text-secondary)]">
          Changes
        </span>
        <span className="text-[var(--color-text-primary)]">
          {view.liveIds.length}
        </span>
        {totals.added > 0 && <span className="text-green-400">+{totals.added}</span>}
        {totals.removed > 0 && <span className="text-red-400">−{totals.removed}</span>}
        {undoneCount > 0 && (
          <span className="italic text-[var(--color-text-secondary)]">
            {undoneCount} undone
          </span>
        )}
        {unreviewed > 0 && (
          <span className="rounded-full bg-[var(--color-warning)]/20 px-2 py-0.5 font-medium text-[var(--color-warning)]">
            {unreviewed} unreviewed
          </span>
        )}
        <div className="flex-1" />
        <button
          type="button"
          onClick={() => setOpen((prev) => !prev)}
          className="rounded border border-[var(--color-bg-tertiary)] px-2 py-0.5 font-medium text-[var(--color-text-secondary)] transition-colors hover:text-[var(--color-text-primary)]"
          title="Review each change"
          aria-expanded={open}
        >
          {open ? 'Hide list' : 'Review'}
        </button>
        <button
          type="button"
          onClick={onUndoAll}
          disabled={busy}
          className="rounded border border-[var(--color-bg-tertiary)] px-2 py-0.5 font-medium text-[var(--color-text-secondary)] transition-colors hover:border-[var(--color-error)] hover:text-[var(--color-error)] disabled:opacity-40"
          title="Drop every change from this reply"
        >
          Reject all
        </button>
        <button
          type="button"
          onClick={onKeepAll}
          disabled={busy}
          className="rounded bg-[var(--color-accent)] px-2 py-0.5 font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40"
          title="Keep every change from this reply"
        >
          Keep all
        </button>
      </div>

      {note && <p className="mt-1 text-[var(--color-warning)]">{note}</p>}

      {open && (
        <div className="mt-2 max-h-56 space-y-2 overflow-y-auto">
          {view.files.map((file) => (
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
                <button
                  type="button"
                  onClick={() => onUndoFile(file.file)}
                  disabled={busy}
                  className="rounded border border-[var(--color-bg-tertiary)] px-1.5 text-[9px] text-[var(--color-text-secondary)] transition-colors hover:border-[var(--color-error)] hover:text-[var(--color-error)] disabled:opacity-40"
                  title={`Drop every change to ${file.file}`}
                >
                  Undo file
                </button>
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
                  <button
                    type="button"
                    onClick={() => onUndoSection(file.file, section.section)}
                    disabled={busy || section.edits.every((id) => gone.has(id))}
                    className="rounded border border-[var(--color-bg-tertiary)] px-1.5 text-[9px] text-[var(--color-text-secondary)] transition-colors hover:border-[var(--color-error)] hover:text-[var(--color-error)] disabled:opacity-40"
                    title={`Drop the changes to [${section.section}]`}
                  >
                    Undo
                  </button>
                </div>
              ))}
            </div>
          ))}
          {view.createdFiles.length > 0 && (
            <p className="text-[var(--color-text-secondary)]">
              Creates {view.createdFiles.join(', ')} — undoing removes the file.
            </p>
          )}
        </div>
      )}
    </div>
  );
};

export default ChangeSetBar;
