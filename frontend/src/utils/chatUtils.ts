/**
 * Shared utility functions and constants for the AI Chat feature.
 *
 * Pure functions — no React state or hooks. Designed to be extracted from
 * the ChatDialog component to reduce file size and improve testability.
 */
import type { ValidationError, ValidationResult, ConfigFile, ConfigSection } from '../types/config';

import type { AiProvider } from '../stores/aiStore';

// ── Provider Configuration ──────────────────────────────────────────

export interface ProviderInfo {
  label: string;
  defaultUrl: string;
  requiresKey: boolean;
  defaultHost: string;
  defaultPort: string;
  defaultModel: string;
}

export const PROVIDER_OPTIONS: Array<{ value: AiProvider; label: string }> = [
  { value: 'chatgpt', label: 'ChatGPT (OpenAI)' },
  { value: 'google', label: 'Google (Gemini)' },
  { value: 'anthropic', label: 'Anthropic (Claude)' },
  { value: 'github', label: 'GitHub Copilot' },
  { value: 'openai-compatible', label: 'OpenAI Compatible' },
];

export const PROVIDER_DEFAULTS: Record<AiProvider, ProviderInfo> = {
  chatgpt: {
    label: 'ChatGPT (OpenAI)',
    defaultUrl: 'https://api.openai.com/v1/chat/completions',
    requiresKey: true,
    defaultHost: 'localhost',
    defaultPort: '1234',
    defaultModel: 'gpt-4o',
  },
  google: {
    label: 'Google (Gemini)',
    defaultUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    requiresKey: true,
    defaultHost: 'localhost',
    defaultPort: '1234',
    defaultModel: 'gemini-1.5-pro',
  },
  anthropic: {
    label: 'Anthropic (Claude)',
    defaultUrl: 'https://api.anthropic.com/v1/messages',
    requiresKey: true,
    defaultHost: 'localhost',
    defaultPort: '1234',
    defaultModel: 'claude-3-5-sonnet',
  },
  github: {
    label: 'GitHub Copilot',
    defaultUrl: 'https://models.github.ai/inference/chat/completions',
    requiresKey: true,
    defaultHost: 'localhost',
    defaultPort: '1234',
    defaultModel: 'gpt-4o',
  },
  'openai-compatible': {
    label: 'OpenAI Compatible',
    defaultUrl: 'http://localhost:11434/api/chat',
    requiresKey: false,
    defaultHost: 'localhost',
    defaultPort: '11434',
    defaultModel: 'gpt-4o',
  },

};

// ── Provider Helpers ────────────────────────────────────────────────

export const isLocalProvider = (provider: AiProvider): boolean =>
  provider === 'openai-compatible';

export function buildLocalProviderApiUrl(host: string, port: string): string {
  return `http://${host}:${port}/v1/chat/completions`;
}

export function resolveProviderApiUrl(
  provider: AiProvider,
  apiUrl: string,
  host: string,
  port: string,
): string {
  if (provider === 'openai-compatible') {
    return buildLocalProviderApiUrl(host, port);
  }
  return apiUrl;
}

export function getProviderModel(
  provider: AiProvider,
  providerModels: Partial<Record<AiProvider, string>>,
  fallbackModel = '',
  fallbackProvider?: AiProvider,
): string {
  const providerModel = providerModels[provider]?.trim();
  if (providerModel) {
    return providerModel;
  }
  if (fallbackProvider === provider && fallbackModel.trim()) {
    return fallbackModel;
  }
  return '';
}

// ── Config Context Helpers ──────────────────────────────────────────

