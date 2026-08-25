import type { ValidationError } from '../types/config';

// Warning prefixes/messages that can be acknowledged to stop the save button
// from staying flagged yellow. Mirrors the backend duplicate-section messages
// (backend/parser/validator.py).
export const UNKNOWN_SECTION_WARNING_PREFIX = 'Unknown section type ';

const DUPLICATE_WARNING_PATTERNS = [
  /^Section \[[^\]]+\] can only be defined once\.$/,
  /^Section \[[^\]]+\] is reused across active included config files\./,
];

export function isUnknownSectionWarning(message: string): boolean {
  return message.startsWith(UNKNOWN_SECTION_WARNING_PREFIX);
}

export function isDuplicateSectionWarning(message: string): boolean {
  return DUPLICATE_WARNING_PATTERNS.some((pattern) => pattern.test(message));
}

export interface AcknowledgeableWarning {
  kind: 'unknown' | 'duplicate';
}

export function acknowledgeableWarning(message: string): AcknowledgeableWarning | null {
  if (isUnknownSectionWarning(message)) return { kind: 'unknown' };
  if (isDuplicateSectionWarning(message)) return { kind: 'duplicate' };
  return null;
}

export function isAcknowledgeableWarning(message: string): boolean {
  return acknowledgeableWarning(message) !== null;
}

/**
 * The acknowledgment kind for a section's issues. Unknown-section and
 * duplicate-section warnings are mutually exclusive per section (duplicates
 * only occur for known section types), so this is unambiguous.
 */
export function ackKindForSection(
  issues: ReadonlyArray<Pick<ValidationError, 'severity' | 'message'>>,
): 'unknown' | 'duplicate' | null {
  let unknown = false;
  for (const issue of issues) {
    if (issue.severity !== 'warning') continue;
    const kind = acknowledgeableWarning(issue.message);
    if (kind === null) continue;
    if (kind.kind === 'duplicate') return 'duplicate';
    unknown = true;
  }
  return unknown ? 'unknown' : null;
}

export function sectionHasAcknowledgeableWarning(issues: ReadonlyArray<Pick<ValidationError, 'severity' | 'message'>>): boolean {
  return ackKindForSection(issues) !== null;
}
