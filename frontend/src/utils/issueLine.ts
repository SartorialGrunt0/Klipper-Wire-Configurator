import type { ValidationError } from '../types/config';

/**
 * Resolve the 1-based line number for a validation issue.
 *
 * Prefers the backend's authoritative `line_number`; only when the backend
 * could not provide one (0) does it fall back to the string heuristic that
 * scans the section/param in the current text. Returns 0 when nothing
 * resolves (the gutter skips those issues).
 *
 * `stale`: true when the validation result was computed against an OLDER
 * version of the file's text than `lines` (the user typed ahead of the
 * debounced revalidation). A stale backend line_number points at the old
 * layout — rendering it paints the dot on the wrong line (the "info dot in
 * the middle of a section" bug). In stale mode the backend number is
 * treated as 0 and the heuristic re-locates the finding in the current
 * text; if it can't, the finding hides (line 0) until the revalidation
 * lands with fresh line numbers.
 */
export function resolveIssueLine(
  err: ValidationError,
  lines: string[],
  options: { stale?: boolean } = {},
): number {
  // Fresh result: the backend line_number is authoritative for the current
  // text layout — trust it.
  if (err.line_number > 0 && !options.stale) {
    return err.line_number;
  }

  // Stale result: the backend number points at the old text layout. If the
  // line it names still looks like an unclosed section header in the current
  // text, the broken line hasn't moved — trust it. Otherwise fall through to
  // the section/param heuristic, which re-locates the finding in the current
  // text (or returns 0 to hide it until the fresh revalidation lands).
  if (err.line_number > 0 && options.stale) {
    const oldLine = lines[err.line_number - 1];
    if (oldLine !== undefined && /^\[[^\]]*$/.test(oldLine.trim()) && !oldLine.trim().startsWith('#')) {
      return err.line_number;
    }
  }

  let lineNum = 0;
  if (err.section) {
    const sectionIdx = lines.findIndex((l) => {
      const trimmed = l.trim();
      return trimmed === `[${err.section}]` || trimmed === `#[${err.section}]`;
    });
    if (sectionIdx !== -1) {
      if (err.param) {
        for (let i = sectionIdx + 1; i < lines.length; i++) {
          if (lines[i].trim().startsWith('[') && lines[i].trim().endsWith(']')) break;
          const trimmed = lines[i].replace(/^#/, '').trim();
          if (
            trimmed.startsWith(`${err.param}:`) ||
            trimmed.startsWith(`${err.param} `) ||
            trimmed.startsWith(`${err.param}=`)
          ) {
            lineNum = i + 1;
            break;
          }
        }
      }
      if (!lineNum) lineNum = sectionIdx + 1;
    }
  }
  return lineNum;
}
