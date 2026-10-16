/**
 * Literal find / replace over config text.
 *
 * The search panel used to be search-only and found a single hit per line
 * (`indexOf`), so a line with three occurrences showed once and could not be
 * edited at all. Everything here is literal (no regex, no capture groups) and
 * case handling is explicit, matching the panel's `Match case` toggle.
 *
 * Offsets are JS string offsets: `FindHit` is line-relative (1-based line, and
 * `start`/`end` inside that line) because that is what the result rows render;
 * replacement works on absolute offsets internally.
 */

export interface FindOptions {
  caseSensitive?: boolean;
  wholeWord?: boolean;
}

export interface FindHit {
  /** 1-based. */
  line: number;
  /** Offset inside `line`. */
  start: number;
  /** Offset inside `line`. */
  end: number;
}

export interface AbsoluteHit {
  start: number;
  end: number;
  /** 1-based line containing `start`. */
  line: number;
}

const isWordChar = (char: string | undefined): boolean => !!char && /[A-Za-z0-9_]/.test(char);

function needleFor(query: string, options: FindOptions): string {
  return options.caseSensitive ? query : query.toLowerCase();
}

function haystackFor(text: string, options: FindOptions): string {
  return options.caseSensitive ? text : text.toLowerCase();
}

/**
 * Every non-overlapping match, left to right, with absolute offsets.
 * Overlaps are skipped: `aa` in `aaa` matches once, not twice.
 */
export function findAbsoluteHits(
  text: string,
  query: string,
  options: FindOptions = {},
): AbsoluteHit[] {
  if (!query) return [];
  const haystack = haystackFor(text, options);
  const needle = needleFor(query, options);
  const hits: AbsoluteHit[] = [];

  let line = 1;
  let lineStart = 0;
  let index = haystack.indexOf(needle);

  while (index !== -1) {
    // Advance the line cursor to the hit (hits are ascending, so this is a
    // single pass over the text in total).
    let nextNewline = text.indexOf('\n', lineStart);
    while (nextNewline !== -1 && nextNewline < index) {
      line += 1;
      lineStart = nextNewline + 1;
      nextNewline = text.indexOf('\n', lineStart);
    }

    const boundaryOk =
      !options.wholeWord ||
      (!isWordChar(text[index - 1]) && !isWordChar(text[index + needle.length]));

    if (boundaryOk) hits.push({ start: index, end: index + needle.length, line });

    index = haystack.indexOf(needle, index + needle.length);
  }

  return hits;
}

/** Matches as the result list renders them (line + offsets inside the line). */
export function findHits(text: string, query: string, options: FindOptions = {}): FindHit[] {
  return findAbsoluteHits(text, query, options).map((hit) => {
    const lineStart = text.lastIndexOf('\n', hit.start - 1) + 1;
    return { line: hit.line, start: hit.start - lineStart, end: hit.end - lineStart };
  });
}

export function countHits(text: string, query: string, options: FindOptions = {}): number {
  return findAbsoluteHits(text, query, options).length;
}

/**
 * Replace every match. `replacement` is inserted verbatim — `$&`, `$1` and
 * backslashes are literal text, not replacement patterns.
 */
export function replaceAll(
  text: string,
  query: string,
  replacement: string,
  options: FindOptions = {},
): { text: string; count: number } {
  const hits = findAbsoluteHits(text, query, options);
  if (hits.length === 0) return { text, count: 0 };

  let result = '';
  let cursor = 0;
  for (const hit of hits) {
    result += text.slice(cursor, hit.start) + replacement;
    cursor = hit.end;
  }
  result += text.slice(cursor);
  return { text: result, count: hits.length };
}

/** Absolute offset of `offsetInLine` inside 1-based `line`, or -1. */
function absoluteOffsetFor(text: string, line: number, offsetInLine: number): number {
  if (line < 1 || offsetInLine < 0) return -1;
  let start = 0;
  for (let current = 1; current < line; current += 1) {
    const newline = text.indexOf('\n', start);
    if (newline === -1) return -1;
    start = newline + 1;
  }
  const absolute = start + offsetInLine;
  return absolute <= text.length ? absolute : -1;
}

/**
 * Replace one match identified by a result row. The row's offsets are
 * re-validated against the current text: if the text moved on since the results
 * were computed — or the row simply is not a match any more — nothing is
 * replaced (`count: 0`) rather than corrupting the line.
 */
export function replaceOne(
  text: string,
  query: string,
  replacement: string,
  options: FindOptions,
  target: FindHit,
): { text: string; count: number } {
  if (!query) return { text, count: 0 };
  const start = absoluteOffsetFor(text, target.line, target.start);
  if (start === -1) return { text, count: 0 };

  const end = start + query.length;
  const segment = text.slice(start, end);
  const matches = options.caseSensitive
    ? segment === query
    : segment.toLowerCase() === query.toLowerCase();
  if (!matches) return { text, count: 0 };
  if (options.wholeWord && (isWordChar(text[start - 1]) || isWordChar(text[end]))) {
    return { text, count: 0 };
  }

  return { text: text.slice(0, start) + replacement + text.slice(end), count: 1 };
}
