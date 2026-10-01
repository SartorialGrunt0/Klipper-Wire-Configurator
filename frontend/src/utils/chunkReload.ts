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
 */

export const CHUNK_RELOAD_GUARD_MS = 30_000;
export const CHUNK_RELOAD_STORAGE_KEY = 'kwc:chunk-reload-at';

/** Whether a failed chunk load should trigger a reload, given the last one. */
export function shouldReloadForChunkError(
  lastReloadAt: number | null,
  now: number = Date.now(),
): boolean {
  if (lastReloadAt === null || !Number.isFinite(lastReloadAt)) {
    return true;
  }
  return now - lastReloadAt >= CHUNK_RELOAD_GUARD_MS;
}

/**
 * Reload once per guard window when a lazily-imported chunk fails to load.
 * Returns true when a reload was requested.
 */
export function handleChunkLoadError(
  storage: Pick<Storage, 'getItem' | 'setItem'>,
  reload: () => void,
  now: () => number = Date.now,
): boolean {
  const raw = storage.getItem(CHUNK_RELOAD_STORAGE_KEY);
  const lastReloadAt = raw === null ? null : Number(raw);
  const currentTime = now();
  if (!shouldReloadForChunkError(lastReloadAt, currentTime)) {
    return false;
  }
  storage.setItem(CHUNK_RELOAD_STORAGE_KEY, String(currentTime));
  reload();
  return true;
}

/** Wire the handler up for the lifetime of the document. */
export function installChunkReloadGuard(
  win: Window = window,
  storage: Storage = window.sessionStorage,
): void {
  win.addEventListener('vite:preloadError', (event) => {
    event.preventDefault();
    handleChunkLoadError(storage, () => win.location.reload());
  });
}
