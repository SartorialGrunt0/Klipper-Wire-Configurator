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
  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }
  const bucket = (parsed as Record<string, unknown>)[WINDOW_NAME_MARKER];
  if (bucket === undefined) {
    return null;
  }
  if (typeof bucket !== 'object' || bucket === null) {
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
    // Re-check immediately before writing. Another script can replace
    // window.name between the read above and this write, and taking over the
    // new value would break the one promise this store makes.
    if (readOwnBucket(win) === null) {
      return;
    }
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
 * Resolve a store that survives a reload, preferring sessionStorage. Never
 * throws (merely reading `window.sessionStorage` can, and this runs at module
 * load), and returns null when nothing immune to a reload is available.
 */
export function resolveStampStore(win: Window): StampStore | null {
  try {
    const storage = win.sessionStorage;
    const probeKey = `${CHUNK_RELOAD_STORAGE_KEY}:probe`;
    storage.setItem(probeKey, '1');
    const usable = storage.getItem(probeKey) === '1';
    // Remove the probe: this runs on every page load, so leaving it behind
    // would leak one permanent sessionStorage entry per origin. A probe that
    // cannot be cleaned up is not a reason to abandon otherwise usable storage,
    // so this failure is contained rather than falling through to the fallback.
    if (typeof storage.removeItem === 'function') {
      try {
        storage.removeItem(probeKey);
      } catch {
        // Ignored on purpose — see above.
      }
    }
    if (usable) {
      return storage;
    }
  } catch {
    // fall through to the window.name store
  }
  return windowNameStore(win);
}

/**
 * Wire the handler up for the lifetime of the document.
 *
 * Does nothing when no store survives a reload. A store that resets on reload
 * cannot tell "this is the first failure" from "we already reloaded", so the
 * guard would reload forever on a genuinely broken deployment — an infinite
 * loop is worse than the manual refresh it would cost.
 */
export function installChunkReloadGuard(
  win: Window = window,
  storage?: StampStore,
): void {
  const store = storage ?? resolveStampStore(win);
  if (!store) {
    return;
  }
  win.addEventListener('vite:preloadError', (event) => {
    event.preventDefault();
    handleChunkLoadError(store, () => win.location.reload());
  });
}
