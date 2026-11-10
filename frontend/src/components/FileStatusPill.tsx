import type { ReactNode } from 'react';

/**
 * Shared status-pill ladder for the Apply/Export review lists. The tint
 * ladder used to be copy-pasted into both dialogs, so every style tweak had
 * to land twice — and during the UI-cohesiveness pass one of the copies
 * drifted. Keep both dialogs on this single definition.
 *
 *   tone 'error'   — deleted file / error-level status
 *   tone 'warning' — new file
 *   tone 'accent'  — changed lines
 *   tone 'neutral' — unchanged file
 */
export type PillTone = 'error' | 'warning' | 'accent' | 'neutral';

const TONE_CLASS: Record<PillTone, string> = {
  error: 'bg-[var(--color-error)]/20 text-[var(--color-error)]',
  warning: 'bg-[var(--color-warning)]/20 text-[var(--color-warning)]',
  accent: 'bg-[var(--color-accent)]/20 text-[var(--color-accent)]',
  neutral: 'bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)]',
};

export const StatusPill = ({ tone, children }: { tone: PillTone; children: ReactNode }) => (
  <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${TONE_CLASS[tone]}`}>{children}</span>
);

/** Solid count badge: red-600 destructive fill when errors are present,
 *  solid warning fill otherwise (house badge-revert ladder). */
export const FindingsPill = ({ count, errorCount }: { count: number; errorCount: number }) =>
  count > 0 ? (
    <span
      className={`text-[10px] px-1.5 py-0.5 rounded-full ${
        errorCount > 0
          ? 'bg-red-600 text-white'
          : 'bg-[var(--color-warning)] text-[var(--color-bg-primary)]'
      }`}
    >
      {count} finding{count !== 1 ? 's' : ''}
    </span>
  ) : null;
