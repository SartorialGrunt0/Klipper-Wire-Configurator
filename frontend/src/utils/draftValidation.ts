/**
 * Assistant draft validation: detecting blocking issues, building feedback
 * messages, and formatting validation results for the AI retry loop.
 *
 * Extracted from chatUtils.ts (Phase 3 cleanup) — pure functions.
 */
import type { ValidationError, ValidationResult } from '../types/config';

// ── Constants ───────────────────────────────────────────────────────

export const MAX_ASSISTANT_DRAFT_VALIDATION_ATTEMPTS = 3;
export const MAX_ASSISTANT_HINT_USER_MESSAGES = 3;

const RETRY_EXEMPT_DUPLICATE_SECTION_RE = /^Section \[[^\]]+\] (?:can only be defined once(?: across active included config files)?\.|is reused across active included config files\.)(?: Also defined in: .+)?$/;
const RETRY_EXEMPT_SHARED_PIN_RE = /^Pin '.*' is used by multiple sections: .+$/;

// ── Types ───────────────────────────────────────────────────────────

export interface AssistantDraftValidationIssueGroup {
  filename: string;
  errors: ValidationError[];
}

export interface AssistantDraftValidationOutcome {
  applicable: boolean;
  blockingIssues: AssistantDraftValidationIssueGroup[];
  failureReason: string | null;
}

// ── Issue Classification ────────────────────────────────────────────

export function isBlockingAssistantValidationIssue(error: ValidationError): boolean {
  return error.severity === 'error' || error.severity === 'warning';
}

export function isRetryExemptAssistantValidationIssue(error: ValidationError): boolean {
  return RETRY_EXEMPT_DUPLICATE_SECTION_RE.test(error.message) || RETRY_EXEMPT_SHARED_PIN_RE.test(error.message);
}

export function hasOnlyRetryExemptAssistantValidationIssues(
  blockingIssues: AssistantDraftValidationIssueGroup[],
): boolean {
  const issues = blockingIssues.flatMap((group) => group.errors);
  return issues.length > 0 && issues.every((error) => isRetryExemptAssistantValidationIssue(error));
}

// ── Error Collection ────────────────────────────────────────────────

export function buildValidationErrorKey(filename: string, error: ValidationError): string {
  return [filename, error.severity, error.section, error.param, error.message].join('::');
}

export function collectNewValidationErrors(
  baselineValidations: Record<string, ValidationResult>,
  candidateValidations: Record<string, ValidationResult>,
): AssistantDraftValidationIssueGroup[] {
  const baselineCounts = new Map<string, number>();
  Object.entries(baselineValidations).forEach(([filename, result]) => {
    result.errors.forEach((error) => {
      if (!isBlockingAssistantValidationIssue(error)) return;
      const key = buildValidationErrorKey(filename, error);
      baselineCounts.set(key, (baselineCounts.get(key) ?? 0) + 1);
    });
  });

  const blockingByFile = new Map<string, ValidationError[]>();
  Object.entries(candidateValidations)
    .sort(([left], [right]) => left.localeCompare(right))
    .forEach(([filename, result]) => {
      result.errors.forEach((error) => {
        if (!isBlockingAssistantValidationIssue(error)) return;
        const key = buildValidationErrorKey(filename, error);
        const remainingBaselineCount = baselineCounts.get(key) ?? 0;
        if (remainingBaselineCount > 0) {
          baselineCounts.set(key, remainingBaselineCount - 1);
          return;
        }
        const existing = blockingByFile.get(filename);
        if (existing) { existing.push(error); return; }
        blockingByFile.set(filename, [error]);
      });
    });

  return Array.from(blockingByFile.entries()).map(([filename, errors]) => ({ filename, errors }));
}

// ── Formatting & Feedback ───────────────────────────────────────────

export function formatAssistantDraftValidationIssues(
  blockingIssues: AssistantDraftValidationIssueGroup[],
  failureReason: string | null,
): string {
  const lines: string[] = [];
  if (failureReason) lines.push(`- ${failureReason}`);
  blockingIssues.forEach(({ filename, errors }) => {
    lines.push(`File: ${filename}`);
    errors.forEach((error) => {
      const location = error.param ? `[${error.section}] ${error.param}` : `[${error.section}]`;
      lines.push(`- ${location}: ${error.message}`);
    });
  });
  return lines.join('\n');
}

export function buildAssistantDraftValidationFeedback(
  blockingIssues: AssistantDraftValidationIssueGroup[],
  invalidContent: string,
  failureReason: string | null,
  allowExplanationOnly = false,
): string {
  const formattedIssues = formatAssistantDraftValidationIssues(blockingIssues, failureReason)
    || '- The previous reply did not include a complete applicable cfg draft.';
  return [
    'Your cfg changes failed validation after merging into the current project.',
    'Return a corrected replacement reply that fixes every problem below and still satisfies the user request.',
    'If you return config changes, return only changed content inside fenced cfg code blocks and keep any required "# file: <filename>" hint. To edit an existing section use a mini-diff (section header plus only the changed lines, "-" removed / "+" added with original indentation); unchanged lines are preserved automatically. To add a new section, write it in full.',
    allowExplanationOnly
      ? 'If the remaining problems are duplicate sections or reused pins and you cannot resolve them safely from the current config, do not return another invalid cfg block. Instead, clearly explain the conflict, mention the exact section or pin involved, and say what must change before a valid config can be produced.'
      : 'Do not ask the user to apply manual fixes for these validation issues.',
    '',
    'Validation problems to fix:',
    formattedIssues,
    '',
    'Previous invalid reply:',
    '````text',
    invalidContent.trim() || 'No content returned.',
    '````',
  ].join('\n');
}

export function buildAssistantDraftValidationErrorMessage(
  blockingIssues: AssistantDraftValidationIssueGroup[],
  failureReason: string | null,
  attempts: number,
): string {
  const formattedIssues = formatAssistantDraftValidationIssues(blockingIssues, failureReason);
  const attemptLabel = attempts === 1 ? 'attempt' : 'attempts';
  if (!formattedIssues) return `AI draft failed validation after ${attempts} ${attemptLabel}.`;
  return `AI draft failed validation after ${attempts} ${attemptLabel}.\n${formattedIssues}`;
}
