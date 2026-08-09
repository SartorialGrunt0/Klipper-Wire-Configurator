/**
 * Klipper SAVE_CONFIG backup detection.
 *
 * Klipper writes timestamped backups (printer-YYYYMMDD_HHMMSS.cfg) into the
 * config directory on every "save to disk". KWC treats these as noise: they
 * must never show up in config listings, get auto-opened, or be offered to
 * the AI as editable files. The pattern is deliberately narrow — 8-digit
 * date + underscore + digits — so example configs named
 * printer-<model>-<year>.cfg never match.
 */

const BACKUP_CONFIG_RE = /^printer-\d{8}_\d+\.cfg$/i;

/** True when `name` (a bare filename or a path) is a Klipper SAVE_CONFIG backup. */
export function isBackupConfigFilename(name: string): boolean {
  const base = name.split(/[\\/]/).pop() ?? name;
  return BACKUP_CONFIG_RE.test(base);
}