export const CONTEXT_TRUNCATION_LIMIT = 40000;
export const CONFIG_CODE_LANGUAGES = new Set(['', 'cfg', 'conf', 'ini', 'klipper', 'printercfg']);
export const ASSISTANT_FILE_HINT_RE = /^[#;]\s*file\s*:\s*(.+?)\s*$/i;

export function truncateConfigContext(content: string): string {
  if (content.length <= CONTEXT_TRUNCATION_LIMIT) {
    return content;
  }
  return `${content.slice(0, CONTEXT_TRUNCATION_LIMIT)}\n\n# Context truncated after ${CONTEXT_TRUNCATION_LIMIT} characters.`;
}

export function buildConfigContextMessage(filename: string, content: string, label: string): string {
  return `${label}: ${filename}\n\n\`\`\`cfg\n${truncateConfigContext(content)}\n\`\`\``;
}

// ── Config Code Block Extraction ───────────────────────────────────

export function extractConfigCodeBlocks(content: string): string[] {
  const codeBlockPattern = /```([^\n`]*)\n([\s\S]*?)```/g;
  const configBlocks: string[] = [];
  const fallbackBlocks: string[] = [];
  for (const match of content.matchAll(codeBlockPattern)) {
    const language = match[1].trim().toLowerCase();
    const block = match[2].trim();
    if (!block) continue;
    if (CONFIG_CODE_LANGUAGES.has(language)) {
      configBlocks.push(block);
    } else {
      fallbackBlocks.push(block);
    }
  }
  if (configBlocks.length > 0) return configBlocks;
  if (fallbackBlocks.length > 0) return [fallbackBlocks[0]];

  // Fallback: if no fenced code blocks found, check whether the raw text
  // contains config-like patterns (delete markers *[section], file hints).
  // This handles AI models that output `*[section_name]` without wrapping
  // them in ```cfg ... ```.
  if (/^\s*(?:[*]\[[^\]]+\]|[#;]\s*file\s*:)/m.test(content)) {
    return [content];
  }

  return [];
}

export function extractConfigCodeBlock(content: string): string | null {
  return extractConfigCodeBlocks(content)[0] ?? null;
}

// ── Printer Memory Code Block Extraction ───────────────────────────

const PRINTER_MEMORY_LANGUAGE = 'printer-memory';

/**
 * Normalise printer memory keys from display-friendly formats (e.g.
 * "Mainboard", "Toolhead Board", "Printer Name") to internal camelCase
 * keys ("mainboard", "toolheadBoard", "printerName").
 */
const PRINTER_MEMORY_KEY_MAP: Record<string, string> = {
  mainboard: 'mainboard',
  Mainboard: 'mainboard',
  'toolhead board': 'toolheadBoard',
  'Toolhead Board': 'toolheadBoard',
  toolheadboard: 'toolheadBoard',
  'expander boards': 'expanderBoards',
  'Expander Boards': 'expanderBoards',
  expanderboards: 'expanderBoards',
  'printer name': 'printerName',
  'Printer Name': 'printerName',
  printername: 'printerName',
  kinematics: 'kinematics',
  Kinematics: 'kinematics',
  probe: 'probe',
  Probe: 'probe',
  'additional notes': 'additionalNotes',
  'Additional Notes': 'additionalNotes',
  additionalnotes: 'additionalNotes',
};

function normalizePrinterMemoryKeys(raw: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    const canonical = PRINTER_MEMORY_KEY_MAP[key.trim()] || key;
    result[canonical] = typeof value === 'string' ? value : String(value ?? '');
  }
  return result;
}

/**
 * Extract a printer-memory fenced code block from AI response text.
 * Returns the parsed PrinterMemory object, or null if none found.
 *
 * Handles:
 * - Explanatory text around the JSON inside the code block
 * - Display-friendly keys ("Mainboard", "Printer Name") → canonical camelCase
 */
export function extractPrinterMemoryBlock(content: string): Record<string, string> | null {
  const codeBlockPattern = /```([^\n`]*)\n([\s\S]*?)```/g;
  for (const match of content.matchAll(codeBlockPattern)) {
    const language = match[1].trim().toLowerCase();
    if (language !== PRINTER_MEMORY_LANGUAGE) continue;
    const block = match[2].trim();
    if (!block) continue;

    // Find JSON content within the block — look for first { to last }
    const jsonStart = block.indexOf('{');
    if (jsonStart === -1) continue;
    const jsonEnd = block.lastIndexOf('}');
    if (jsonEnd === -1 || jsonEnd <= jsonStart) continue;
    const jsonStr = block.slice(jsonStart, jsonEnd + 1);

    try {
      const parsed = JSON.parse(jsonStr);
      if (parsed && typeof parsed === 'object') {
        const normalized = normalizePrinterMemoryKeys(parsed as Record<string, string>);
        // Strip any keys not in the allowed set (safety net against AI adding extra fields)
        return stripPrinterMemoryExtraKeys(normalized);
      }
    } catch {
      // Not valid JSON, skip this block
    }
  }
  return null;
}

/**
 * Check if a message contains a printer-memory code block.
 */
export function hasPrinterMemoryBlock(content: string): boolean {
  return /```printer-memory\s*\n/i.test(content);
}

// ── Printer Memory Validation ──────────────────────────────────

/** The only keys the printer-memory JSON may contain. */
const ALLOWED_PRINTER_MEMORY_KEYS = new Set([
  'mainboard',
  'toolheadBoard',
  'expanderBoards',
  'printerName',
  'kinematics',
  'probe',
  'additionalNotes',
]);

/**
 * Return any keys in the parsed object that are NOT in the allowed set.
 * Used to detect when the AI adds unsupported fields.
 */
export function getPrinterMemoryExtraKeys(
  parsed: Record<string, string>,
): string[] {
  return Object.keys(parsed).filter((k) => !ALLOWED_PRINTER_MEMORY_KEYS.has(k));
}

/**
 * Strip any keys from the object that aren't in the allowed set.
 * Applied inside `extractPrinterMemoryBlock` as a safety net.
 */
export function stripPrinterMemoryExtraKeys(
  parsed: Record<string, string>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (ALLOWED_PRINTER_MEMORY_KEYS.has(key)) {
      result[key] = value;
    }
  }
  return result;
}

// ── Comprehensive Printer Memory Validation ────────────────────

export interface PrinterMemoryValidationIssue {
  type: 'parse_error' | 'extra_keys';
  message: string;
  extraKeys?: string[];
}

/**
 * Run comprehensive validation on an AI message containing a
 * printer-memory code block. Catches:
 * - Missing/invalid JSON inside the block
 * - Non-object values (arrays, primitives)
 * - Extra fields beyond the 7 allowed keys
 *
 * @returns null if no printer-memory block is found.
 *          Otherwise returns issues (empty = valid) + the cleaned parsed data.
 */
export function validatePrinterMemoryContent(
  content: string,
): { issues: PrinterMemoryValidationIssue[]; parsed: Record<string, string> | null } | null {
  if (!hasPrinterMemoryBlock(content)) return null;

  const codeBlockPattern = /```([^\n`]*)\n([\s\S]*?)```/g;
  for (const match of content.matchAll(codeBlockPattern)) {
    const language = match[1].trim().toLowerCase();
    if (language !== PRINTER_MEMORY_LANGUAGE) continue;

    const block = match[2].trim();
    if (!block) {
      return { issues: [{ type: 'parse_error', message: 'The printer-memory code block is empty.' }], parsed: null };
    }

    // Find JSON content within the block
    const jsonStart = block.indexOf('{');
    if (jsonStart === -1) {
      return {
        issues: [{ type: 'parse_error', message: 'The printer-memory block does not contain a JSON object (no opening { found).' }],
        parsed: null,
      };
    }
    const jsonEnd = block.lastIndexOf('}');
    if (jsonEnd === -1 || jsonEnd <= jsonStart) {
      return {
        issues: [{ type: 'parse_error', message: 'The printer-memory block has an incomplete JSON object (missing closing }).' }],
        parsed: null,
      };
    }

    const jsonStr = block.slice(jsonStart, jsonEnd + 1);
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonStr);
    } catch (err: unknown) {
      const detail = err instanceof Error ? err.message : 'unknown error';
      return {
        issues: [{ type: 'parse_error', message: `The printer-memory block contains invalid JSON: ${detail}` }],
        parsed: null,
      };
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {
        issues: [{ type: 'parse_error', message: 'The printer-memory block JSON must be a flat object, not an array or primitive.' }],
        parsed: null,
      };
    }

    // Normalise keys to canonical camelCase
    const normalized = normalizePrinterMemoryKeys(parsed as Record<string, string>);
    const issues: PrinterMemoryValidationIssue[] = [];

    // Check for extra keys
    const extraKeys = getPrinterMemoryExtraKeys(normalized);
    if (extraKeys.length > 0) {
      issues.push({
        type: 'extra_keys',
        message: `Unsupported fields: ${extraKeys.join(', ')}. Only the 7 defined fields are allowed.`,
        extraKeys,
      });
    }

    // Strip extras and return
    const stripped = stripPrinterMemoryExtraKeys(normalized);
    return { issues, parsed: Object.keys(stripped).length > 0 ? stripped : null };
  }

  return null;
}

/** Build a user-role message telling the AI to fix printer-memory block issues. */
export function buildPrinterMemoryValidationFeedback(
  issues: PrinterMemoryValidationIssue[],
): string {
  const parts: string[] = [
    'The printer-memory block you returned has errors that must be fixed:',
    '',
  ];
  for (const issue of issues) {
    if (issue.type === 'parse_error') {
      parts.push('- The block has a formatting error.');
      parts.push(`  ${issue.message}`);
    } else if (issue.type === 'extra_keys') {
      parts.push('- The block contains fields that are not supported.');
      parts.push(`  ${issue.message}`);
    }
  }
  parts.push('');
  parts.push('Only these 7 fields are allowed:');
  parts.push('  - mainboard');
  parts.push('  - toolheadBoard');
  parts.push('  - expanderBoards');
  parts.push('  - printerName');
  parts.push('  - kinematics');
  parts.push('  - probe');
  parts.push('  - additionalNotes');
  parts.push('');
  parts.push('All values must be plain strings. Return a corrected printer-memory block.');
  return parts.join('\n');
}

/** Maximum retries for printer memory validation. */
export const MAX_PRINTER_MEMORY_VALIDATION_ATTEMPTS = 3;

export function extractEqualsSeparatedConfigLines(content: string): string[] {
  const matches = extractConfigCodeBlocks(content)
    .flatMap((block) => block.split(/\r?\n/))
    .map((line) => line.trim())
    .filter((line) => /^#?\s*[A-Za-z0-9_][A-Za-z0-9_-]*\s*=.*$/.test(line));
  return Array.from(new Set(matches));
}

export function buildConfigSeparatorRewritePrompt(offendingLines: string[]): string {
  const examples = offendingLines.slice(0, 5).map((line) => `- ${line}`).join('\n');
  return [
    'Rewrite your previous reply so every cfg parameter assignment uses a colon separator instead of an equals sign.',
    'Keep the exact same files, section headers, parameter names, values, ordering, comments, and surrounding explanation.',
    'Do not change gcode command arguments inside multiline values. Only change cfg parameter lines from `key = value` to `key: value`.',
    'Return the full replacement reply.',
    '',
    'Examples that must be rewritten with colons:',
    examples,
  ].join('\n');
}

// ── String / Text Helpers ──────────────────────────────────────────

export function appendWarningMessage(current: string | null, next: string): string {
  return current ? `${current}\n${next}` : next;
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ── Config Filename Extraction ─────────────────────────────────────

export function extractMentionedConfigFilenames(
  texts: string[],
  availableFilenames: string[],
): string[] {
  const matches: string[] = [];
  for (const filename of availableFilenames) {
    const pattern = new RegExp(`(^|[^A-Za-z0-9_.-])${escapeRegExp(filename)}(?=$|[^A-Za-z0-9_.-])`, 'i');
    if (texts.some((text) => pattern.test(text))) {
      matches.push(filename);
    }
  }
  return matches;
}

export function extractAssistantFileHint(
  configBlock: string,
  availableFilenames: string[],
): { configText: string; fileHint: string | null } {
  const availableByLower = new Map(availableFilenames.map((filename) => [filename.toLowerCase(), filename]));
  const lines = configBlock.split(/\r?\n/);
  let fileHint: string | null = null;
  let fileHintLineIndex = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    if (!trimmed) continue;
    const hintMatch = ASSISTANT_FILE_HINT_RE.exec(trimmed);
    if (hintMatch) {
      const rawName = hintMatch[1].trim();
      fileHint = availableByLower.get(rawName.toLowerCase()) ?? rawName;
      fileHintLineIndex = index;
    }
    break;
  }
  if (fileHintLineIndex === -1) {
    return { configText: configBlock, fileHint };
  }
  return {
    configText: lines.filter((_, index) => index !== fileHintLineIndex).join('\n').trim(),
    fileHint,
  };
}

// ── Assistant Target Resolution ────────────────────────────────────

function scoreAssistantTargetFile(
  config: ConfigFile,
  assistantSections: ConfigSection[],
): { exactMatches: number; sectionTypeMatches: number } {
  const fullHeaders = new Set(config.sections.map((section) => section.full_header));
  const sectionTypes = new Set(config.sections.map((section) => section.section_type));
  let exactMatches = 0;
  let sectionTypeMatches = 0;
  assistantSections.forEach((section) => {
    if (fullHeaders.has(section.full_header)) {
      exactMatches += 1;
      return;
    }
    if (sectionTypes.has(section.section_type)) {
      sectionTypeMatches += 1;
    }
  });
  return { exactMatches, sectionTypeMatches };
}

export function resolveAssistantTargetFile(
  assistantConfig: ConfigFile,
  configFiles: Record<string, ConfigFile>,
  activeFile: string,
  hintedFilenames: string[],
): string | null {
  const availableFilenames = Object.keys(configFiles);
  const uniqueHints = Array.from(new Set(hintedFilenames));

  // If the AI explicitly named a single target file (existing or new), trust it.
  if (uniqueHints.length === 1) return uniqueHints[0];

  // If no files are loaded and no single hint, we can't resolve a target.
  if (availableFilenames.length === 0) return null;

  // Multiple hints — narrow to those that exist in the project.
  const existingHints = uniqueHints.filter((filename) => Boolean(configFiles[filename]));
  if (existingHints.length === 1) return existingHints[0];
  if (existingHints.length > 1) {
    // Multiple existing-file hints — score them against the assistant's sections.
    const scored = existingHints
      .map((filename) => {
        const { exactMatches, sectionTypeMatches } = scoreAssistantTargetFile(configFiles[filename], assistantConfig.sections);
        return { filename, exactMatches, sectionTypeMatches };
      })
      .sort((left, right) => {
        if (right.exactMatches !== left.exactMatches) return right.exactMatches - left.exactMatches;
        return right.sectionTypeMatches - left.sectionTypeMatches;
      });
    if (scored[0].exactMatches > 0 || scored[0].sectionTypeMatches > 0) return scored[0].filename;
    return scored[0].filename; // best guess
  }

  // No matching hints — score all available files against assistant sections.
  const scores = availableFilenames
    .map((filename) => {
      const { exactMatches, sectionTypeMatches } = scoreAssistantTargetFile(configFiles[filename], assistantConfig.sections);
      return { filename, exactMatches, sectionTypeMatches, active: filename === activeFile };
    })
    .sort((left, right) => {
      if (right.exactMatches !== left.exactMatches) return right.exactMatches - left.exactMatches;
      if (right.sectionTypeMatches !== left.sectionTypeMatches) return right.sectionTypeMatches - left.sectionTypeMatches;
      if (right.active !== left.active) return Number(right.active) - Number(left.active);
      return left.filename.localeCompare(right.filename);
    });

  const bestScore = scores[0];
  if (bestScore.exactMatches > 0 || bestScore.sectionTypeMatches > 0) return bestScore.filename;
  if (configFiles[activeFile]) return activeFile;
  return availableFilenames[0] ?? null;
}

// ── Klipper Doc Auto-Loading ───────────────────────────────────────

const KLIPPER_DOC_FILENAME_RE = /(^|[^A-Za-z0-9_-])([A-Za-z0-9][A-Za-z0-9_-]*\.md)(?=$|[^A-Za-z0-9_.-])/g;
const KLIPPER_DOC_REQUEST_RE = /\b(?:can you|could you|would you|please|provide|send|share|paste|show me|include|load|fetch|pull|give me|i need|i would need|i'd need)\b/i;
export const MAX_AUTO_FETCHED_KLIPPER_DOCS = 2;

export function extractRequestedKlipperDocFilenames(content: string): string[] {
  const requestedDocs = new Set<string>();
  const segments = content
    .split(/\r?\n+/)
    .flatMap((line) => line.split(/(?<=[.!?])\s+/))
    .map((segment) => segment.trim())
    .filter(Boolean);
  for (const segment of segments) {
    if (!KLIPPER_DOC_REQUEST_RE.test(segment)) continue;
    for (const match of segment.matchAll(KLIPPER_DOC_FILENAME_RE)) {
      requestedDocs.add(match[2]);
      if (requestedDocs.size >= MAX_AUTO_FETCHED_KLIPPER_DOCS) return Array.from(requestedDocs);
    }
  }
  return Array.from(requestedDocs);
}

export function buildAutoLoadedKlipperDocMessage(documents: Array<{ filename: string; content: string }>): string {
  return [
    'The app automatically fetched the full bundled Klipper markdown document(s) you requested. Answer the user\'s previous request directly now using these documents. Do not ask the user to paste the same documentation again unless you need a different source document.',
    ...documents.map((document) => `Full bundled Klipper document: ${document.filename}\n\n${document.content}`),
  ].join('\n\n---\n\n');
}

// ── Assistant Validation ───────────────────────────────────────────

export const MAX_ASSISTANT_DRAFT_VALIDATION_ATTEMPTS = 3;
export const MAX_ASSISTANT_HINT_USER_MESSAGES = 3;

const RETRY_EXEMPT_DUPLICATE_SECTION_RE = /^Section \[[^\]]+\] (?:can only be defined once(?: across active included config files)?\.|is reused across active included config files\.)(?: Also defined in: .+)?$/;
const RETRY_EXEMPT_SHARED_PIN_RE = /^Pin '.*' is used by multiple sections: .+$/;

export interface AssistantDraftValidationIssueGroup {
  filename: string;
  errors: ValidationError[];
}

export interface AssistantDraftValidationOutcome {
  applicable: boolean;
  blockingIssues: AssistantDraftValidationIssueGroup[];
  failureReason: string | null;
}

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

export function shouldRetryAssistantValidation(
  validationOutcome: AssistantDraftValidationOutcome,
  attemptsUsed: number,
): boolean {
  if (validationOutcome.applicable) {
    if (validationOutcome.blockingIssues.length === 0) return false;
    return !(attemptsUsed > 1 && hasOnlyRetryExemptAssistantValidationIssues(validationOutcome.blockingIssues));
  }
  return attemptsUsed > 1 && Boolean(validationOutcome.failureReason);
}

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
    'Your previous assistant reply included cfg changes that failed the app validation after being merged into the current Klipper config project.',
    'Return a corrected replacement reply that fixes every problem below and still satisfies the user request.',
    'If you return config changes, return only complete changed sections inside fenced cfg code blocks and keep any required "# file: <filename>" hint.',
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
