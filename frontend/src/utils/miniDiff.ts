/**
 * Mini-diff draft protocol for the AI chat feature.
 *
 * When the AI edits an EXISTING config section it may emit a mini-diff
 * instead of reproducing the full section: the section header followed by
 * only the lines that change, with removed lines prefixed by '-' and added
 * lines prefixed by '+' (keeping their original indentation). The app
 * applies these exact replacements to the current file text, so unchanged
 * lines — including Jinja tags inside macros — are preserved automatically
 * and can never be dropped or reworded by the model.
 *
 * Three shapes are supported:
 * - edit: '-' removal line(s) with optional '+' additions below them
 *   (replace matched lines);
 * - delete-only: '-' lines with no additions (lines are removed);
 * - add-only: '+' lines with NO preceding '-' — there is no line to remove,
 *   so the additions are appended at the end of the section (after the last
 *   non-empty line), which is how "add one param / one line" edits work.
 *
 * A cfg block with no '-' AND no '+' lines is treated as a full-section
 * block (the legacy protocol) and passes through untouched.
 */

export const MINI_DIFF_REMOVAL_RE = /^-(.*)$/;
export const MINI_DIFF_ADDITION_RE = /^\+(.*)$/;

export type MiniDiffLineKind = 'removal' | 'addition' | 'context';

/**
 * Classify one line of a mini-diff block for display coloring. Removed ('-')
 * and added ('+') lines render red/green like the app's diff views; section
 * headers and context lines stay neutral.
 */
export function classifyMiniDiffLine(line: string): MiniDiffLineKind {
  if (MINI_DIFF_REMOVAL_RE.test(line)) return 'removal';
  if (MINI_DIFF_ADDITION_RE.test(line)) return 'addition';
  return 'context';
}

/** Header line such as `[gcode_macro Level_Bed]` (may have trailing comment). */
const SECTION_HEADER_RE = /^\s*(\[[^\]]+\])\s*$/;
/** Deletion marker `*[section_name]` — never treat such blocks as mini-diffs. */
const DELETE_MARKER_RE = /^\s*\*\[[^\]]+\]\s*$/;
/** Column-0 param line (`key: value` / `key= value`) — mirrors the parser. */
const PARAM_LINE_RE = /^(\w[\w]*)\s*[:=]/;

/** True when `key` names a multi-line gcode body (parser folds trailing
 * comment lines into its value). */
function isGcodeBodyKey(key: string): boolean {
  return key === 'gcode' || key.endsWith('_gcode');
}

/** Last column-0 param key of a section's lines (null when none is found).
 * Indented continuation lines and comments are skipped. */
function lastSectionParamKey(sectionLines: string[]): string | null {
  for (let index = sectionLines.length - 1; index >= 0; index -= 1) {
    const line = sectionLines[index];
    if (line.trim() === '' || line.startsWith('#')) continue;
    if (line.startsWith('[')) break;
    const paramMatch = PARAM_LINE_RE.exec(line);
    if (paramMatch) return paramMatch[1];
    // Indented continuation or bare text — keep scanning upward.
  }
  return null;
}

/** True when the section's last param is a gcode-like body (the parser folds
 * trailing comment lines into its value). */
function sectionHasGcodeBody(sectionLines: string[]): boolean {
  const key = lastSectionParamKey(sectionLines);
  return key !== null && isGcodeBodyKey(key);
}

/**
 * Find where a section's own content ends in the base file, trimming the
 * trailing column-0 comment block that sits between the last param and the
 * next section header (blank lines before it are kept).
 *
 * Those comment lines belong to the NEXT section: the parser collects them as
 * pending comments and attaches them as the next header's `header_comments`
 * (e.g. the `##########` / `# print_start macro` banner above `[gcode_macro
 * print_start]`). If they stay inside the materialized section, the draft
 * parse carries them back into the merged section and the section-merge
 * re-emits them, DUPLICATING the banner in the review diff after an edit to
 * the preceding section.
 *
 * Sections with a gcode-like body (`gcode:` / `*_gcode:`) are exempt: the
 * parser treats trailing comment lines after the body as part of the
 * multi-line value, so they ARE section content and must be preserved.
 */
function sectionContentEnd(
  baseLines: string[],
  headerIndex: number,
  endIndex: number,
): number {
  // Locate the last non-blank line of the extent.
  let last = endIndex - 1;
  while (last > headerIndex && baseLines[last].trim() === '') last -= 1;
  if (last <= headerIndex) return endIndex;

  // No trailing comment block — keep the whole extent (incl. trailing blanks).
  if (!baseLines[last].startsWith('#')) return endIndex;

  // A trailing comment block could belong to the NEXT section (its
  // header_comments) or to a gcode-like body value.
  if (sectionHasGcodeBody(baseLines.slice(headerIndex, endIndex))) return endIndex;

  // Trim the trailing column-0 comment block; blank lines before it are kept.
  let start = last;
  while (start > headerIndex && baseLines[start].startsWith('#')) start -= 1;
  return start + 1;
}

