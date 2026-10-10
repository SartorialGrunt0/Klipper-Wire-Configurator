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
 *
 * ## The token model (why the caret is not part of the context)
 *
 * A suggestion completes **the identifier the caret is in**, so what the user has
 * typed is the whole token in the buffer — not the characters to the left of the
 * caret. Keying the context to the caret is what made an earlier revision
 * (`adeebf9`) stay silent anywhere but the end of a line: with `prefix` =
 * "text before the caret", a mid-token caret produced a *fragment* prefix, and
 * accepting that fragment splices the rest of the token back on
 * (`max_vel|ocity` → `max_velocity: ocity`).
 *
 * Anchoring to the token instead gives all four cases one answer:
 *
 *   `mi|c`      prefix `mic`,  replacement `mic`,   ghost drawn at the token end
 *   `mic|`      prefix `mic`,  replacement `mic`,   ghost drawn at the token end
 *   `mic| ; x`  prefix `mic`,  replacement `mic`,   ghost still offered (arrow moves)
 *   `` (empty)  no ghost, except a value's schema default
 *
 * Because the replacement always covers the whole token, accepting can never
 * splice, whatever the caret does. Display and acceptance stay separate
 * decisions: the ghost shows whenever a token is being typed, and the accept key
 * fires only when the caret sits at the token end with nothing after it on the
 * line — the rule zsh-autosuggestions states as "with the cursor at the end of
 * the buffer".
 */

export type CompletionKind =
  | 'section-type'
  | 'param-key'
  | 'param-value'
  | 'include-file'
  | 'gcode-command';

export interface CompletionContext {
  kind: CompletionKind;
  /** Absolute offset the suggestion replaces from (the token start). */
  replaceStart: number;
  /** Absolute offset the suggestion replaces to (the token end). */
  replaceEnd: number;
  /** What the user has typed of the token so far — the WHOLE token. */
  prefix: string;
  /** Section type of the enclosing header, when there is one. */
  sectionType?: string;
  /** Param whose value is being typed (param-value only). */
  paramKey?: string;
  /** Text from the token end to the end of the line — used to avoid doubling a
   *  `]` or a `: `. Computed from the token, never from the caret. */
  trailing: string;
  /** Absolute offset just past the token: where the ghost is drawn. */
  tokenEnd: number;
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
  /** An inline suggestion may extend this candidate (case-insensitive prefix
   *  match only). Weaker matches are list-only: they are *replacements*, and the
   *  ghost is an insertion at the token end. */
  ghostable?: boolean;
  /** Text to match against when it differs from the label — a section's display
   *  name is `Stepper X` while the header that gets inserted is `stepper_x`. */
  matchText?: string;
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

/** Token characters, per position — an identifier, a path, a command, a value. */
const IDENT_CHARS = /[A-Za-z0-9_\-]/;
const PATH_CHARS = /[A-Za-z0-9_\-/.]/;
const COMMAND_CHARS = /[A-Za-z0-9_]/;
const VALUE_CHARS = /[^\s]/;

const lineStartOf = (text: string, pos: number): number => text.lastIndexOf('\n', pos - 1) + 1;
const lineEndOf = (text: string, pos: number): number => {
  const nl = text.indexOf('\n', pos);
  return nl === -1 ? text.length : nl;
};

/** Bounds of the run of token characters touching `rel` in `line` (line-relative). */
function tokenBounds(
  line: string,
  rel: number,
  isTokenChar: (ch: string) => boolean,
): { start: number; end: number } {
  const at = Math.max(0, Math.min(rel, line.length));
  let start = at;
  let end = at;
  while (start > 0 && isTokenChar(line[start - 1])) start -= 1;
  while (end < line.length && isTokenChar(line[end])) end += 1;
  return { start, end };
}

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
  const caretRel = caret - lineStart;

  /** Assemble a context for the token touching the caret on this line. */
  const contextFor = (
    kind: CompletionKind,
    isTokenChar: (ch: string) => boolean,
    minStartRel: number,
    extra?: { sectionType?: string; paramKey?: string },
  ): CompletionContext | null => {
    const bounds = tokenBounds(line, caretRel, isTokenChar);
    if (bounds.end < minStartRel) return null;
    const start = Math.max(bounds.start, minStartRel);
    const end = Math.max(bounds.end, start);
    return {
      kind,
      replaceStart: lineStart + start,
      replaceEnd: lineStart + end,
      prefix: line.slice(start, end),
      trailing: line.slice(end),
      tokenEnd: lineStart + end,
      ...extra,
    };
  };

