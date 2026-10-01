import type { SectionSchema } from '../types/config';

/**
 * Deterministic completion for the text view — no AI, no network.
 *
 * Everything here is pure so the trigger rules can be pinned by tests: the
 * component only supplies the text, the caret and the project's symbols.
 *
 * Sources, in the order they pay off:
 *  - section types  ← the app's own `/api/schema` (SECTION_DEFS)
 *  - param keys / enum values ← the same schema, scoped to the enclosing section
 *  - include paths  ← the project's own filenames
 *  - G-code commands ← the validator's registry (so a suggestion can never be a
 *    command that then fails validation) + the project's macro names
 */

export type CompletionKind =
  | 'section-type'
  | 'param-key'
  | 'param-value'
  | 'include-file'
  | 'gcode-command';

export interface CompletionContext {
  kind: CompletionKind;
  /** Absolute offset the suggestion replaces from. */
  replaceStart: number;
  /** Absolute offset the suggestion replaces to (the caret). */
  replaceEnd: number;
  /** What the user has typed of the token so far. */
  prefix: string;
  /** Section type of the enclosing header, when there is one. */
  sectionType?: string;
  /** Param whose value is being typed (param-value only). */
  paramKey?: string;
  /** Text from the caret to the end of the line — used to avoid doubling a `]`. */
  trailing: string;
}

export interface Candidate {
  label: string;
  insertText: string;
  detail?: string;
  kind: CompletionKind;
  score: number;
  /** Stable order for equal scores. */
  rank: number;
  /** The param's schema default — the one candidate allowed to ghost on an
   *  empty value prefix (you just typed `key: ` and the default is the answer). */
  isDefault?: boolean;
  /** Already defined in this section. Listed (so the full param list stays
   *  browsable) but never ghosted, and ranked last. */
  alreadySet?: boolean;
}

export interface CompletionSources {
  schemas: Record<string, SectionSchema>;
  includePaths: string[];
  macroNames: string[];
  gcodeCommands: string[];
  /** Param keys already present in the enclosing section (ranked last). */
  usedParamKeys?: string[];
  /** Section types the project already defines (single-instance types are
   *  ranked last — adding a second one is rarely what is meant). */
  usedSectionTypes?: string[];
}

