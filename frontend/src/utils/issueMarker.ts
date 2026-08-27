import type { ValidationError } from '../types/config';

export type IssueSeverity = ValidationError['severity'];

/**
 * Severity → visual marker for issue rows and gutter indicators (3.5).
 *
 * Info uses the UI's existing grey — the same family as the default save
 * button (`--color-bg-tertiary` background, `--color-text-secondary` text).
 * Info is deliberately lower-emphasis than error/warning: it is legal,
 * order-dependent context (e.g. "this section is also defined in B.cfg —
 * the later include wins"), not an alarm.
 *
 * Info never degrades node/file STATUS (save button, validation status stay
 * clean — backend `has_warnings` is false for info-only files), but it still
 * gets a muted grey dot on graph nodes so findings stay visible when a card
 * is selected (Q1). The per-line gutter gets the same small muted dot.
 */
export interface IssueMarkerSpec {
  marker: string;
  color: string;
  dotClass: string | null;
  gutterDotClass: string | null;
  title: string;
}

export const ISSUE_MARKER: Record<IssueSeverity, IssueMarkerSpec> = {
  error: {
    marker: '●',
    color: 'var(--color-error)',
    dotClass: 'w-2 h-2 rounded-full bg-[var(--color-error)]',
    gutterDotClass: 'w-2 h-2 rounded-full bg-[var(--color-error)]',
    title: 'Validation error',
  },
  warning: {
    marker: '▲',
    color: 'var(--color-warning)',
    dotClass: 'w-2 h-2 rounded-full bg-[var(--color-warning)]',
    gutterDotClass: 'w-2 h-2 rounded-full bg-[var(--color-warning)]',
    title: 'Validation warning',
  },
  info: {
    marker: '·',
    color: 'var(--color-text-secondary)',
    dotClass: 'w-1.5 h-1.5 rounded-full bg-[var(--color-text-secondary)] opacity-70',
    gutterDotClass: 'w-1.5 h-1.5 rounded-full bg-[var(--color-text-secondary)] opacity-70',
    title: 'Info — legal, order-dependent; no action required',
  },
};

export function issueSeverityOf(severity: string): IssueSeverity {
  return severity === 'error' || severity === 'warning' ? severity : 'info';
}
