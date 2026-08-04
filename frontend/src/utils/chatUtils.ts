/**
 * Shared utility functions and constants for the AI Chat feature.
 *
 * Pure functions — no React state or hooks.
 *
 * Phase 3 cleanup: the provider config, printer-memory, and draft
 * validation groups moved to dedicated modules:
 *   - chatProviders.ts
 *   - printerMemory.ts
 *   - draftValidation.ts
 */
import type { ConfigFile, ConfigSection } from '../types/config';

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

/**
 * Build a compact section-index context message for a config file whose
 * content is intentionally NOT attached (Phase 4 lean questions). The model
 * uses the index to decide which sections to fetch via read_user_config.
 */
export function buildConfigIndexMessage(filename: string, headers: string[], label: string): string {
  const headerList = headers.length > 0 ? headers.map((h) => `[${h}]`).join('\n') : '(no sections detected)';
  return (
    `${label}: ${filename} — section index (file content not attached)\n\n`
    + '```cfg\n'
    + headerList
    + '\n```\n\n'
    + `The file content is NOT included above. To answer accurately, call `
    + `read_user_config with filename='${filename}' and the section you need, `
    + `e.g. read_user_config(filename='${filename}', section='bed_mesh').`
  );
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

// ── Config Separator Normalisation ─────────────────────────────────

/**
 * Rewrite `key = value` parameter assignments to `key: value` inside
 * fenced cfg code blocks.
 *
 * Deterministic post-processing that replaces the previous AI re-query
 * (which asked the model to rewrite its own reply). Only touches lines
 * that look like a Klipper parameter assignment (`name = value` at line
 * start, optionally commented), leaving gcode, Jinja expressions, and
 * prose untouched.
 */
export function rewriteConfigEqualsSeparators(content: string): string {
  const codeBlockPattern = /```([^\n`]*)\n([\s\S]*?)```/g;
  return content.replace(codeBlockPattern, (whole, language: string, block: string) => {
    if (!CONFIG_CODE_LANGUAGES.has(language.trim().toLowerCase())) {
      return whole;
    }
    const rewritten = block
      .split(/\r?\n/)
      .map((line) => line.replace(
        /^(\s*)(#?\s*[A-Za-z0-9_][A-Za-z0-9_-]*)\s*=\s*(.*)$/,
        (_match, indent: string, name: string, value: string) => `${indent}${name}: ${value}`,
      ))
      .join('\n');
    return `\`\`\`${language}\n${rewritten}\`\`\``;
  });
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
  // Build lookup: exact filename (case-insensitive) + basename (without path prefix).
  // This lets hints like "printer.cfg" match loaded files with path prefixes
  // like "trident_backup/printer.cfg" or "config/printer.cfg".
  const availableByLower = new Map<string, string>();
  for (const filename of availableFilenames) {
    const lower = filename.toLowerCase();
    availableByLower.set(lower, filename);
    // Also map the bare basename so "printer.cfg" matches "path/to/printer.cfg"
    const base = filename.replace(/^.*[\\/]/, '').toLowerCase();
    if (base && base !== lower) {
      // Only set if not already taken by an exact match
      if (!availableByLower.has(base)) {
        availableByLower.set(base, filename);
      }
    }
  }

  const lines = configBlock.split(/\r?\n/);
  let fileHint: string | null = null;
  let fileHintLineIndex = -1;

  // Scan ALL lines for file hints — the first non-empty line might be a
  // delete marker (*[section]) or explanatory text, so we can't stop early.
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    if (!trimmed) continue;
    const hintMatch = ASSISTANT_FILE_HINT_RE.exec(trimmed);
    if (hintMatch) {
      const rawName = hintMatch[1].trim();
      fileHint = availableByLower.get(rawName.toLowerCase()) ?? rawName;
      fileHintLineIndex = index;
      break;
    }
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

/** Strip path prefix, returning just the basename. */
function basename(filename: string): string {
  return filename.replace(/^.*[\\/]/, '');
}

/** Find an available config key by exact name or basename fallback. */
function resolveFilename(hint: string, configFiles: Record<string, ConfigFile>): string | null {
  if (configFiles[hint]) return hint;
  const hintBase = basename(hint).toLowerCase();
  for (const key of Object.keys(configFiles)) {
    if (basename(key).toLowerCase() === hintBase) return key;
  }
  return null;
}

export function resolveAssistantTargetFile(
  assistantConfig: ConfigFile,
  configFiles: Record<string, ConfigFile>,
  activeFile: string,
  hintedFilenames: string[],
): string | null {
  const availableFilenames = Object.keys(configFiles);
  const uniqueHints = Array.from(new Set(hintedFilenames));

  // If the AI explicitly named a single target file, resolve it to an
  // actual loaded filename (handles path-prefixed keys like
  // "trident_backup/printer.cfg" matching hint "printer.cfg").
  if (uniqueHints.length === 1) {
    return resolveFilename(uniqueHints[0], configFiles) ?? uniqueHints[0];
  }

  // If no files are loaded and no single hint, we can't resolve a target.
  if (availableFilenames.length === 0) return null;

  // Multiple hints — narrow to those that exist in the project (exact or basename match).
  const existingHints = uniqueHints.filter(
    (filename) => resolveFilename(filename, configFiles) != null,
  ).map((filename) => resolveFilename(filename, configFiles)!);
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

// ── String / Text Helpers ──────────────────────────────────────────
