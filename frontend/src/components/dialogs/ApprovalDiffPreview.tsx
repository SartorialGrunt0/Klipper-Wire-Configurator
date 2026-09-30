import { useMemo, useState } from 'react';
import type { ApprovalCard } from '../../services/api';
import { createConfigPatch, parsePatch } from '../../utils/configDiff';

interface Props {
  card: ApprovalCard;
  onClose: () => void;
}

/**
 * Full-file diff preview for a pending approval card (Phase 4: the card
 * expansion). Reuses the exact createConfigPatch + parsePatch pipeline and
 * class vocabulary the toolbar DiffDialog uses, fed {before, after} from
 * the server-prepared op — the SAME data the card body renders, uncapped.
 * Severity badges come from the delta-validation findings attached to the
 * approval payload.
 */
export default function ApprovalDiffPreview({ card, onClose }: Props) {
  const before = card.diff?.before ?? '';
  const after = card.diff?.after ?? '';
  const diffLines = useMemo(() => {
    const patch = createConfigPatch(card.file, before, after, 'before', 'proposed', 3);
    return parsePatch(patch);
  }, [card.file, before, after]);

  const [showAll, setShowAll] = useState(false);
  // Preview list stays bounded so opening the dialog can't flood the DOM;
  // "Show all lines" un-caps it on demand.
  const COLLAPSE_AT = 400;
  const visible = showAll ? diffLines : diffLines.slice(0, COLLAPSE_AT);
  const hidden = diffLines.length - visible.length;

  const warnings = card.advisories.filter((a) => (a.severity || '').toLowerCase() === 'warning');
  const others = card.advisories.filter(
    (a) => {
      const s = (a.severity || '').toLowerCase();
      return s !== 'warning' && s !== 'error';
    },
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="bg-[var(--color-bg-secondary)] rounded-xl border border-[var(--color-bg-tertiary)] shadow-2xl w-[900px] max-h-[80vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-[var(--color-bg-tertiary)]">
          <div className="flex items-center gap-2 min-w-0">
            <h2 className="text-sm font-semibold truncate">
              Proposed change — {card.file}
            </h2>
            {card.advisories.length > 0 && (
              <span className="shrink-0 flex items-center gap-1.5">
                {warnings.length > 0 && (
                  <span className="text-[10px] font-semibold text-[var(--color-warning)]">
                    ⚠ {warnings.length} warning{warnings.length > 1 ? 's' : ''}
                  </span>
                )}
                {others.length > 0 && (
                  <span className="text-[10px] font-semibold text-[var(--color-text-secondary)]">
                    ℹ {others.length}
                  </span>
                )}
              </span>
            )}
          </div>
          <button onClick={onClose} className="text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]">
            ✕
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-auto p-4">
          <p className="text-xs text-[var(--color-text-secondary)] mb-2">{card.summary}</p>
          {card.advisories.length > 0 && (
            <ul className="mb-3 space-y-0.5">
              {card.advisories.map((adv, i) => (
                <li key={i} className="text-[10px] text-yellow-500/90">
                  ⚠ {adv.section ? `[${adv.section}] ` : ''}{adv.message}
                </li>
              ))}
            </ul>
          )}
          <div className="rounded-lg border border-[var(--color-bg-tertiary)] overflow-hidden">
            <pre className="text-xs leading-5 font-mono overflow-x-auto">
              {visible.map((line, i) => (
                <div
                  key={i}
                  className={
                    line.type === 'added'
                      ? 'w-max min-w-full bg-green-500/15 text-green-400 px-3'
                      : line.type === 'removed'
                        ? 'w-max min-w-full bg-red-500/15 text-red-400 px-3'
                        : line.type === 'header'
                          ? 'w-max min-w-full bg-blue-500/10 text-blue-400 px-3 py-1'
                          : 'w-max min-w-full text-[var(--color-text-secondary)] px-3'
                  }
                >
                  <span className="select-none opacity-50 mr-2">
                    {line.type === 'added' ? '+' : line.type === 'removed' ? '-' : line.type === 'header' ? '' : ' '}
                  </span>
                  {line.content || '\u00A0'}
                </div>
              ))}
            </pre>
          </div>
          {hidden > 0 && (
            <button
              onClick={() => setShowAll(true)}
              className="mt-2 text-[11px] text-[var(--color-accent)] hover:underline"
            >
              Show all lines ({hidden} more)
            </button>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 p-4 border-t border-[var(--color-bg-tertiary)]">
          <span className="mr-auto text-[10px] text-[var(--color-text-secondary)]">
            staged, not saved — the countdown in chat is authoritative
          </span>
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg text-xs font-medium bg-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] hover:bg-[var(--color-bg-primary)]"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
