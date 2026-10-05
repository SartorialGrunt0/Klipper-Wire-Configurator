import { useMemo, useState } from 'react';
import { ISSUE_MARKER } from '../utils/issueMarker';
import { summariseIssues, type IssueSeverity } from '../utils/issueSummary';
import type { TextIssue } from '../types/editor';

interface EditorIssueStripProps {
  /** Findings for the active file, already filtered by Settings > Validation. */
  issues: TextIssue[];
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onJump: (line: number) => void;
  onAcknowledge: (issue: TextIssue) => void;
}

/**
 * The findings strip under the editor.
 *
 * Collapsed (the default) it is a single header row: one dot + count per
 * severity — hover a dot for its status messages (the same tooltip text the
 * gutter dots carry) — and a summary of the worst finding. Expanded it shows
 * the per-finding rows with their Acknowledge buttons, and clicking a severity
 * dot filters the list to that severity.
 *
 * File-level findings (line 0) have no line to jump to, so they stay out of the
 * list and out of the counts — the same filtering the strip always applied.
 */
function EditorIssueStrip({
  issues,
  collapsed,
  onToggleCollapsed,
  onJump,
  onAcknowledge,
}: EditorIssueStripProps) {
  const [severityFilter, setSeverityFilter] = useState<IssueSeverity | null>(null);

  const rowIssues = useMemo(() => issues.filter((issue) => issue.line > 0), [issues]);
  const summaries = useMemo(() => summariseIssues(rowIssues), [rowIssues]);

  if (rowIssues.length === 0) return null;

  const visible = severityFilter
    ? rowIssues.filter((issue) => issue.severity === severityFilter)
    : rowIssues;

  return (
    <div className="shrink-0 border-t border-[var(--color-bg-tertiary)] bg-[var(--color-bg-secondary)]">
      {/* The whole bar is the toggle (Cliff, 2026-10-04): the chevron is the
          affordance, not the only hit target. The severity dots keep their own
          click, so they stop the event rather than folding the list. */}
      <div
        className="flex cursor-pointer items-center gap-3 px-3 py-1"
        onClick={onToggleCollapsed}
        title={collapsed ? 'Show every finding below the editor' : 'Collapse the findings list'}
      >
        <span className="flex shrink-0 items-center gap-1 text-xs text-[var(--color-text-secondary)]">
          <span className="text-[9px]">{collapsed ? '▲' : '▼'}</span>
          <span>
            {rowIssues.length} finding{rowIssues.length === 1 ? '' : 's'}
          </span>
        </span>

        <div className="flex shrink-0 items-center gap-3">
          {summaries.map((summary) => {
            const spec = ISSUE_MARKER[summary.severity];
            const active = severityFilter === summary.severity;
            return (
              <button
                key={summary.severity}
                onClick={(event) => {
                  event.stopPropagation();
                  setSeverityFilter(active ? null : summary.severity);
                }}
                // Hovering the dot shows the status messages themselves.
                title={summary.title}
                aria-label={spec.title}
                className={`flex items-center gap-1.5 rounded px-1 py-0.5 transition-colors hover:bg-[var(--color-bg-tertiary)] ${
                  active ? 'bg-[var(--color-bg-tertiary)]' : ''
                }`}
              >
                <span className={spec.dotClass ?? undefined} />
                <span className="text-xs" style={{ color: spec.color }}>
                  {summary.count}
                </span>
              </button>
            );
          })}
        </div>

        {!collapsed && severityFilter && (
          <span className="min-w-0 flex-1 truncate text-right text-[10px] text-[var(--color-text-secondary)]">
            showing {severityFilter} only
          </span>
        )}
      </div>

      {!collapsed && (
        <div className="max-h-32 overflow-y-auto border-t border-[var(--color-bg-tertiary)]">
          {visible.map((issue, idx) => (
            <div
              key={`${issue.line}-${issue.severity}-${idx}`}
              className="flex items-center gap-2 px-3 py-1 text-xs cursor-pointer hover:bg-[var(--color-bg-tertiary)]"
              style={{ color: ISSUE_MARKER[issue.severity].color }}
              onClick={() => onJump(issue.line)}
            >
              <span>{ISSUE_MARKER[issue.severity].marker}</span>
              <span className="min-w-0 flex-1 truncate">
                Line {issue.line}: {issue.text}
              </span>
              {issue.acknowledgeKind && (
                <button
                  onClick={(event) => {
                    event.stopPropagation();
                    onAcknowledge(issue);
                  }}
                  className="shrink-0 rounded border border-[var(--color-warning)] px-2 py-0.5 text-[10px] font-medium text-[var(--color-warning)] hover:bg-[var(--color-warning)] hover:text-[var(--color-bg-primary)] transition-colors"
                  title={
                    issue.acknowledgeKind === 'duplicate'
                      ? 'Acknowledge this duplicate section warning and stop flagging the save button'
                      : issue.acknowledgeKind === 'registry'
                        ? 'Acknowledge this command warning and hide it in future validations'
                        : 'Acknowledge this unknown section and hide its warning in future validations'
                  }
                >
                  Acknowledge
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default EditorIssueStrip;
