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