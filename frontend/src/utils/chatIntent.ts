/**
 * Targeted section extraction for the AI chat.
 *
 * Phase 3: the chat stops dumping entire config files into the context.
 * Instead we attach only the section(s) the user is talking about (plus a
 * lean section index otherwise) so the model fetches the rest via
 * read_user_config. This keeps context lean — the same lesson Pi/coding
 * agents taught us: give the model only what it needs.
 */

/** Section header line like `[gcode_macro Level_Bed]` (may have trailing spaces). */
const SECTION_HEADER_RE = /^\s*\[([^\]]+)\]\s*$/;

/** Find all section header names (e.g. "gcode_macro Level_Bed") in file text. */
export function findSectionHeaders(fileText: string): string[] {
  const headers: string[] = [];
  for (const line of fileText.split(/\r?\n/)) {
    const match = SECTION_HEADER_RE.exec(line);
    if (match) headers.push(match[1].trim());
  }
  return headers;
}

/** Extract the raw text of one section (header + body, incl. leading comments). */
export function extractSectionText(fileText: string, header: string): string | null {
  const lines = fileText.split(/\r?\n/);
  const headerIndex = lines.findIndex(
    (line) => SECTION_HEADER_RE.test(line) && SECTION_HEADER_RE.exec(line)![1].trim() === header,
  );
  if (headerIndex === -1) return null;

  let endIndex = lines.length;
  for (let index = headerIndex + 1; index < lines.length; index += 1) {
    if (SECTION_HEADER_RE.test(lines[index])) {
      endIndex = index;
      break;
    }
  }

  // Walk back over blank + comment lines above the header (banner comments
  // and separators belong to the section visually).
  let startIndex = headerIndex;
  while (startIndex > 0) {
    const previous = lines[startIndex - 1].trim();
    if (previous === '' || previous.startsWith('#')) {
      startIndex -= 1;
    } else {
      break;
    }
  }

  return lines.slice(startIndex, endIndex).join('\n');
}

/**
 * Resolve which section headers a user message targets.
 *
 * Matches (case-insensitively): explicit `[section]` references, "macro X" /
 * "X macro" phrases, and "the X section" noun phrases. Returns matched
 * headers in file order, deduplicated.
 */
export function extractTargetedSectionHeaders(text: string, fileText: string): string[] {
  const headers = findSectionHeaders(fileText);
  if (headers.length === 0) return [];

  // Candidate tokens from the user text.
  const candidates: string[] = [];
  for (const match of text.matchAll(/\[([^\]]+)\]/g)) {
    candidates.push(match[1].trim());
  }
  for (const match of text.matchAll(/\b([A-Za-z0-9_]+)\s+macro\b|\bmacro\s+([A-Za-z0-9_]+)\b/gi)) {
    candidates.push(match[1] || match[2]);
  }
  for (const match of text.matchAll(/\bthe\s+([a-z0-9_]+)\s+section\b|\b([a-z0-9_]+)\s+section\b/gi)) {
    candidates.push(match[1] || match[2]);
  }
  // Common shorthand: a bare macro-style identifier that matches a macro header.
  for (const match of text.matchAll(/\b([A-Z][A-Za-z0-9_]{2,})\b/g)) {
    candidates.push(match[1]);
  }

  const matched = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate) continue;
    const lower = candidate.toLowerCase();
    // Exact match first, then header-contains-candidate, then candidate-contains-header.
    const exact = headers.find((h) => h.toLowerCase() === lower);
    if (exact) {
      matched.add(exact);
      continue;
    }
    const contains = headers
      .filter((h) => h.toLowerCase().includes(lower))
      .sort((a, b) => a.length - b.length);
    if (contains.length > 0) {
      matched.add(contains[0]);
      continue;
    }
    const contained = headers.find((h) => lower.includes(h.toLowerCase()) && h.toLowerCase().length > 3);
    if (contained) {
      matched.add(contained);
    }
  }

  // Return in file order.
  return headers.filter((h) => matched.has(h));
}

/** Build a context message for a single targeted section. */
export function buildSectionContextMessage(
  filename: string,
  label: string,
  header: string,
  sectionText: string,
): string {
  return (
    `${label}: ${filename} — section [${header}] (partial context; the file may have more sections)\n\n`
    + '```cfg\n'
    + sectionText
    + '\n```'
  );
}