/** Normalise a line for matching: strip CR and trailing whitespace only. */
function normalizeLine(line: string): string {
  return line.replace(/\r$/, '').trimEnd();
}

/** Leading whitespace (spaces/tabs) of a line — cosmetic in Klipper configs. */
function leadingWhitespace(line: string): string {
  const match = /^[ \t]*/.exec(line);
  return match ? match[0] : '';
}

interface MiniDiffOperation {
  /**
   * The removed line content (without the '-' prefix), or null for an
   * add-only operation with no anchor line (appended at end of section).
   */
  removal: string | null;
  /** Lines to insert in place of the removed line (without '+' prefixes). */
  additions: string[];
}

/** True when the block looks like a mini-diff edit of an existing section. */
export function isMiniDiffBlock(configText: string): boolean {
  const lines = configText.split(/\r?\n/);
  let hasHeader = false;
  let hasMarker = false;
  for (const line of lines) {
    if (DELETE_MARKER_RE.test(line)) return false;
    if (SECTION_HEADER_RE.test(line)) {
      hasHeader = true;
      continue;
    }
    if (MINI_DIFF_REMOVAL_RE.test(line) || MINI_DIFF_ADDITION_RE.test(line)) {
      hasMarker = true;
    }
  }
  return hasHeader && hasMarker;
}

/** Extract the operations for one section header from the block's lines. */
function extractSectionOps(
  lines: string[],
  headerIndex: number,
): MiniDiffOperation[] {
  const ops: MiniDiffOperation[] = [];
  let current: MiniDiffOperation | null = null;

  for (let index = headerIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (SECTION_HEADER_RE.test(line)) break; // next section header

    const removalMatch = MINI_DIFF_REMOVAL_RE.exec(line);
    if (removalMatch) {
      current = { removal: removalMatch[1], additions: [] };
      ops.push(current);
      continue;
    }

    const additionMatch = MINI_DIFF_ADDITION_RE.exec(line);
    if (additionMatch) {
      if (current) {
        current.additions.push(additionMatch[1]);
      } else {
        // '+' with no preceding '-' = add-only operation (no anchor). The
        // additions are appended at the end of the section.
        current = { removal: null, additions: [additionMatch[1]] };
        ops.push(current);
      }
      continue;
    }

    // Non-diff lines (context, comments) are ignored: unchanged lines are
    // preserved from the base file automatically.
  }

  return ops;
}

/**
 * Apply mini-diff operations to the raw text of one section.
 *
 * Returns the reconstructed section lines (from the section header line
 * through the line before the next section), or null when any removal has
 * no exact match in the base section (caller falls back to legacy handling).
 */
