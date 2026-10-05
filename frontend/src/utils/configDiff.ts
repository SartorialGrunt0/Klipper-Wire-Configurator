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