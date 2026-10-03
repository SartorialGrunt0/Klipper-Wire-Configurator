/**
 * The per-edit rows in the chat transcript (post-hoc edit review).
 *
 * Each edit the model makes gets its own row as it happens: collapsed to
 * `file / [section]` with `+N` / `−N` and an advisory badge, unfolding to the
 * op's own mini-diff. Read-only by construction — the mid-turn rows are a
 * RECORD of what the model did, not a control surface (Sir, 2026-10-02); the
 * decision lives in the footer bar and the text view.
 *
 * A superseded row stays visible and says so. Two writes to one target is
 * honest history — the user steered between them — but only the survivor
 * counts toward the footer's totals.
 */
import { useMemo } from 'react';
import type React from 'react';

import DiffLines from '../DiffLines';
import type { ChangeSetView } from '../../utils/changeSet';
import { parsePatch } from '../../utils/configDiff';

interface Props {
  view: ChangeSetView;
  /** Row ids currently unfolded. */
  expanded: readonly string[];
  /** Row ids the user has undone (shown as such, still in the record). */
  undone: readonly string[];
  onToggle: (id: string) => void;
}

const Badge: React.FC<{ count: number; glyph: string; className: string; title: string }> = ({
  count, glyph, className, title,
}) => {
  if (count <= 0) return null;
  return (
    <span className={`shrink-0 rounded px-1 ${className}`} title={title}>
      {glyph}
      {count}
    </span>
  );
};

const EditRow: React.FC<{
  row: ChangeSetView['rows'][number];
  open: boolean;
  undone: boolean;
  onToggle: (id: string) => void;
}> = ({ row, open, undone, onToggle }) => {
  const lines = useMemo(() => (open ? parsePatch(row.diffText) : []), [open, row.diffText]);
  const badge = row.badge;

  return (
    <div className="rounded-md border border-[var(--color-bg-tertiary)] bg-[var(--color-bg-primary)]">
      <button
        type="button"
        onClick={() => onToggle(row.id)}
        className="flex w-full items-center gap-2 px-2 py-1 text-left text-[10px] transition-colors hover:bg-[var(--color-bg-secondary)]"
        title={open ? 'Fold this change' : 'Show this change'}
      >
        <span className="shrink-0 select-none opacity-50">{open ? '▾' : '▸'}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[var(--color-text-primary)]">
          {row.label}
        </span>
        <Badge count={badge.error} glyph="✕" className="text-[var(--color-error)]" title={`${badge.error} error-severity finding(s)`} />
        <Badge count={badge.warning} glyph="⚠" className="text-[var(--color-warning)]" title={`${badge.warning} warning(s)`} />
        <Badge count={badge.other} glyph="ℹ" className="text-[var(--color-text-secondary)]" title={`${badge.other} other finding(s)`} />
        {row.added > 0 && <span className="shrink-0 text-green-400">+{row.added}</span>}
        {row.removed > 0 && <span className="shrink-0 text-red-400">−{row.removed}</span>}
        {row.superseded && (
          <span className="shrink-0 italic text-[var(--color-text-secondary)]">
            replaced by a later edit
          </span>
        )}
        {undone && !row.superseded && (
          <span className="shrink-0 italic text-[var(--color-text-secondary)]">undone</span>
        )}
      </button>
      {open && (
        <div className="border-t border-[var(--color-bg-tertiary)] px-2 py-1 text-[10px]">
          {row.summary && (
            <p className="mb-1 text-[var(--color-text-secondary)]">{row.summary}</p>
          )}
          {/* No advisory hiding (plan hard rule 7): the badge is the
              collapsed count, the full text is here on unfold. */}
          {(row.advisories ?? []).length > 0 && (
            <ul className="mb-1 space-y-0.5">
              {(row.advisories ?? []).map((advisory, index) => (
                <li
                  key={`${row.id}-advisory-${index}`}
                  className={
                    advisory.severity === 'error'
                      ? 'text-[var(--color-error)]'
                      : advisory.severity === 'warning'
                        ? 'text-[var(--color-warning)]'
                        : 'text-[var(--color-text-secondary)]'
                  }
                >
                  {advisory.section ? `[${advisory.section}] ` : ''}
                  {advisory.message}
                </li>
              ))}
            </ul>
          )}
          {lines.length > 0 ? (
            <DiffLines lines={lines} className="max-h-48 overflow-y-auto rounded bg-[var(--color-bg-secondary)] text-[10px] leading-5" />
          ) : (
            <p className="text-[var(--color-text-secondary)]">No diff recorded for this change.</p>
          )}
        </div>
      )}
    </div>
  );
};

const ChatEditRows: React.FC<Props> = ({ view, expanded, undone, onToggle }) => {
  if (view.rows.length === 0) return null;
  const gone = new Set(undone);
  return (
    <div className="mb-3 space-y-1" aria-label="Changes made in this reply">
      {view.rows.map((row) => (
        <EditRow
          key={row.id}
          row={row}
          open={expanded.includes(row.id)}
          undone={gone.has(row.id)}
          onToggle={onToggle}
        />
      ))}
    </div>
  );
};

export default ChatEditRows;
