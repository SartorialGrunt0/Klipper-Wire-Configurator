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
 * A cfg block with no '-' lines is treated as a full-section block (the
 * legacy protocol) and passes through untouched.
 */

export const MINI_DIFF_REMOVAL_RE = /^-(.*)$/;
export const MINI_DIFF_ADDITION_RE = /^\+(.*)$/;

/** Header line such as `[gcode_macro Level_Bed]` (may have trailing comment). */
const SECTION_HEADER_RE = /^\s*(\[[^\]]+\])\s*$/;
/** Deletion marker `*[section_name]` — never treat such blocks as mini-diffs. */
const DELETE_MARKER_RE = /^\s*\*\[[^\]]+\]\s*$/;

/** Normalise a line for matching: strip CR and trailing whitespace only. */
function normalizeLine(line: string): string {
  return line.replace(/\r$/, '').trimEnd();
}

interface MiniDiffOperation {
  /** The removed line content (without the '-' prefix). */
  removal: string;
  /** Lines to insert in place of the removed line (without '+' prefixes). */
  additions: string[];
}

/** True when the block looks like a mini-diff edit of an existing section. */
export function isMiniDiffBlock(configText: string): boolean {
  const lines = configText.split(/\r?\n/);
  let hasHeader = false;
  let hasRemoval = false;
  for (const line of lines) {
    if (DELETE_MARKER_RE.test(line)) return false;
    if (SECTION_HEADER_RE.test(line)) {
      hasHeader = true;
      continue;
    }
    if (MINI_DIFF_REMOVAL_RE.test(line)) hasRemoval = true;
  }
  return hasHeader && hasRemoval;
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
      }
      // A '+' with no preceding '-' is ambiguous (no anchor) — ignore it.
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

  for (let opIndex = 0; opIndex < ops.length; opIndex += 1) {
    const normalizedRemoval = normalizeLine(ops[opIndex].removal);
    const matchIndex = base.findIndex(
      (line, index) => !used.has(index) && line === normalizedRemoval,
    );
    if (matchIndex === -1) return null;
    used.add(matchIndex);
    opToIndex.set(opIndex, matchIndex);
  }

  const result: string[] = [];
  for (let index = 0; index < sectionLines.length; index += 1) {
    let matchedOpIndex = -1;
    for (const [opIndex, baseIndex] of opToIndex.entries()) {
      if (baseIndex === index) {
        matchedOpIndex = opIndex;
        break;
      }
    }
    if (matchedOpIndex !== -1) {
      result.push(...ops[matchedOpIndex].additions.map((addition) => addition));
      continue;
    }
    result.push(sectionLines[index]);
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
 * Returns `{ applied: true, text }` with the reconstructed FULL section text
 * (suitable for the normal parse → merge pipeline), or `{ applied: false }`
 * when the block is not a mini-diff or a removal could not be matched.
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

  let output = baseLines;
  let appliedAny = false;

  blockLines.forEach((line, index) => {
    if (!SECTION_HEADER_RE.test(line)) return;
    const header = SECTION_HEADER_RE.exec(line)![1];
    const ops = extractSectionOps(blockLines, index);
    if (ops.length === 0) return;

    const headerIndex = output.findIndex(
      (baseLine) => SECTION_HEADER_RE.test(baseLine)
        && SECTION_HEADER_RE.exec(baseLine)![1] === header,
    );
    if (headerIndex === -1) return; // section not in base — fall back

    // Section extent: from the header line to the next section header.
    let endIndex = output.length;
    for (let scan = headerIndex + 1; scan < output.length; scan += 1) {
      if (SECTION_HEADER_RE.test(output[scan])) {
        endIndex = scan;
        break;
      }
    }

    const sectionLines = output.slice(headerIndex, endIndex);
    const reconstructed = applyOpsToSection(sectionLines, ops);
    if (!reconstructed) return;

    output = [
      ...output.slice(0, headerIndex),
      ...reconstructed,
      ...output.slice(endIndex),
    ];
    appliedAny = true;
  });

  if (!appliedAny) {
    return { applied: false, text: configText };
  }
  return { applied: true, text: output.join('\n') };
}
