import type { ValidationError } from '../types/config';

/**
 * Resolve the 1-based line number for a validation issue.
 *
 * Prefers the backend's authoritative `line_number`; only when the backend
 * could not provide one (0) does it fall back to the string heuristic that
 * scans the section/param in the current text. Returns 0 when nothing
 * resolves (the gutter skips those issues).
 */
export function resolveIssueLine(err: ValidationError, lines: string[]): number {
  if (err.line_number > 0) {
    return err.line_number;
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
