export interface ReferenceHeading {
  level: number;
  text: string;
  id: string;
}

const HEADING_RE = /^( {0,3})(#{1,4})\s+(.*?)\s*#*\s*$/;

/**
 * Convert a heading's visible text into a stable, URL-safe anchor id.
 * Strips common markdown punctuation (backticks, emphasis, section brackets)
 * so ids like `[mcu]` become `mcu`.
 */
export function slugifyHeading(text: string): string {
  const slug = text
    .replace(/[*`[\]<>]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'section';
}

/**
 * Extract the document's headings (h1-h4) in order, skipping anything inside
 * fenced code blocks, with duplicate-safe ids (`mcu`, `mcu-2`, ...).
 * The id sequence is deterministic and ordered; the markdown renderer assigns
 * ids with the exact same algorithm so TOC anchors always match.
 */
export function extractHeadings(markdown: string): ReferenceHeading[] {
  const headings: ReferenceHeading[] = [];
  const used = new Map<string, number>();
  let inFence = false;

  for (const rawLine of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    const line = rawLine.trimEnd();
    if (line.trimStart().startsWith('```')) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const match = HEADING_RE.exec(line);
    if (!match) continue;
    const text = match[3].trim();
    if (!text) continue;

    const base = slugifyHeading(text);
    const count = (used.get(base) || 0) + 1;
    used.set(base, count);
    headings.push({ level: match[2].length, text, id: count === 1 ? base : `${base}-${count}` });
  }

  return headings;
}
