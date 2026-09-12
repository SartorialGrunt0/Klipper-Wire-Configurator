/**
 * Acknowledge-gate: which warnings can be acknowledged to clear the
 * save-button flag. Branches on the stable `code` field (set by the backend
 * at the emit site) — never on message text — so backend rewording cannot
 * silently break the acknowledge action.
 *
 *   unknown_section   → kind 'unknown'   (ack stored per section snippet)
 *   project_duplicate → kind 'duplicate' (ack stored per section type)
 *   gcode registry    → kind 'registry'  (ack via the bulk identity endpoint,
 *                       one identity per command name — finding.extra)
 */
export interface AcknowledgeableWarning {
  kind: 'unknown' | 'duplicate' | 'registry';
}

/** Codes produced by the gcode command registry scan. */
export const GCODE_REGISTRY_CODES: ReadonlySet<string> = new Set([
  'unknown_gcode_command',
  'gcode_command_section_missing',
]);

export function acknowledgeableWarning(
  issue: Pick<{ code?: string }, 'code'>,
): AcknowledgeableWarning | null {
  switch (issue.code) {
    case 'unknown_section':
      return { kind: 'unknown' };
    case 'project_duplicate':
      return { kind: 'duplicate' };
    default:
      return GCODE_REGISTRY_CODES.has(issue.code ?? '')
        ? { kind: 'registry' }
        : null;
  }
}

/**
 * The acknowledgment kind for a section's issues. Unknown-section and
 * duplicate-section warnings are mutually exclusive per section (duplicates
 * only occur for known section types); registry warnings only occur on
 * gcode_macro/delayed_gcode sections (known types), so precedence is
 * duplicate > unknown > registry with no real-world collision.
 */
export function ackKindForSection(
  issues: ReadonlyArray<Pick<{ severity: string; code?: string }, 'severity' | 'code'>>,
): 'unknown' | 'duplicate' | 'registry' | null {
  let unknown = false;
  let registry = false;
  for (const issue of issues) {
    if (issue.severity !== 'warning') continue;
    const kind = acknowledgeableWarning(issue);
    if (kind === null) continue;
    if (kind.kind === 'duplicate') return 'duplicate';
    if (kind.kind === 'registry') { registry = true; continue; }
    unknown = true;
  }
  if (unknown) return 'unknown';
  return registry ? 'registry' : null;
}

export function sectionHasAcknowledgeableWarning(
  issues: ReadonlyArray<Pick<{ severity: string; code?: string }, 'severity' | 'code'>>,
): boolean {
  return ackKindForSection(issues) !== null;
}
