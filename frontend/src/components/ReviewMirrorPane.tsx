/**
 * The compact review mirror (Sir, 2026-10-07).
 *
 * The live review path used to flip to a read-only takeover of the WHOLE
 * document. Now the buffer stays live and the flip shows only the CHANGED
 * RUNS, mini-diff style: each run's removed lines then its added lines, under a
 * header naming the file and the section. That is the same `DiffLines` the card
 * and the in-place review use, so the green/red reading cannot drift.
 *
 * Each run's header row carries its own Keep/Undo pair (the pair the whole app
 * shares, `EditDecisionPair`), and the header strip folds the pane back to the
 * buffer. Decisions go through `services/reviewEngine.keepRun`/`undoRun` — the
 * same engine the strip and the chat's footer bar call.
 */
import { useMemo } from 'react';
import type React from 'react';

import DiffLines from './DiffLines';
import EditDecisionPair from './EditDecisionPair';
import type { DiffLine } from '../utils/configDiff';
import type { LedgerSectionFile } from '../services/reviewEngine';

const BACK_BUTTON_CLASS =
  'text-[10px] px-2 py-0.5 rounded border border-[var(--color-accent)]/40 '
  + 'text-[var(--color-accent)] hover:bg-[var(--color-accent)]/10 transition-colors';

export interface ReviewMirrorPaneProps {
  /** The review's files with their runs (empty-run files included). */
  files: LedgerSectionFile[];
  onKeepRun: (file: string, key: string) => void;
  onUndoRun: (file: string, key: string) => void;
  onOpenFile: (file: string) => void;
  /** Fold the mirror away — back to the live editor. */
  onHide: () => void;
}

interface MirrorFile {
  file: LedgerSectionFile;
  lines: DiffLine[];
  /** Row index of each run's header line → the run it belongs to. */
  headers: Map<number, { key: string }>;
}

/** One file's changed runs as mini-diff rows, header line first per run. */
function mirrorFile(file: LedgerSectionFile): MirrorFile {
  const lines: DiffLine[] = [];
  const headers = new Map<number, { key: string }>();
  for (const entry of file.runs) {
    headers.set(lines.length, { key: entry.key });
    lines.push({
      type: 'header',
      content: `${file.file}${entry.label ? ` · ${entry.label}` : ''}`,
    });
    for (const text of entry.run.removed) lines.push({ type: 'removed', content: text });
    for (const text of entry.run.added) lines.push({ type: 'added', content: text });
  }
  if (lines.length === 0) {
    // A created file with no lines yet: still offer its Keep/Undo.
    lines.push({ type: 'context', content: `${file.file} (empty)` });
  }
  return { file, lines, headers };
}

export default function ReviewMirrorPane({
  files, onKeepRun, onUndoRun, onOpenFile, onHide,
}: ReviewMirrorPaneProps) {
  const rendered = useMemo(() => files.map(mirrorFile), [files]);
  const totalAdded = files.reduce((sum, file) => sum + file.added, 0);
  const totalRemoved = files.reduce((sum, file) => sum + file.removed, 0);

  return (
    <div className="flex-1 flex flex-col min-w-0 overflow-hidden bg-[var(--color-bg-primary)]">
      <div className="flex items-center gap-2 px-3 py-1 border-b border-[var(--color-bg-tertiary)] bg-[var(--color-bg-secondary)]">
        <span className="text-[11px] font-semibold text-[var(--color-accent)]">Review diff</span>
        <span className="text-[10px] text-[var(--color-text-secondary)]">
          {files.length} file{files.length === 1 ? '' : 's'}
        </span>
        {totalAdded > 0 && <span className="text-[10px] text-green-400">+{totalAdded}</span>}
        {totalRemoved > 0 && <span className="text-[10px] text-red-400">−{totalRemoved}</span>}
        <span className="ml-auto shrink-0">
          <button type="button" onClick={onHide} className={BACK_BUTTON_CLASS}>
            Back to editing
          </button>
        </span>
      </div>

      <div className="flex-1 min-h-0 overflow-auto py-2">
        {rendered.map(({ file, lines, headers }) => (
          <div key={file.file} className="mb-2 border-b border-[var(--color-bg-tertiary)] pb-2 last:border-b-0">
            <DiffLines
              lines={lines}
              rowExtras={(rowIndex) => {
                const header = headers.get(rowIndex);
                if (!header) return null;
                return (
                  <span className="flex items-center rounded border border-[var(--color-bg-tertiary)] bg-[var(--color-bg-secondary)] p-0.5 shadow-lg">
                    <button
                      type="button"
                      onClick={() => onOpenFile(file.file)}
                      className="mr-1 text-[9px] text-[var(--color-text-secondary)] hover:text-[var(--color-accent)]"
                      title="Show this file"
                    >
                      open
                    </button>
                    <EditDecisionPair
                      busy={false}
                      size="sm"
                      onUndo={() => onUndoRun(file.file, header.key)}
                      onKeep={() => onKeepRun(file.file, header.key)}
                    />
                  </span>
                );
              }}
              className="text-xs leading-relaxed"
            />
          </div>
        ))}
      </div>
    </div>
  );
}
