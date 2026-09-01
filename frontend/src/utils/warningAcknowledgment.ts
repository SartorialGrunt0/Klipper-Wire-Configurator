/**
 * Acknowledge-gate: which warnings can be acknowledged to clear the
 * save-button flag. Branches on the stable `code` field (set by the backend
 * at the emit site) — never on message text — so backend rewording cannot
 * silently break the acknowledge action.
 *
 *   unknown_section   → kind 'unknown'   (ack stored per section snippet)
 *   project_duplicate → kind 'duplicate' (ack stored per section type)
 */
export interface AcknowledgeableWarning {
  kind: 'unknown' | 'duplicate';
}

export function acknowledgeableWarning(
  issue: Pick<{ code?: string }, 'code'>,
): AcknowledgeableWarning | null {
  switch (issue.code) {
    case 'unknown_section':
      return { kind: 'unknown' };
    case 'project_duplicate':
      return { kind: 'duplicate' };
    default:
      return null;
  }
}

/**
 * The acknowledgment kind for a section's issues. Unknown-section and
 * duplicate-section warnings are mutually exclusive per section (duplicates
 * only occur for known section types), so this is unambiguous.
 */
export function ackKindForSection(
  issues: ReadonlyArray<Pick<{ severity: string; code?: string }, 'severity' | 'code'>>,
): 'unknown' | 'duplicate' | null {
  let unknown = false;
  for (const issue of issues) {
    if (issue.severity !== 'warning') continue;
    const kind = acknowledgeableWarning(issue);
    if (kind === null) continue;
    if (kind.kind === 'duplicate') return 'duplicate';
    unknown = true;
  }
  return unknown ? 'unknown' : null;
}

export function sectionHasAcknowledgeableWarning(
  issues: ReadonlyArray<Pick<{ severity: string; code?: string }, 'severity' | 'code'>>,
): boolean {
  return ackKindForSection(issues) !== null;
}
