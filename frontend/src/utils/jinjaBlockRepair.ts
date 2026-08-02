/**
 * Deterministic repair of trailing unclosed Jinja blocks in gcode_macro /
 * delayed_gcode bodies.
 *
 * Phase 4 safety net: models that rewrite a macro from a semantic summary
 * sometimes drop the closing `{% endif %}` / `{% endfor %}`. For an
 * "unexpected end of template" failure the ONLY valid completion position is
 * the end of the gcode body (the block ran to EOF), so the missing closers
 * can be appended deterministically — no model retry needed.
 *
 * This is a PIPELINE repair step, deliberately separate from the
 * Klipper-faithful validator (validator.py): the validator must keep
 * reporting the error byte-identically to Klippy; this module fixes the
 * draft BEFORE it reaches the validator.
 */

// ── Jinja block map ─────────────────────────────────────────────────

/** opener tag name -> required closer tag name. */
export const JINJA_CLOSER_BY_OPENER: Record<string, string> = {
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

/** Tag names that open a block (see JINJA_CLOSER_BY_OPENER). */
const JINJA_OPENERS = new Set(Object.keys(JINJA_CLOSER_BY_OPENER));

/** `{% ... %}` tag extraction — captures the tag name. */
const JINJA_TAG_RE = /\{%\s*([a-zA-Z_]+)/g;

/** Section header line like `[gcode_macro Level_Bed]` (may have trailing spaces). */
const SECTION_HEADER_RE = /^\s*\[([^\]]+)\]\s*$/;

/** `gcode:` / `gcode =` param start line (allows a trailing comment). */
const GCODE_PARAM_RE = /^\s*gcode\s*[:=]\s*(#.*)?$/;

/** A line that starts a NEW config param (`key:` / `key =`). */
const PARAM_KEY_RE = /^\s*[A-Za-z0-9_][A-Za-z0-9_.-]*\s*[:=]/;

/** Section types whose gcode bodies are Jinja templates evaluated by Klipper. */
const MACRO_SECTION_PREFIXES = ['gcode_macro ', 'delayed_gcode '];

// ── Comment stripping (mirrors backend validator.py _strip_inline_comments) ──

/**
 * Mirror Klipper's config parsing for ONE line so the block scan sees the
 * same text jinja2 receives: `#` strips unconditionally; `;` strips only
 * when preceded by whitespace or at line start (kept on the line, like
 * Klipper's inline_comment_prefixes handling).
 */
export function stripInlineComment(line: string): string {
  const hashPos = line.indexOf('#');
  if (hashPos >= 0) {
    line = line.slice(0, hashPos);
  }
  const semiMatch = /(^|\s);/.exec(line);
  if (semiMatch) {
    line = line.slice(0, semiMatch.index + semiMatch[1].length + 1);
  }
  return line;
}

// ── Block scanner ───────────────────────────────────────────────────

interface UnclosedBlock {
  opener: string;
  /** Leading whitespace of the opening tag's line (closers align to it). */
  indent: string;
}

/**
 * Scan a gcode body (comment-stripped per line) and return the blocks still
 * open at EOF, in open order (outermost first), with the indent of each
 * opener's line. Handles `{% else %}` / `{% elif %}` (no push/pop) and
 * `{% raw %}` blocks (inner tags are literal until `{% endraw %}`).
 */
export function findUnclosedJinjaBlocksDetailed(body: string): UnclosedBlock[] {
  const stack: UnclosedBlock[] = [];
  for (const rawLine of body.split('\n')) {
    const line = stripInlineComment(rawLine);
    JINJA_TAG_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = JINJA_TAG_RE.exec(line)) !== null) {
      const tag = match[1];
      // Inside an unclosed raw block, everything except endraw is literal.
      if (stack.length > 0 && stack[stack.length - 1].opener === 'raw') {
        if (tag === 'endraw') {
          stack.pop();
        }
        continue;
      }
      if (JINJA_OPENERS.has(tag)) {
        const indent = /^\s*/.exec(line)?.[0] ?? '';
        stack.push({ opener: tag, indent });
      } else if (tag === 'elif' || tag === 'else') {
        // Non-block tags — no stack change.
      } else if (tag.startsWith('end')) {
        const opener = tag.slice(3);
        if (stack.length > 0 && stack[stack.length - 1].opener === opener) {
          stack.pop();
        }
      }
    }
  }
  return stack;
}

