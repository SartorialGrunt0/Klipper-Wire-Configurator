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
