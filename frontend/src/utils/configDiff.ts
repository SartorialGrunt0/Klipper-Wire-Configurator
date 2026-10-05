import { createTwoFilesPatch } from 'diff';

export interface DiffLine {
  type: 'added' | 'removed' | 'context' | 'header';
  content: string;
}

export function normalizeDiffText(text: string): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n').map((line) => line.replace(/[ \t]+$/g, ''));
  const normalized: string[] = [];
  let previousBlank = false;

  for (const line of lines) {
    const isBlank = line.trim().length === 0;
    if (isBlank && previousBlank) {
      continue;
    }
    normalized.push(line);
    previousBlank = isBlank;
  }

  return normalized.join('\n');
}

/**
 * Normalize ONE SIDE of a change — a run of added or removed lines — by the
 * same rules `normalizeDiffText` applies to a whole document: trailing
 * whitespace dropped, runs of blank lines collapsed to one.
 *
 * Row ownership is matched by CONTENT, and the two contents are produced by
 * two different diff engines: the backend's raw `difflib` row text and this
 * client's `createConfigPatch` frame, which normalizes. Comparing them raw
 * means a line the model typed with a trailing space — or a doubled blank
 * inside an added section — makes the pane's change own no row at all: no
 * per-change Keep/Undo in the diff, and a dead pair in the strip (reported
 * 2026-10-04). Both sides get read in the same space instead.
 */
export function normalizeChangeLines(lines: readonly string[]): string[] {
  const out: string[] = [];
  let previousBlank = false;
  for (const raw of lines) {
    const line = raw.replace(/[ \t\r]+$/, '');
    const isBlank = line.trim().length === 0;
    if (isBlank && previousBlank) continue;
    out.push(line);
    previousBlank = isBlank;
  }
  return out;
}

export function parsePatch(patch: string): DiffLine[] {
  const lines: DiffLine[] = [];

  for (const line of patch.split('\n')) {
    if (line.startsWith('@@')) {
      lines.push({ type: 'header', content: line });
    } else if (line.startsWith('+') && !line.startsWith('+++')) {
      lines.push({ type: 'added', content: line.slice(1) });
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      lines.push({ type: 'removed', content: line.slice(1) });
    } else if (line.startsWith(' ')) {
      lines.push({ type: 'context', content: line.slice(1) });
    }
  }

  return lines;
}

/** `@@ -a,b +c,d @@` — the AFTER start is what a running gutter counts from. */
const HUNK_AFTER_START_RE = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * The running line number of each diff row, in the document the diff's AFTER
 * side describes.
 *
 * The pane stands in for the buffer, so its gutter has to be the editor's
 * gutter: numbered continuously down the DOCUMENT, not per hunk. A header
 * restarts the count at its own `+` start — which also makes several
 * concatenated hunks (the no-frame fallback) keep counting, since each one
 * carries its true start. A removed row is not in the document at all, so it
 * carries NO number rather than a second numbering system (Cliff, 2026-10-04).
 */
export function documentLineNumbers(lines: readonly DiffLine[]): (number | null)[] {
  const out: (number | null)[] = [];
  let next = 1;
  for (const line of lines) {
    if (line.type === 'header') {
      const match = line.content.match(HUNK_AFTER_START_RE);
      if (match) next = Number(match[1]);
      out.push(null);
      continue;
    }
    if (line.type === 'removed') {
      out.push(null);
      continue;
    }
    out.push(next);
    next += 1;
  }
  return out;
}

export function countChangedLines(patch: string): number {
  let count = 0;

  for (const line of patch.split('\n')) {
    if ((line.startsWith('+') && !line.startsWith('+++')) ||
        (line.startsWith('-') && !line.startsWith('---'))) {
      count += 1;
    }
  }

  return count;
}

export function createConfigPatch(
  filename: string,
  originalText: string,
  currentText: string,
  oldLabel = 'original',
  newLabel = 'current',
  context = 3,
): string {
  return createTwoFilesPatch(
    filename,
    filename,
    normalizeDiffText(originalText),
    normalizeDiffText(currentText),
    oldLabel,
    newLabel,
    { context },
  );
}