/**
 * Scan a gcode body and return the names of blocks still open at EOF, in
 * open order (outermost first).
 */
export function findUnclosedJinjaBlocks(body: string): string[] {
  return findUnclosedJinjaBlocksDetailed(body).map((block) => block.opener);
}

/**
 * Append the missing closers for unclosed blocks at the end of a gcode body.
 * Closers are appended innermost-first, each aligned to its own opener's
 * indentation, each on its own line. Returns null when the body is already
 * balanced.
 */
export function repairUnclosedJinjaBlock(body: string): { repaired: string; added: string[] } | null {
  const unclosed = findUnclosedJinjaBlocksDetailed(body);
  if (unclosed.length === 0) {
    return null;
  }
  const added: string[] = [];
  // Close innermost first: reverse of open order.
  for (const block of [...unclosed].reverse()) {
    const closer = JINJA_CLOSER_BY_OPENER[block.opener];
    if (!closer) continue;
    added.push(`${block.indent}{% ${closer} %}`);
  }
  if (added.length === 0) {
    return null;
  }
  const repaired = body.endsWith('\n')
    ? body + added.join('\n') + '\n'
    : body + '\n' + added.join('\n');
  return { repaired, added };
}

// ── Section-level repair ────────────────────────────────────────────

/**
 * Repair the gcode body of ONE macro section's raw text. The body runs from
 * the `gcode:` param line through EOF / the next param-key line / the next
 * section header. Klipper treats ANY non-key line as a body continuation
 * regardless of indentation (models often emit unindented bodies), so the
 * span must NOT stop at the first non-indented line. Returns null when the
 * section has no gcode body or it is already balanced.
 */
export function repairUnclosedJinjaInSectionText(
  sectionText: string,
): { text: string; added: string[] } | null {
  const lines = sectionText.split('\n');
  const gcodeIndex = lines.findIndex((line) => GCODE_PARAM_RE.test(line));
  if (gcodeIndex === -1) {
    return null;
  }

  let bodyEnd = lines.length;
  for (let index = gcodeIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim().length === 0) continue;
    if (SECTION_HEADER_RE.test(line)) {
      bodyEnd = index;
      break;
    }
    if (PARAM_KEY_RE.test(line)) {
      bodyEnd = index;
      break;
    }
  }

  const body = lines.slice(gcodeIndex + 1, bodyEnd).join('\n');
  const repair = repairUnclosedJinjaBlock(body);
  if (!repair) {
    return null;
  }

  const repairedBodyLines = repair.repaired.split('\n');
  return {
    text: [...lines.slice(0, gcodeIndex + 1), ...repairedBodyLines, ...lines.slice(bodyEnd)].join('\n'),
    added: repair.added,
  };
}

/**
 * Repair every macro section in a raw cfg block (draft text). Only
 * gcode_macro / delayed_gcode sections are touched; other sections pass
 * through untouched. Returns the repaired text and the full headers of the
 * sections that were changed.
 */
export function repairUnclosedJinjaInConfigText(
  configText: string,
): { text: string; repairedSections: string[] } {
  const lines = configText.split('\n');
  const repairedSections: string[] = [];
  const out: string[] = [];

  let sectionStart = -1;
  let currentHeader = '';

  const flushSection = (endIndex: number) => {
    if (sectionStart === -1) return;
    const sectionLines = lines.slice(sectionStart, endIndex);
    if (
      MACRO_SECTION_PREFIXES.some((prefix) => currentHeader.toLowerCase().startsWith(prefix))
    ) {
      const repair = repairUnclosedJinjaInSectionText(sectionLines.join('\n'));
      if (repair) {
        out.push(...repair.text.split('\n'));
        repairedSections.push(currentHeader);
        return;
      }
    }
    out.push(...sectionLines);
  };

  for (let index = 0; index < lines.length; index += 1) {
    const match = SECTION_HEADER_RE.exec(lines[index]);
    if (match) {
      if (sectionStart === -1) {
        // Leading content (e.g. '# file: <name>' hints, banner comments)
        // belongs to the file and must survive the repair untouched.
        out.push(...lines.slice(0, index));
      } else {
        flushSection(index);
      }
      sectionStart = index;
      currentHeader = match[1].trim();
    }
  }
  flushSection(lines.length);

  if (repairedSections.length === 0) {
    return { text: configText, repairedSections: [] };
  }
  return { text: out.join('\n'), repairedSections };
}