function applyOpsToSection(
  sectionLines: string[],
  ops: MiniDiffOperation[],
): string[] | null {
  const base = sectionLines.map((line) => normalizeLine(line));
  const used = new Set<number>();
  const opToIndex = new Map<number, number>(); // op index -> base line index
  const opToIndent = new Map<number, string>(); // op index -> matched base indent
  const appendAdditions: string[] = []; // add-only ops (no anchor line)

  for (let opIndex = 0; opIndex < ops.length; opIndex += 1) {
    const op = ops[opIndex];
    if (op.removal === null) {
      // Add-only: no line to remove — the additions append at the end of the
      // section (after the last non-empty line).
      appendAdditions.push(...op.additions);
      continue;
    }
    const normalizedRemoval = normalizeLine(op.removal);
    let matchIndex = base.findIndex(
      (line, index) => !used.has(index) && line === normalizedRemoval,
    );
    if (matchIndex === -1) {
      // Indentation-tolerant fallback: leading whitespace is cosmetic in
      // Klipper configs, so a draft line indented differently from the file
      // (e.g. 4-space indent emitted for a column-0 [printer] line) must still
      // match. Only leading whitespace is ignored — a real content mismatch
      // still returns null and the caller falls back to legacy handling.
      const strippedRemoval = normalizedRemoval.trimStart();
      matchIndex = base.findIndex(
        (line, index) => !used.has(index) && line.trimStart() === strippedRemoval,
      );
    }
    if (matchIndex === -1) return null;
    used.add(matchIndex);
    opToIndex.set(opIndex, matchIndex);
    opToIndent.set(opIndex, leadingWhitespace(base[matchIndex]));
  }

  const result: string[] = [];
  let lastNonEmptyIndex = -1;
  for (let index = 0; index < sectionLines.length; index += 1) {
    let matchedOpIndex = -1;
    for (const [opIndex, baseIndex] of opToIndex.entries()) {
      if (baseIndex === index) {
        matchedOpIndex = opIndex;
        break;
      }
    }
    if (matchedOpIndex !== -1) {
      const op = ops[matchedOpIndex];
      const baseIndent = opToIndent.get(matchedOpIndex) ?? '';
      const diffIndent = leadingWhitespace(op.removal ?? '');
      const additions = op.additions.map((addition) => {
        // Anchor the addition to the base line's indentation, preserving
        // the relative inner indent of multi-line additions.
        const relativeIndent =
          leadingWhitespace(addition).length - diffIndent.length;
        const pad = relativeIndent > 0 ? ' '.repeat(relativeIndent) : '';
        return baseIndent + pad + normalizeLine(addition).trimStart();
      });
      result.push(...additions);
      for (let a = 0; a < additions.length; a += 1) {
        if (additions[a].trim() !== '') lastNonEmptyIndex = result.length - 1;
      }
      continue;
    }
    result.push(sectionLines[index]);
    if (sectionLines[index].trim() !== '') {
      lastNonEmptyIndex = result.length - 1;
    }
  }

  if (appendAdditions.length > 0) {
    // The '+' marker is followed by the line content; models usually write
    // "+ value" with a separator space (or indent everything 4 spaces). For
    // plain sections that leading whitespace must NOT survive — the parser
    // would fold an indented line into the PREVIOUS param's value as a
    // continuation, corrupting the config (e.g. "+ max_accel: 13000" after
    // "max_accel: 15500" becomes a multiline value). Strip it; gcode-like
    // body lines keep their indent, where the space after '+' is content.
    const isGcodeBody = sectionHasGcodeBody(sectionLines);
    const normalizedAdditions = appendAdditions.map((addition) => {
      const line = normalizeLine(addition);
      return isGcodeBody ? line : line.trimStart();
    });
    // Insert after the last non-empty line, before any trailing blank lines.
    result.splice(lastNonEmptyIndex + 1, 0, ...normalizedAdditions);
  }

  return result;
}

/**
 * Apply a mini-diff cfg block against the current text of its target file.
 *
 * - `configText`: the cfg block content (file hints already stripped by the
 *   caller via extractAssistantFileHint).
 * - `baseFileText`: the current raw text of the file the edit targets.
 *
 * Returns `{ applied: true, text }` with the CHANGED sections materialized in
 * full (unchanged lines — including Jinja tags inside macros — copied
 * verbatim from the base file, only the -/+ edits applied). The output
 * intentionally contains ONLY the edited sections, not the whole file: the
 * downstream section-merge (mergeAssistantSectionsIntoConfig) then touches
 * just those sections, so untouched sections stay byte-identical and the
 * review diff shows only the real change.
 *
 * Returns `{ applied: false }` when the block is not a mini-diff or a
 * removal could not be matched.
 */
export function applyMiniDiffBlock(
  configText: string,
  baseFileText: string,
): { applied: boolean; text: string } {
  if (!isMiniDiffBlock(configText)) {
    return { applied: false, text: configText };
  }

  const blockLines = configText.split(/\r?\n/);
  const baseLines = baseFileText.split(/\r?\n/);
  const outputSections: string[] = [];

  for (let blockIndex = 0; blockIndex < blockLines.length; blockIndex += 1) {
    if (!SECTION_HEADER_RE.test(blockLines[blockIndex])) continue;
    const header = SECTION_HEADER_RE.exec(blockLines[blockIndex])![1];
    const ops = extractSectionOps(blockLines, blockIndex);
    if (ops.length === 0) continue;

    const headerIndex = baseLines.findIndex(
      (baseLine) => SECTION_HEADER_RE.test(baseLine)
        && SECTION_HEADER_RE.exec(baseLine)![1] === header,
    );
    if (headerIndex === -1) continue; // section not in base — fall back

    // Section extent: from the header line to the next section header, then
    // trimmed to the section's own content (trailing comment banners belong
    // to the NEXT section — see sectionContentEnd).
    let endIndex = baseLines.length;
    for (let scan = headerIndex + 1; scan < baseLines.length; scan += 1) {
      if (SECTION_HEADER_RE.test(baseLines[scan])) {
        endIndex = scan;
        break;
      }
    }

    const sectionLines = baseLines.slice(headerIndex, sectionContentEnd(baseLines, headerIndex, endIndex));
    const reconstructed = applyOpsToSection(sectionLines, ops);
    if (!reconstructed) continue;

    outputSections.push(reconstructed.join('\n'));
  }

  if (outputSections.length === 0) {
    return { applied: false, text: configText };
  }
  return { applied: true, text: outputSections.join('\n\n') };
}
