import type { ReferenceHeading } from './referenceDoc';

/**
 * Search inside the Configuration Reference document.
 *
 * The dialog renders the whole Klipper `Config_Reference.md` (thousands of
 * lines), so "find the section about X" meant scrolling the TOC by eye. The
 * index is built in a single pass and attributes every line to its enclosing
 * heading — using the **same** heading sequence the TOC and the renderer use
 * (`extractHeadings`), so a hit's `headingId` is a real element id and the
 * click-to-jump works.
 */

export interface ReferenceLine {
  /** 1-based line in the markdown source. */
  line: number;
  text: string;
  /** Enclosing heading's text ('' before the first heading). */
  heading: string;
  /** Enclosing heading's anchor id — matches the rendered <h* id>. */
  headingId: string;
}

export interface ReferenceHit extends ReferenceLine {
  /** Offsets inside `text`. */
  matchStart: number;
  matchEnd: number;
}

// Must stay identical to referenceDoc's heading matcher, or the ids drift.
const HEADING_RE = /^( {0,3})(#{1,4})\s+(.*?)\s*#*\s*$/;

/**
 * Attribute every markdown line to its enclosing h1-h4.
 *
 * `headings` is the array from `extractHeadings(content)`; consumption is
 * positional (the two passes apply the same fence/heading rules), which is what
 * keeps the ids identical to the ones the renderer assigns.
 */
export function buildReferenceIndex(
  markdown: string,
  headings: readonly ReferenceHeading[] = [],
): ReferenceLine[] {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const index: ReferenceLine[] = [];
  let inFence = false;
  let headingCursor = 0;
  let current = { text: '', id: '' };

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    const trimmed = raw.trimEnd();

    if (trimmed.trimStart().startsWith('```')) {
      inFence = !inFence;
      index.push({ line: i + 1, text: raw, heading: current.text, headingId: current.id });
      continue;
    }

    const match = inFence ? null : HEADING_RE.exec(trimmed);
    if (match && match[3].trim()) {
      const next = headings[headingCursor];
      headingCursor += 1;
      if (next) current = { text: next.text, id: next.id };
    }

    index.push({ line: i + 1, text: raw, heading: current.text, headingId: current.id });
  }

  return index;
}

/**
 * Case-insensitive literal search over the index, every occurrence on every
 * line, capped at `limit` hits.
 */
export function searchReference(
  index: readonly ReferenceLine[],
  query: string,
  limit = 100,
): ReferenceHit[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];

  const hits: ReferenceHit[] = [];
  for (const entry of index) {
    const haystack = entry.text.toLowerCase();
    let from = 0;
    for (;;) {
      const at = haystack.indexOf(needle, from);
      if (at === -1) break;
      hits.push({ ...entry, matchStart: at, matchEnd: at + needle.length });
      if (hits.length >= limit) return hits;
      from = at + needle.length;
    }
  }
  return hits;
}

/** Distinct headings a hit list touches, in document order. */
export function hitHeadings(hits: readonly ReferenceHit[]): Array<{ id: string; text: string }> {
  const seen = new Map<string, string>();
  for (const hit of hits) {
    if (hit.headingId && !seen.has(hit.headingId)) seen.set(hit.headingId, hit.heading);
  }
  return Array.from(seen, ([id, text]) => ({ id, text }));
}
