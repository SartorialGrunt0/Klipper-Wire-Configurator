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

/**
 * A stamp store that survives reloads when sessionStorage is unusable.
 *
 * `window.name` is a per-tab string preserved across same-tab navigations,
 * which is exactly the lifetime a reload-loop guard needs. A purely in-memory
 * fallback would be useless here: it resets on every reload, so the guard
 * would never fire twice and a broken deploy would loop forever.
 */
function windowNameStore(win: Window): StampStore {
  const read = (): Record<string, string> => {
    try {
      const parsed: unknown = JSON.parse(win.name || '{}');
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, string>;
      }
    } catch {
      // A non-JSON window.name (some third-party script) is not ours.
    }
    return {};
  };
  return {
    getItem(key: string): string | null {
      const all = read();
      return Object.prototype.hasOwnProperty.call(all, key) ? all[key] : null;
    },
    setItem(key: string, value: string): void {
      const all = read();
      all[key] = value;
      win.name = JSON.stringify(all);
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
    if (storage.getItem(probeKey) !== '1') {
      return windowNameStore(win);
    }
    return storage;
  } catch {
    return windowNameStore(win);
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
