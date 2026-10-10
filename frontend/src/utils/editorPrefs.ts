/**
 * Small, dependency-free persisted UI preferences for the text view.
 *
 * Storage is optional by design: `localStorage` is absent in native/SSR
 * contexts and can throw (private mode, quota), and a preference must never
 * take the editor down. Every accessor therefore takes an injectable store and
 * falls back to a sane default.
 */

export interface PrefStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const ISSUE_STRIP_KEY = 'klipper-wire-editor-issue-strip';

function defaultStorage(): PrefStorage | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage;
  } catch {
    return null;
  }
}

/**
 * Findings strip is **collapsed by default** — the point of the strip is to
 * give the editor back its vertical space, so a user who never opens it should
 * not pay for it.
 */
export function readIssueStripCollapsed(store: PrefStorage | null = defaultStorage()): boolean {
  try {
    return store?.getItem(ISSUE_STRIP_KEY) !== 'expanded';
  } catch {
    return true;
  }
}

export function writeIssueStripCollapsed(
  collapsed: boolean,
  store: PrefStorage | null = defaultStorage(),
): void {
  try {
    store?.setItem(ISSUE_STRIP_KEY, collapsed ? 'collapsed' : 'expanded');
  } catch {
    // Preference writes are best-effort.
  }
}
