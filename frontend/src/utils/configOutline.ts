/**
 * The section/param outline of a config file's *text*.
 *
 * Extracted verbatim from the text view's inline `sectionEntries` memo so the
 * parsing is testable and shareable (the merged file/section/param tree needs
 * it for every file, not just the active one). Behaviour is unchanged: the flat
 * scan drives line numbers, `[include ...]` ends the current section, comment
 * lines are skipped, and a commented section header yields no params.
 */

export interface OutlineParam {
  key: string;
  line: number;
}

export interface OutlineSection {
  /** `${line}:${title}` — stable within a file, duplicate-header safe. */
  id: string;
  title: string;
  /** 1-based line of the header. */
  line: number;
  params: OutlineParam[];
  isCommented: boolean;
}

const HEADER_LINE_RE = /^\s*#?\s*\[([^\]]*)\]\s*$/;

/**
 * The section the caret is in: the nearest header at or above `lineIndex`
 * (0-based), looked up **by line number**.
 *
 * Looking the section up by title is wrong in a real project: the same header
 * can be defined twice (`[printer]` in printer.cfg and again elsewhere), and the
 * first title match is then a different section with a different param list.
 * An `[include ...]` line is a header syntactically but opens no section, so it
 * yields null — the same rule `scanSections` uses to end the current section.
 */
export function sectionAtLine(text: string, lineIndex: number): OutlineSection | null {
  const lines = text.split('\n');
  let headerLine = -1;
  for (let i = Math.min(lineIndex, lines.length - 1); i >= 0; i -= 1) {
    if (HEADER_LINE_RE.test(lines[i])) {
      headerLine = i;
      break;
    }
  }
  if (headerLine === -1) return null;
  return scanSections(text).find((entry) => entry.line === headerLine + 1) ?? null;
}

export function scanSections(text: string): OutlineSection[] {
  const lines = text.split('\n');
  const sections: OutlineSection[] = [];
  let currentSection: OutlineSection | null = null;

  lines.forEach((line, idx) => {
    const sectionMatch = line.match(/^\s*(#?)\[([^\]]+)\]\s*$/);
    if (sectionMatch) {
      const title = sectionMatch[2].trim();
      if (title.toLowerCase().startsWith('include ')) {
        // A live include ends the current section; a commented-out one
        // (`#[include x]`) is just a comment and must not — that would drop
        // every param below it from the outline.
        if (sectionMatch[1] !== '#') currentSection = null;
        return;
      }
      currentSection = {
        id: `${idx + 1}:${title}`,
        title,
        line: idx + 1,
        params: [],
        isCommented: sectionMatch[1] === '#',
      };
      sections.push(currentSection);
      return;
    }

    if (!currentSection || currentSection.isCommented) return;
    const paramMatch = line.match(/^\s*(#?)([A-Za-z0-9_][A-Za-z0-9_\-]*)(\s*[:=]\s*)(.*)$/);
    if (paramMatch && paramMatch[1] !== '#') {
      currentSection.params.push({ key: paramMatch[2], line: idx + 1 });
    }
  });

  return sections;
}
