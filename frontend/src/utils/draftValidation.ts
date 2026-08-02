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

/** Section types whose body is Jinja/g-code — silently droppable lines. */
// NOTE: full_header has no brackets (e.g. `gcode_macro Level_Bed`, `bed_mesh`).
const MACRO_SECTION_HEADER_RE = /^(gcode_macro|delayed_gcode|display_template|display_data)\b/i;

/** True when the draft section is byte-equivalent to the base section. */
function sectionParamsEqual(left: ConfigSection, right: ConfigSection): boolean {
  if (left.params.length !== right.params.length) return false;
  for (let index = 0; index < left.params.length; index += 1) {
    const a = left.params[index];
    const b = right.params[index];
    if (a.key !== b.key
      || a.value !== b.value
      || a.comment !== b.comment
      || a.is_commented_out !== b.is_commented_out) {
      return false;
    }
  }
  return true;
}

/**
 * True when a full rewrite of this section could silently drop lines that
 * validation would NOT catch: macro/Jinja bodies and any multi-line param
 * value (gcode bodies, data blocks). Plain single-line key-value sections
 * (bed_mesh, printer, extruder, ...) are safe to full-rewrite — missing
 * params surface as normal validation errors, and forcing mini-diffs there
 * is what makes add-only edits deadlock: a pure '+' has no '-' anchor, so
 * it is not even recognized as a mini-diff and the model cannot comply.
 */
function sectionCanHideDroppedLines(section: ConfigSection): boolean {
  if (MACRO_SECTION_HEADER_RE.test(section.full_header)) return true;
  return section.params.some((param) => param.value.includes('\n'));
}

/**
 * Reject FULL rewrites of EXISTING sections that can silently lose lines
 * (macros and any section with a multi-line body). The edit protocol
 * requires mini-diffs for those so unchanged lines are preserved
 * automatically; a full rewrite lets the model regenerate a section from a
 * semantic summary and drop lines (G28, {% endif %}, M104, comments).
 * Plain config sections (single-line key-value params) are NOT flagged —
 * their full rewrites are validated normally and any dropped param shows
 * up as a validation error. This is the FIRST guard — it fires before any
 * content heuristics. New sections (not in base) are never flagged:
 * additions are written in full by protocol.
 */
export function buildFullRewriteSectionIssues(
  baseSections: ConfigSection[],
  assistantSections: ConfigSection[],
  fullRewriteTargets: Array<{ fullHeader: string }>,
): ValidationError[] {
  const baseHeaders = new Set(baseSections.map((section) => section.full_header));
  const draftByHeader = new Map(
    assistantSections.map((section) => [section.full_header, section] as const),
  );
  const errors: ValidationError[] = [];
  for (const target of fullRewriteTargets) {
    if (!baseHeaders.has(target.fullHeader)) continue; // new section — full write is fine
    const draftSection = draftByHeader.get(target.fullHeader);
    if (!draftSection || !sectionCanHideDroppedLines(draftSection)) continue;
    const baseSection = baseSections.find((section) => section.full_header === target.fullHeader);
    // A no-op quote (draft identical to the current content, e.g. "here is
    // what is already there") is not a rewrite — allow it.
    if (baseSection && sectionParamsEqual(draftSection, baseSection)) continue;
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

/**
 * When the full-rewrite guard flags a section, other validation errors for
 * that SAME section are artifacts of the partial rewrite (a stub section
 * trivially fails required-param checks) and FIGHT the guard's directive:
 * "missing mesh_min" invites the model to return the whole section, which
 * re-triggers the guard. Drop them so the retry feedback carries one clear
 * instruction. Errors for other sections are untouched.
 */
export function suppressValidationErrorsShadowedByFullRewrite(
  blockingIssues: AssistantDraftValidationIssueGroup[],
): AssistantDraftValidationIssueGroup[] {
  const guardKeys = new Set<string>();
  for (const group of blockingIssues) {
    for (const error of group.errors) {
      if (error.message.includes('was returned as a full rewrite')) {
        guardKeys.add(`${group.filename}::${error.section}`);
      }
    }
  }
  if (guardKeys.size === 0) return blockingIssues;
  return blockingIssues
    .map((group) => ({
      ...group,
      errors: group.errors.filter((error) => {
        const key = `${group.filename}::${error.section}`;
        return !guardKeys.has(key) || error.message.includes('was returned as a full rewrite');
      }),
    }))
    .filter((group) => group.errors.length > 0);
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