const SECTION_HEADER_RE = /^\s*(#?)\s*\[([^\]]*)\]\s*$/;
const OPEN_HEADER_RE = /^\s*#?\s*\[([^\]]*)$/;
const KEY_RE = /^(\s*)(#?)([A-Za-z0-9_][A-Za-z0-9_\-]*)(\s*[:=]\s*)(.*)$/;
const GCODE_BLOCK_KEYS = new Set(['gcode', 'gcode_on_error', 'gcode.py']);
/** Section types whose body is G-code rather than settings. */
const GCODE_SECTION_TYPES = new Set(['gcode_macro', 'delayed_gcode']);

const lineStartOf = (text: string, pos: number): number => text.lastIndexOf('\n', pos - 1) + 1;
const lineEndOf = (text: string, pos: number): number => {
  const nl = text.indexOf('\n', pos);
  return nl === -1 ? text.length : nl;
};

/** The header of the section containing `lineIndex`, or null above the first one. */
function enclosingHeader(lines: string[], lineIndex: number): string | null {
  for (let i = lineIndex; i >= 0; i -= 1) {
    const match = SECTION_HEADER_RE.exec(lines[i]);
    if (match) return match[2].trim();
  }
  return null;
}

/** Section type is the first whitespace-delimited token (`gcode_macro X` → `gcode_macro`). */
export function sectionTypeOf(header: string | null): string | undefined {
  if (!header) return undefined;
  const token = header.trim().split(/\s+/)[0];
  return token ? token.toLowerCase() : undefined;
}

/**
 * True when the caret sits inside a `gcode:` / `gcode_on_error:` block: walk up
 * to the first line with less indentation, and check whether it opens a
 * G-code block.
 */
function insideGcodeBlock(lines: string[], lineIndex: number, currentLine: string): boolean {
  const indentOf = (line: string) => line.length - line.trimStart().length;
  const currentIndent = indentOf(currentLine);
  if (currentIndent === 0) return false;
  for (let i = lineIndex - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line.trim()) continue;
    if (indentOf(line) >= currentIndent) continue;
    const match = /^\s*([A-Za-z0-9_.]+)\s*:/.exec(line);
    return !!match && GCODE_BLOCK_KEYS.has(match[1].toLowerCase());
  }
  return false;
}

/**
 * What, if anything, should be suggested at `caret`? Returns null when the
 * caret is not in a completable position (mid-word in prose, inside Jinja, in a
 * comment, …).
 */
export function detectCompletionContext(text: string, caret: number): CompletionContext | null {
  if (caret < 0 || caret > text.length) return null;
  const lineStart = lineStartOf(text, caret);
  const lineEnd = lineEndOf(text, caret);
  const before = text.slice(lineStart, caret);
  const line = text.slice(lineStart, lineEnd);
  const trailing = line.slice(caret - lineStart);

  // Inside Jinja — a config-text completer has nothing useful to say there.
  const lineUpToCaret = before;
  if (/{%[^%]*$/.test(lineUpToCaret) || /{[^{]*$/.test(lineUpToCaret)) return null;

  // `[` … caret before the closing `]` → a section header (or an include path).
  const openHeader = OPEN_HEADER_RE.exec(lineUpToCaret);
  if (openHeader && !before.slice(before.indexOf('[')).includes(']')) {
    const inside = openHeader[1];
    if (/^include\s/i.test(inside)) {
      const prefix = inside.replace(/^include\s+/i, '');
      return {
        kind: 'include-file',
        replaceStart: caret - prefix.length,
        replaceEnd: caret,
        prefix,
        trailing,
      };
    }
    // A comment marker or a space before the name is not part of the token.
    const prefix = inside.replace(/^\s+/, '');
    return {
      kind: 'section-type',
      replaceStart: caret - prefix.length,
      replaceEnd: caret,
      prefix,
      trailing,
    };
  }

  const lines = text.split('\n');
  const lineIndex = text.slice(0, lineStart).split('\n').length - 1;
  const header = enclosingHeader(lines, lineIndex);
  const sectionType = sectionTypeOf(header);

  // Inside a `gcode:` block: complete command names once the token has started.
  if (sectionType && GCODE_SECTION_TYPES.has(sectionType) && insideGcodeBlock(lines, lineIndex, line)) {
    const token = /^(\s*)([A-Za-z0-9_]*)$/.exec(before);
    if (token) {
      return {
        kind: 'gcode-command',
        replaceStart: caret - token[2].length,
        replaceEnd: caret,
        prefix: token[2],
        sectionType,
        trailing,
      };
    }
    return null;
  }

  // Inside a comment there is nothing to complete: the text is inert, and a
  // suggestion there reads as if the commented line were live config.
  if (/^\s*#/.test(lineUpToCaret)) return null;

  // `key: <caret>` → value completion (enums only; the source decides).
  const withValue = KEY_RE.exec(lineUpToCaret);
  const valueStart =
    withValue === null
      ? -1
      : withValue[1].length + withValue[2].length + withValue[3].length + withValue[4].length;
  if (
    withValue &&
    sectionType &&
    withValue[2] !== '#' &&
    caret - lineStart >= valueStart &&
    // Only the value token: after the first space the value is already written.
    !withValue[5].includes(' ')
  ) {
    const typed = withValue[5];
    return {
      kind: 'param-value',
      replaceStart: caret - typed.length,
      replaceEnd: caret,
      prefix: typed,
      sectionType,
      paramKey: withValue[3],
      trailing,
    };
  }

  // Start of a line inside a section → a parameter key.
  const keyToken = /^(\s*)(#?)([A-Za-z0-9_\-]*)$/.exec(lineUpToCaret);
  if (keyToken && sectionType && header) {
    const prefix = keyToken[3];
    return {
      kind: 'param-key',
      replaceStart: caret - prefix.length,
      replaceEnd: caret,
      prefix,
      sectionType,
      trailing,
    };
  }

  return null;
}

/** Match quality: exact > starts-with > word-boundary > substring. */
export function matchScore(label: string, prefix: string): number {
  if (!prefix) return 60;
  const lowerLabel = label.toLowerCase();
  const lowerPrefix = prefix.toLowerCase();
  if (lowerLabel === lowerPrefix) return 100;
  if (lowerLabel.startsWith(lowerPrefix)) return 80;
  const boundary = lowerLabel.split(/[\s_\-.]/).some((word) => word.startsWith(lowerPrefix));
  if (boundary) return 60;
  if (lowerLabel.includes(lowerPrefix)) return 40;
  return 0;
}

/** Keeps only matches and orders them deterministically. */
export function rankCandidates(candidates: readonly Candidate[], prefix: string): Candidate[] {
  const scored: Candidate[] = [];
  for (const candidate of candidates) {
    const score = matchScore(candidate.label, prefix);
    if (score === 0) continue;
    // `candidate.rank` is the SOURCE order (project macros before registry
    // commands, already-used params last) and must survive scoring.
    scored.push({ ...candidate, score });
  }
  return scored.sort((a, b) => b.score - a.score || a.rank - b.rank || a.label.localeCompare(b.label));
}

function paramDetail(schema: SectionSchema, name: string): string | undefined {
  const param = schema.params.find((p) => p.name === name);
  if (!param) return undefined;
  const bits: string[] = [param.type];
  if (param.required) bits.push('required');
  if (param.default) bits.push(`default ${param.default}`);
  if (param.unit) bits.push(param.unit);
  if (param.description) bits.push(param.description);
  return bits.join(' · ');
}

/** Candidate list for a context — the only place the sources are consulted. */
export function candidatesFor(
  context: CompletionContext,
  sources: CompletionSources,
): Candidate[] {
  const close = (name: string, closing: string) =>
    context.trailing.startsWith(closing) ? name : `${name}${closing}`;

  switch (context.kind) {
    case 'section-type': {
      // Ties break on SECTION_DEFS order (curated: stepper_x before stepper_a,
      // not alphabetical), with types the project already defines pushed to the
      // back — adding a second [stepper_x] is rarely the intent. This must key
      // off the PROJECT's sections, not the schema map: keying off the schema
      // made every type look used and collapsed the order to alphabetical.
      const used = new Set(sources.usedSectionTypes ?? []);
      return Object.values(sources.schemas).map((schema, index) => ({
        label: schema.display_name || schema.section_type,
        // Insert the real header text (the display name is for reading).
        insertText: close(schema.section_type, ']'),
        detail: [schema.description, schema.max_instances === 1 ? 'one per project' : null]
          .filter(Boolean)
          .join(' · '),
        kind: 'section-type' as const,
        score: 0,
        rank: (used.has(schema.section_type) ? 1000 : 0) + index,
      }));
    }

    case 'include-file':
      return sources.includePaths.map((path) => ({
        label: path,
        insertText: close(path, ']'),
        kind: 'include-file' as const,
        score: 0,
        rank: 0,
      }));

    case 'param-key': {
      const schema = context.sectionType ? sources.schemas[context.sectionType] : undefined;
      if (!schema) return [];
      // Already-defined params stay in the list (the full param list is worth
      // browsing) but are marked and ranked last, and the ghost never uses them.
      const already = new Set(sources.usedParamKeys ?? []);
      return schema.params.map((param) => ({
        label: param.name,
        insertText: context.trailing.startsWith(':') ? param.name : `${param.name}: `,
        detail: [paramDetail(schema, param.name), already.has(param.name) ? 'already set' : null]
          .filter(Boolean)
          .join(' · '),
        kind: 'param-key' as const,
        score: 0,
        rank: already.has(param.name) ? 1000 : 0,
        alreadySet: already.has(param.name),
      }));
    }

    case 'param-value': {
      const schema = context.sectionType ? sources.schemas[context.sectionType] : undefined;
      const param = schema?.params.find((p) => p.name === context.paramKey);
      if (!param) return [];

      const candidates: Candidate[] = [];
      const defaultValue = (param.default ?? '').trim();
      if (defaultValue) {
        candidates.push({
          label: defaultValue,
          insertText: defaultValue,
          detail: ['default', param.description].filter(Boolean).join(' · '),
          kind: 'param-value',
          score: 0,
          rank: 0,
          isDefault: true,
        });
      }
      for (const value of param.enum_values) {
        if (value === defaultValue) continue;
        candidates.push({
          label: value,
          insertText: value,
          detail: param.description,
          kind: 'param-value',
          score: 0,
          rank: 1,
        });
      }
      return candidates;
    }

    case 'gcode-command': {
      // The project's own macros first: calling them is the common case.
      const macros = sources.macroNames.map((name, index) => ({
        label: name,
        insertText: name,
        detail: 'gcode_macro in this project',
        kind: 'gcode-command' as const,
        score: 0,
        rank: index,
      }));
      const commands = sources.gcodeCommands.map((name) => ({
        label: name,
        insertText: name,
        kind: 'gcode-command' as const,
        score: 0,
        rank: 1000,
      }));
      return [...macros, ...commands];
    }

    default:
      return [];
  }
}

/**
 * True when nothing follows the caret on its line — the only case where the
 * right arrow has no text to move over, which is what makes it safe to accept
 * a suggestion with.
 */
export function caretAtLineEnd(text: string, caret: number): boolean {
  return caret >= lineEndOf(text, caret);
}

/** One call from the component: context → ranked suggestions. */
export function completionsAt(
  text: string,
  caret: number,
  sources: CompletionSources,
): { context: CompletionContext; candidates: Candidate[] } | null {
  const context = detectCompletionContext(text, caret);
  if (!context) return null;
  const candidates = rankCandidates(candidatesFor(context, sources), context.prefix);
  if (candidates.length === 0) return null;
  return { context, candidates: candidates.slice(0, 50) };
}

/** The text edit accepting a candidate produces. */
export function applyCandidate(
  text: string,
  context: CompletionContext,
  candidate: Candidate,
): { text: string; caret: number } {
  const next = text.slice(0, context.replaceStart) + candidate.insertText + text.slice(context.replaceEnd);
  return { text: next, caret: context.replaceStart + candidate.insertText.length };
}
