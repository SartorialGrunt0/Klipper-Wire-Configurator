/**
 * Assistant draft validation: detecting blocking issues, building feedback
 * messages, and formatting validation results for the AI retry loop.
 *
 * Extracted from chatUtils.ts (Phase 3 cleanup) — pure functions.
 */
import type { ValidationError, ValidationResult, ConfigSection } from '../types/config';

// ── Constants ───────────────────────────────────────────────────────

export const MAX_ASSISTANT_DRAFT_VALIDATION_ATTEMPTS = 2;
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
  /** Macro section headers whose trailing Jinja closers were auto-appended. */
  repairedSections: string[];
}

// ── Full-rewrite guard for existing sections ────────────────────────

/**
 * Reject FULL rewrites of EXISTING sections (any section type). The edit
 * protocol requires mini-diffs for existing sections so unchanged lines are
 * preserved automatically; a full rewrite lets the model regenerate a
 * section from a semantic summary and silently drop lines (G28, {% endif %},
 * M104, comments). This is the FIRST guard — it fires whenever an existing
 * section comes back without '-'/'+' markers, before any content heuristics.
 * New sections (not in base) are never flagged: additions are written in
 * full by protocol.
 */
export function buildFullRewriteSectionIssues(
  baseSections: ConfigSection[],
  assistantSections: ConfigSection[],
  fullRewriteTargets: Array<{ fullHeader: string }>,
): ValidationError[] {
  const baseHeaders = new Set(baseSections.map((section) => section.full_header));
  const draftHeaders = new Set(assistantSections.map((section) => section.full_header));
  const errors: ValidationError[] = [];
  for (const target of fullRewriteTargets) {
    if (!baseHeaders.has(target.fullHeader)) continue; // new section — full write is fine
    if (!draftHeaders.has(target.fullHeader)) continue;
    errors.push({
      severity: 'error',
      message: `Existing section '[${target.fullHeader}]' was returned as a full rewrite. Emit it as a mini-diff instead: the section header followed by ONLY the lines that change, prefixing removals with '-' and additions with '+'. Unchanged lines are preserved automatically and cannot be dropped.`,
      section: target.fullHeader,
      param: '',
      line_number: 0,
    });
  }
  return errors;
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

const JINJA_INNERMOST_BLOCK_RE = /The innermost block that needs to be closed is '([a-z_]+)'/i;
const JINJA_CLOSER_BY_OPENER: Record<string, string> = {
  if: 'endif',
  for: 'endfor',
  while: 'endwhile',
  raw: 'endraw',
  macro: 'endmacro',
  block: 'endblock',
  filter: 'endfilter',
  call: 'endcall',
  with: 'endwith',
};

/**
 * Derive prescriptive repair commands from Klippy-style "unexpected end of
 * template" errors, e.g. "the innermost block that needs to be closed is
 * 'if'" -> "append {% endif %} at the end of its gcode body". The Klippy
 * error names what is missing but not the fix; the model repairs better when
 * told exactly what to append and where (verified 2026-08: repair prompts
 * with a direct command succeed at lean context where open-ended retries
 * keep regenerating lossy drafts).
 */
export function deriveJinjaRepairCommands(
  blockingIssues: AssistantDraftValidationIssueGroup[],
): string[] {
  const commands: string[] = [];
  const seen = new Set<string>();
  for (const group of blockingIssues) {
    for (const error of group.errors) {
      if (!error.message.includes('Unexpected end of template')) continue;
      const match = JINJA_INNERMOST_BLOCK_RE.exec(error.message);
      if (!match) continue;
      const closer = JINJA_CLOSER_BY_OPENER[match[1].toLowerCase()];
      if (!closer) continue;
      const section = error.section ? `[${error.section}]` : '';
      const key = `${section}:${closer}`;
      if (seen.has(key)) continue;
      seen.add(key);
      commands.push(
        `The innermost open Jinja block in ${section || 'the macro'} is '${match[1]}' — append {% ${closer} %} at the end of its gcode body.`,
      );
    }
  }
  return commands;
}

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
  affectedSections: Array<{ filename: string; header: string; content: string }> = [],
): string {
  const formattedIssues = formatAssistantDraftValidationIssues(blockingIssues, failureReason)
    || '- The previous reply did not include a complete applicable cfg draft.';
  const repairCommands = deriveJinjaRepairCommands(blockingIssues);
  const parts = [
    'Your cfg changes failed validation after merging into the current project.',
    'Return a corrected replacement reply that fixes every problem below and still satisfies the user request.',
    'If you return config changes, return only changed content inside fenced cfg code blocks and keep any required "# file: <filename>" hint. To edit an existing section use a mini-diff (section header plus only the changed lines, "-" removed / "+" added with original indentation); unchanged lines are preserved automatically. To add a new section, write it in full.',
    // Phase 4: never quote the previous reply — models copy it verbatim and
    // regenerate the broken draft. The anti-copy directive + the mini-diff
    // protocol (which only accepts changed lines) break that loop.
    'Do NOT copy or repeat your previous reply. Emit a fresh mini-diff with ONLY the corrected lines.',
    allowExplanationOnly
      ? 'If the remaining problems are duplicate sections or reused pins and you cannot resolve them safely from the current config, do not return another invalid cfg block. Instead, clearly explain the conflict, mention the exact section or pin involved, and say what must change before a valid config can be produced.'
      : 'Do not ask the user to apply manual fixes for these validation issues.',
    '',
    'Validation problems to fix:',
    formattedIssues,
  ];
  if (repairCommands.length > 0) {
    parts.push('', 'Direct fixes:', ...repairCommands.map((command) => `- ${command}`));
  }
  if (affectedSections.length > 0) {
    parts.push('', 'Current section content (edit only what must change):');
    for (const section of affectedSections) {
      parts.push('', `### [${section.header}] in ${section.filename}`, '```cfg', section.content, '```');
    }
  }
  return parts.join('\n');
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
