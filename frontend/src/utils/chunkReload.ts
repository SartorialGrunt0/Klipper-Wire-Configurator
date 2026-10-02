/**
 * Recover from a stale frontend bundle.
 *
 * Both `scripts/install.sh` and the service's own rebuild-on-start replace the
 * bundle, and Vite re-hashes every chunk filename while emptying the output
 * directory first. A tab opened against the previous build therefore fails
 * when it lazily imports a chunk that no longer exists: the app shell keeps
 * rendering (it is already in memory) but the dynamically imported pieces —
 * graph builder, config store, API service — never arrive. Users see that as
 * "KWC loaded, but no cards / no text view files".
 *
 * Vite dispatches `vite:preloadError` for exactly this case, so reload once to
 * pick up the new bundle. The guard keeps a genuinely broken deployment from
 * reload-looping: at most one reload per CHUNK_RELOAD_GUARD_MS.
 *
 * Every storage access here is guarded. This module is loaded at the top of
 * main.tsx, before createRoot(), so anything that throws while it is being
 * installed stops the SPA from mounting at all — a worse outcome than the
 * stale-chunk problem it exists to fix.
 */

export const CHUNK_RELOAD_GUARD_MS = 30_000;
export const CHUNK_RELOAD_STORAGE_KEY = 'kwc:chunk-reload-at';

/** Namespaces our data inside `window.name`, which other code may also use. */
const WINDOW_NAME_MARKER = 'kwc:chunk-reload';

/** The slice of Storage this module needs. */
export type StampStore = Pick<Storage, 'getItem' | 'setItem'>;

/**
 * Whether a failed chunk load should trigger a reload, given the last one.
 *
 * A timestamp in the FUTURE counts as stale. The stamp outlives a clock
 * correction (an NTP step or a manual change can move the clock backwards), and
 * `now - last >= guard` is then false for the whole skew — silently disabling
 * recovery for as long as the skew lasts.
 */
export function shouldReloadForChunkError(
  lastReloadAt: number | null,
  now: number = Date.now(),
): boolean {
  if (lastReloadAt === null || !Number.isFinite(lastReloadAt)) {
    return true;
  }
  if (lastReloadAt > now) {
    return true;
  }
  return now - lastReloadAt >= CHUNK_RELOAD_GUARD_MS;
}

/**
 * Reload once per guard window when a lazily-imported chunk fails to load.
 * Returns true when a reload was requested.
 *
 * Both storage calls are individually guarded: with site data blocked or in a
 * sandboxed iframe they throw, and an unguarded throw in the listener would
 * abort after preventDefault() — no reload, no recovery, no loop guard.
 */
export function handleChunkLoadError(
  storage: StampStore,
  reload: () => void,
  now: () => number = Date.now,
): boolean {
  let raw: string | null = null;
  try {
    raw = storage.getItem(CHUNK_RELOAD_STORAGE_KEY);
  } catch {
    raw = null;
  }
  const lastReloadAt = raw === null ? null : Number(raw);
  const currentTime = now();
  if (!shouldReloadForChunkError(lastReloadAt, currentTime)) {
    return false;
  }
  try {
    storage.setItem(CHUNK_RELOAD_STORAGE_KEY, String(currentTime));
  } catch {
    // Persisting the stamp is best-effort. The reload still has to happen, and
    // losing the stamp only costs us the loop guard — not the recovery.
  }
  reload();
  return true;
}

/** A store that lasts one page load. The last resort, not the preference. */
function memoryStore(): StampStore {
  const data = new Map<string, string>();
  return {
    getItem: (key: string): string | null =>
      data.has(key) ? (data.get(key) as string) : null,
    setItem: (key: string, value: string): void => {
      data.set(key, value);
    },
  };
}

/** Our bucket inside `window.name`, or null when the name is someone else's. */
function readOwnBucket(win: Window): Record<string, string> | null {
  const raw = win.name;
  if (!raw) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // A plain string name ('some-frame') belongs to another script.
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const bucket = (parsed as Record<string, unknown>)[WINDOW_NAME_MARKER];
  if (bucket === undefined) {
    // A JSON object we did not write — someone else's, so leave it alone.
    return null;
  }
  if (typeof bucket !== 'object' || bucket === null || Array.isArray(bucket)) {
    return null;
  }
  return bucket as Record<string, string>;
}

/**
 * A stamp store that survives reloads when sessionStorage is unusable.
 *
 * `window.name` is a per-tab string preserved across same-tab navigations,
 * which is exactly the lifetime a reload-loop guard needs. It is also shared,
 * legacy state that other code may own, so it is only used when it is empty or
 * already carries our marker; overwriting a foreign value would destroy it.
 * Returns null when the name is not ours to take.
 */
function windowNameStore(win: Window): StampStore | null {
  if (readOwnBucket(win) === null) {
    return null;
  }
  const write = (bucket: Record<string, string>): void => {
    let existing: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(win.name || '{}');
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        existing = parsed as Record<string, unknown>;
      }
    } catch {
      existing = {};
    }
    existing[WINDOW_NAME_MARKER] = bucket;
    win.name = JSON.stringify(existing);
  };
  return {
    getItem(key: string): string | null {
      const bucket = readOwnBucket(win);
      const value = bucket === null ? undefined : bucket[key];
      // Only strings are ours; anything else is a foreign value under our key.
      return typeof value === 'string' ? value : null;
    },
    setItem(key: string, value: string): void {
      const bucket = readOwnBucket(win) ?? {};
      bucket[key] = value;
      write(bucket);
    },
  };
}

/**
 * Resolve a usable stamp store, preferring sessionStorage. Never throws:
 * merely reading `window.sessionStorage` can throw when storage is blocked,
 * and this runs at module load.
 */
export function resolveStampStore(win: Window): StampStore {
  try {
    const storage = win.sessionStorage;
    const probeKey = `${CHUNK_RELOAD_STORAGE_KEY}:probe`;
    storage.setItem(probeKey, '1');
    const usable = storage.getItem(probeKey) === '1';
    // Remove the probe: this runs on every page load, so leaving it behind
    // would leak one permanent sessionStorage entry per origin.
    if (typeof storage.removeItem === 'function') {
      storage.removeItem(probeKey);
    }
    return usable ? storage : (windowNameStore(win) ?? memoryStore());
  } catch {
    return windowNameStore(win) ?? memoryStore();
  }
}

/** Wire the handler up for the lifetime of the document. */
export function installChunkReloadGuard(
  win: Window = window,
  storage?: StampStore,
): void {
  const store = storage ?? resolveStampStore(win);
  win.addEventListener('vite:preloadError', (event) => {
    event.preventDefault();
    handleChunkLoadError(store, () => win.location.reload());
  });
}
