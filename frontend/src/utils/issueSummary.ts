import type { ValidationError } from '../types/config';

export type IssueSeverity = ValidationError['severity'];

/** Worst-first. Used for "which colour does this line get" decisions. */
export const SEVERITY_ORDER: readonly IssueSeverity[] = ['error', 'warning', 'info'];

/** Messages listed in a severity dot's hover tooltip before it summarises. */
export const HOVER_MESSAGE_CAP = 20;

export interface IssueLike {
  line: number;
  text: string;
  severity: IssueSeverity;
}

export interface SeveritySummary {
  severity: IssueSeverity;
  /** Findings of this severity across all lines. */
  count: number;
  /** Distinct line numbers (1-based), ascending. File-level findings (line 0) excluded. */
  lines: number[];
  /** De-duplicated messages, capped at HOVER_MESSAGE_CAP. */
  messages: string[];
  /** Messages that did not fit in the cap. */
  overflow: number;
  /** Ready-to-render tooltip text: heading + `Line N: message` rows. */
  title: string;
}

const LABEL: Record<IssueSeverity, string> = {
  error: 'error',
  warning: 'warning',
  info: 'info',
};

/** The most severe among `severities`, or null for an empty list. */
export function worstSeverity(severities: readonly IssueSeverity[]): IssueSeverity | null {
  for (const severity of SEVERITY_ORDER) {
    if (severities.includes(severity)) return severity;
  }
  return null;
}

/**
 * Worst severity per 1-based line. Findings with `line <= 0` are file-level and
 * have no line to colour, so they are dropped here.
 */
export function lineSeverities(issues: readonly IssueLike[]): Map<number, IssueSeverity> {
  const byLine = new Map<number, IssueSeverity[]>();
  for (const issue of issues) {
    if (issue.line < 1) continue;
    const bucket = byLine.get(issue.line);
    if (bucket) bucket.push(issue.severity);
    else byLine.set(issue.line, [issue.severity]);
  }
  const result = new Map<number, IssueSeverity>();
  for (const [line, severities] of byLine) {
    const worst = worstSeverity(severities);
    if (worst) result.set(line, worst);
  }
  return result;
}

/**
 * One entry per severity that has at least one finding, worst first — the
 * footer dot row's data source. Hovering a dot shows `title`.
 */
export function summariseIssues(issues: readonly IssueLike[]): SeveritySummary[] {
  const bySeverity = new Map<IssueSeverity, IssueLike[]>();
  for (const issue of issues) {
    const bucket = bySeverity.get(issue.severity);
    if (bucket) bucket.push(issue);
    else bySeverity.set(issue.severity, [issue]);
  }

  const summaries: SeveritySummary[] = [];
  for (const severity of SEVERITY_ORDER) {
    const bucket = bySeverity.get(severity);
    if (!bucket || bucket.length === 0) continue;

    const lines = Array.from(
      new Set(bucket.filter((i) => i.line > 0).map((i) => i.line)),
    ).sort((a, b) => a - b);

    // De-dupe identical messages (the same finding can repeat across lines)
    // while keeping the first line it was seen on.
    const seen = new Map<string, number>();
    for (const issue of bucket) {
      if (!seen.has(issue.text)) seen.set(issue.text, issue.line);
    }
    const allMessages = Array.from(seen.entries());
    const kept = allMessages.slice(0, HOVER_MESSAGE_CAP);
    const overflow = allMessages.length - kept.length;

    const heading = `${bucket.length} ${LABEL[severity]}${bucket.length === 1 ? '' : 's'}`;
    const rows = kept.map(([text, line]) => (line > 0 ? `Line ${line}: ${text}` : text));
    const title = [heading, ...rows, overflow > 0 ? `…and ${overflow} more` : null]
      .filter((part): part is string => part !== null)
      .join('\n');

    summaries.push({
      severity,
      count: bucket.length,
      lines,
      messages: kept.map(([text]) => text),
      overflow,
      title,
    });
  }
  return summaries;
}

/** Drop findings whose severity the user has switched off in Settings > Validation. */
export function filterIssuesBySeverity<T extends IssueLike>(
  issues: readonly T[],
  severities: ReadonlySet<IssueSeverity>,
): T[] {
  return issues.filter((issue) => severities.has(issue.severity));
}
