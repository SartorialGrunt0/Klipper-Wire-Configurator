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
 * Markers are matched with leading-whitespace tolerance (`^\s*`): models
 * sometimes indent the '-'/'+' to align with a gcode body indentation. The
 * content AFTER the marker keeps its own indentation and is matched
 * indent-tolerantly against the base file.
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

export const MINI_DIFF_REMOVAL_RE = /^\s*-(.*)$/;
export const MINI_DIFF_ADDITION_RE = /^\s*\+(.*)$/;

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

/** Param key of a param-shaped line, else null. G-code command lines,
 * jinja tags, and comments never match (see the key-tolerant fallback in
 * applyOpsToSection). */
function paramKey(line: string): string | null {
  return PARAM_LINE_RE.exec(line)?.[1] ?? null;
}

/** Config-file hint line such as `# file: printer.cfg`. */
const FILE_HINT_RE = /^\s*[#;]\s*file\s*:/i;

/**
 * Display-only guard: wrap UNFENCED mini-diff text in a ```cfg fence so it
 * renders as a diff block instead of markdown bullets.
 *
 * GFM treats any line starting with `- ` or `+ ` as a list marker, so when a
 * model emits a mini-diff without code fences the +/- lines render as bullet
 * points. The apply pipeline is unaffected (it reads the raw text before
 * markdown rendering), but the user-facing chat shows bullets. This helper
 * finds the diff-shaped run inside the content and fences just that run,
 * leaving prose and already-fenced blocks untouched.
 *
 * Safe by construction: a run is only wrapped when it contains BOTH a section
 * header AND a +/- marker (the same criterion as `isMiniDiffBlock`), so an
 * ordinary bulleted list ("- first\n- second") is never touched.
 */
export function fenceUnfencedMiniDiffs(content: string): string {
  const lines = content.split(/\r?\n/);
  const out: string[] = [];
  let inFence = false;
  let run: string[] = [];

  const flushRun = () => {
    if (run.length === 0) return;
    const text = run.join('\n');
    if (isMiniDiffBlock(text)) {
      out.push('```cfg');
      out.push(text);
      out.push('```');
    } else {
      out.push(...run);
    }
    run = [];
  };

  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      flushRun();
      inFence = !inFence;
      out.push(line);
      continue;
    }
    if (inFence) {
      out.push(line);
      continue;
    }

    // Not inside a fence: accumulate a candidate run from a config hint or
    // section header, plus any following +/- markers. Anything else ends it.
    const isHint = FILE_HINT_RE.test(line) || SECTION_HEADER_RE.test(line);
    const isMarker = MINI_DIFF_REMOVAL_RE.test(line) || MINI_DIFF_ADDITION_RE.test(line);
    if (isHint) {
      // Hints/markers accumulate in one run (`# file:` + `[section]` + +/-
      // lines all belong to the same block); prose or a fence flushes it.
      run.push(line);
      continue;
    }
    if (isMarker) {
      if (run.length > 0) {
        run.push(line);
      } else {
        // Bare marker with no preceding header — a real bullet list, keep it.
        out.push(line);
      }
      continue;
    }
    flushRun();
    out.push(line);
  }
  flushRun();

  return out.join('\n');
}

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

// The apply path (stripMiniDiffMarkers / applyMiniDiffBlock and their
// helpers) was deleted with the prose edit path in the Phase-4 ratchet
// (2026-09-22). What remains is the DISPLAY layer: models still paste
// fenced cfg text, and ChatMessageList colour-codes '-'/'+' lines.
