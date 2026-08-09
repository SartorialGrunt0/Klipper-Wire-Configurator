import { isBackupConfigFilename } from './backupFiles';

/**
 * Non-Klipper files that must never be auto-selected in import/staging UIs.
 * Mirrors the skip logic previously duplicated in ImportDialog and
 * OpenFromPiDialog — case-insensitive on the basename.
 */
const NON_KLIPPER_CONFIG_NAMES = new Set([
  'moonraker.conf',
  'crowsnest.conf',
  'klipperscreen.conf',
  'sonar.conf',
  'webcam.txt',
]);

function shouldSkipFilename(name: string): boolean {
  const base = name.split(/[\\/]/).pop() ?? name;
  const lower = base.toLowerCase();
  if (isBackupConfigFilename(base)) return true;
  if (NON_KLIPPER_CONFIG_NAMES.has(lower)) return true;
  return lower.endsWith('.bak') || lower.endsWith('.old');
}

/**
 * Build the initial staged-file selection for an import: every file checked
 * by default except known non-Klipper / backup noise.
 */
export function buildInitialSelection(filenames: string[]): Record<string, boolean> {
  const selection: Record<string, boolean> = {};
  for (const name of filenames) {
    selection[name] = !shouldSkipFilename(name);
  }
  return selection;
}

/**
 * Return the selected filenames that already exist in the project — the set
 * an overwrite confirmation must list. Deselected files never count.
 */
export function findOverlappingFiles(
  selection: Record<string, boolean>,
  existingNames: string[],
): string[] {
  const existing = new Set(existingNames);
  return Object.entries(selection)
    .filter(([name, selected]) => selected && existing.has(name))
    .map(([name]) => name);
}