  // Inside Jinja — a config-text completer has nothing useful to say there.
  if (/{%[^%]*$/.test(before) || /{[^{]*$/.test(before)) return null;

  // `[` … caret before the closing `]` → a section header (or an include path).
  const openHeader = OPEN_HEADER_RE.exec(before);
  if (openHeader && !before.slice(before.indexOf('[')).includes(']')) {
    const bracketRel = line.indexOf('[');
    const insideStartRel = bracketRel + 1;
    const insideText = line.slice(insideStartRel);
    const include = /^include\s+/i.exec(insideText);
    if (include && caretRel >= insideStartRel + include[0].length) {
      return contextFor('include-file', (ch) => PATH_CHARS.test(ch), insideStartRel + include[0].length);
    }
    // A space before the name is not part of the token.
    const leading = /^\s*/.exec(insideText)?.[0].length ?? 0;
    return contextFor('section-type', (ch) => IDENT_CHARS.test(ch), insideStartRel + leading);
  }

  const lines = text.split('\n');
  const lineIndex = text.slice(0, lineStart).split('\n').length - 1;
  const header = enclosingHeader(lines, lineIndex);
  const sectionType = sectionTypeOf(header);

  // Inside a `gcode:` block: complete command names when the token opens the line.
  if (sectionType && GCODE_SECTION_TYPES.has(sectionType) && insideGcodeBlock(lines, lineIndex, line)) {
    const command = contextFor('gcode-command', (ch) => COMMAND_CHARS.test(ch), 0, { sectionType });
    if (command && /^\s*$/.test(line.slice(0, command.replaceStart - lineStart))) return command;
    return null;
  }

  // Inside a comment there is nothing to complete: the text is inert, and a
  // suggestion there reads as if the commented line were live config.
  if (/^\s*#/.test(before)) return null;

  // Above the first section there is no schema to complete against.
  if (!sectionType || !header) return null;

  // `key: value` → the key token, or the first word of the value.
  const keyMatch = KEY_RE.exec(line);
  if (keyMatch && keyMatch[2] !== '#') {
    const keyStartRel = keyMatch[1].length + keyMatch[2].length;
    const keyEndRel = keyStartRel + keyMatch[3].length;
    const valueStartRel = keyEndRel + keyMatch[4].length;
    if (caretRel >= keyStartRel && caretRel <= keyEndRel) {
      return contextFor('param-key', (ch) => IDENT_CHARS.test(ch), keyStartRel, { sectionType });
    }
    if (caretRel >= valueStartRel) {
      // Only the first word of the value: past a space the rest is already
      // written (enum values read `NTC 100K …`, so a second word is noise).
      const bounds = tokenBounds(line, caretRel, (ch) => VALUE_CHARS.test(ch));
      if (Math.max(bounds.start, valueStartRel) !== valueStartRel) return null;
      return contextFor('param-value', (ch) => VALUE_CHARS.test(ch), valueStartRel, {
        sectionType,
        paramKey: keyMatch[3],
      });
    }
  }

  // A bare key token opening a line inside a section (`mic` with no `:` yet).
  const bare = tokenBounds(line, caretRel, (ch) => IDENT_CHARS.test(ch));
  if (/^\s*$/.test(line.slice(0, bare.start))) {
    return contextFor('param-key', (ch) => IDENT_CHARS.test(ch), 0, { sectionType });
  }

  return null;
}

/**
 * Match quality: exact > prefix > word-boundary > substring.
 *
 * Only `exact` and `prefix` are ghostable (see `Candidate.ghostable`). The two
 * weaker tiers demand at least two typed characters: a single letter is a
 * prefix or it is nothing — one character appears *inside* most identifiers
 * (`r` in canbus_inte`r`face), and offering those is what made typing `r` under
 * `[mcu]` propose an unrelated param.
 */
export function matchScore(label: string, prefix: string): number {
  if (!prefix) return 60;
  const lowerLabel = label.toLowerCase();
  const lowerPrefix = prefix.toLowerCase();
  if (lowerLabel === lowerPrefix) return 100;
  if (lowerLabel.startsWith(lowerPrefix)) return 80;
  if (lowerPrefix.length < 2) return 0;
  const boundary = lowerLabel.split(/[\s_\-.]/).some((word) => word.startsWith(lowerPrefix));
  if (boundary) return 60;
  if (lowerLabel.includes(lowerPrefix)) return 40;
  return 0;
}

/** Keeps only matches and orders them deterministically. */
export function rankCandidates(candidates: readonly Candidate[], prefix: string): Candidate[] {
  const scored: Candidate[] = [];
  for (const candidate of candidates) {
    const score = Math.max(
      matchScore(candidate.label, prefix),
      candidate.matchText ? matchScore(candidate.matchText, prefix) : 0,
    );
    if (score === 0) continue;
    // `candidate.rank` is the SOURCE order (project macros before registry
    // commands, already-used params last) and must survive scoring.
    scored.push({ ...candidate, score, ghostable: score >= 80 });
  }
  return scored.sort((a, b) => b.score - a.score || a.rank - b.rank || a.label.localeCompare(b.label));
}

/** The text a candidate adds after `prefix` — never assumes the match was a prefix. */
export function ghostRemainder(insertText: string, prefix: string): string {
  const limit = Math.min(insertText.length, prefix.length);
  let i = 0;
  while (i < limit && insertText[i].toLowerCase() === prefix[i].toLowerCase()) i += 1;
  return insertText.slice(i);
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
        // Match on the header text too: the display name is `Stepper X`, so a
        // typed `stepper_` would otherwise drop the candidate.
        matchText: schema.section_type,
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

export interface CompletionResult {
  context: CompletionContext;
  candidates: Candidate[];
  /** The candidate the inline ghost draws, if any. */
  ghost: Candidate | null;
  /** What the ghost adds at the token end ('' when there is nothing to add). */
  ghostText: string;
  /** True when the accept key should complete rather than move the caret. */
  accepts: boolean;
  /** Where `ghost` sits in `candidates` — the list's initial selection. */
  index: number;
}

/**
 * The candidate the inline ghost draws.
 *
 * Never one the enclosing section already defines, and on an empty token only a
 * value's schema default — an empty token would otherwise propose the first
 * entry of the list on every blank line.
 */
function ghostCandidateFor(context: CompletionContext, candidates: Candidate[]): Candidate | null {
  const usable = candidates.filter((candidate) => !candidate.alreadySet);
  if (context.prefix === '') return usable.find((candidate) => candidate.isDefault) ?? null;
  return usable.find((candidate) => candidate.ghostable) ?? null;
}

/** True when nothing but spaces follows the token on its line. */
function nothingAfterToken(context: CompletionContext): boolean {
  return context.trailing.trim() === '';
}

/**
 * One call from the component: context → ranked suggestions.
 *
 * The ghost is offered whenever the caret is in or at the end of the token being
 * typed; the right arrow separately requires the caret to sit exactly at the
 * token end with nothing after it on the line, so the arrow never swallows a
 * normal cursor move.
 */
export function completionsAt(
  text: string,
  caret: number,
  sources: CompletionSources,
): CompletionResult | null {
  const context = detectCompletionContext(text, caret);
  if (!context) return null;
  if (caret < context.replaceStart || caret > context.tokenEnd) return null;
  const candidates = rankCandidates(candidatesFor(context, sources), context.prefix);
  if (candidates.length === 0) return null;
  const ghost = ghostCandidateFor(context, candidates);
  const ghostText = ghost ? ghostRemainder(ghost.insertText, context.prefix) : '';
  const accepts =
    !!ghost &&
    ghostText !== '' &&
    caret === context.tokenEnd &&
    nothingAfterToken(context);
  return {
    context,
    candidates: candidates.slice(0, 50),
    ghost,
    ghostText,
    accepts,
    index: ghost ? Math.max(0, candidates.indexOf(ghost)) : 0,
  };
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

/**
 * What the accept key produces at `caret`, or null when it is a plain cursor
 * move. Computed on demand rather than read from component state: after
 * accepting a param the caret lands after `key: `, and the next press must see
 * the value suggestion without a keystroke or a re-render in between.
 */
export function acceptAt(
  text: string,
  caret: number,
  sources: CompletionSources,
): { text: string; caret: number } | null {
  const result = completionsAt(text, caret, sources);
  if (!result || !result.accepts || !result.ghost) return null;
  return applyCandidate(text, result.context, result.ghost);
}
