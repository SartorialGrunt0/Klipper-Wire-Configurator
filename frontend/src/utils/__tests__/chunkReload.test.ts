import { describe, expect, it, vi } from 'vitest';
import {
  CHUNK_RELOAD_GUARD_MS,
  CHUNK_RELOAD_STORAGE_KEY,
  handleChunkLoadError,
  installChunkReloadGuard,
  shouldReloadForChunkError,
} from '../chunkReload';

// The vitest environment is 'node' — no real sessionStorage, so the util takes
// its storage (and clock) by injection and both are faked here.

function fakeStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => (data.has(key) ? (data.get(key) as string) : null),
    setItem: (key: string, value: string) => void data.set(key, value),
    has: (key: string) => data.has(key),
  };
}

describe('shouldReloadForChunkError', () => {
  it('reloads when no reload has happened yet', () => {
    expect(shouldReloadForChunkError(null, 1_000)).toBe(true);
  });

  it('does not reload inside the guard window', () => {
    expect(shouldReloadForChunkError(1_000, 1_000 + CHUNK_RELOAD_GUARD_MS - 1)).toBe(false);
  });

  it('reloads again once the guard window has elapsed', () => {
    expect(shouldReloadForChunkError(1_000, 1_000 + CHUNK_RELOAD_GUARD_MS)).toBe(true);
  });

  it('treats an unparseable timestamp as no previous reload', () => {
    expect(shouldReloadForChunkError(Number.NaN, 1_000)).toBe(true);
  });
});

describe('handleChunkLoadError', () => {
  it('reloads once and records the attempt', () => {
    const storage = fakeStorage();
    const reload = vi.fn();

    expect(handleChunkLoadError(storage, reload, () => 5_000)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(storage.getItem(CHUNK_RELOAD_STORAGE_KEY)).toBe('5000');
  });

  it('does not reload again while a reload is still in flight (broken deploy)', () => {
    const storage = fakeStorage({ [CHUNK_RELOAD_STORAGE_KEY]: '5000' });
    const reload = vi.fn();

    expect(handleChunkLoadError(storage, reload, () => 5_000 + 10)).toBe(false);
    expect(reload).not.toHaveBeenCalled();
    // The recorded attempt is left alone, so the window is measured from the
    // first reload rather than being pushed forward by every failure.
    expect(storage.getItem(CHUNK_RELOAD_STORAGE_KEY)).toBe('5000');
  });

  it('reloads again after the guard window elapses', () => {
    const storage = fakeStorage({ [CHUNK_RELOAD_STORAGE_KEY]: '5000' });
    const reload = vi.fn();

    expect(handleChunkLoadError(storage, reload, () => 5_000 + CHUNK_RELOAD_GUARD_MS)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('reloads when the stored value is corrupt', () => {
    const storage = fakeStorage({ [CHUNK_RELOAD_STORAGE_KEY]: 'not-a-number' });
    const reload = vi.fn();

    expect(handleChunkLoadError(storage, reload, () => 5_000)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('still reloads when reading the stamp throws (blocked storage)', () => {
    const storage = {
      getItem: () => {
        throw new Error('storage blocked');
      },
      setItem: vi.fn(),
    };
    const reload = vi.fn();

    expect(handleChunkLoadError(storage, reload, () => 5_000)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('still reloads when writing the stamp throws (quota / private mode)', () => {
    const storage = {
      getItem: () => null,
      setItem: () => {
        throw new Error('quota exceeded');
      },
    };
    const reload = vi.fn();

    expect(handleChunkLoadError(storage, reload, () => 5_000)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

describe('shouldReloadForChunkError under clock skew', () => {
  it('treats a stamp in the future as stale (the clock stepped backwards)', () => {
    // Without this, `now - last >= guard` stays false for the whole skew and
    // recovery is silently disabled until real time catches up.
    expect(shouldReloadForChunkError(10_000_000, 1_000)).toBe(true);
  });
});

// A minimal Window. `sessionStorage` is defined as a getter so it can throw
// the way a storage-blocked browser does.
type Listener = (event: { preventDefault: () => void }) => void;

function createFakeWindow(options: { sessionStorageThrows?: boolean; name?: string } = {}) {
  const listeners = new Map<string, Listener[]>();
  const reload = vi.fn();
  const data = new Map<string, string>();
  const storage = {
    getItem: (key: string) => (data.has(key) ? (data.get(key) as string) : null),
    setItem: (key: string, value: string) => void data.set(key, value),
  };
  const win = {
    name: options.name ?? '',
    location: { reload },
    addEventListener(type: string, listener: Listener) {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
  } as unknown as Window;

  Object.defineProperty(win, 'sessionStorage', {
    get() {
      if (options.sessionStorageThrows) {
        throw new Error('storage is not available in this context');
      }
      return storage;
    },
  });

  return {
    win,
    reload,
    fire(type: string) {
      for (const listener of listeners.get(type) ?? []) {
        listener({ preventDefault: vi.fn() });
      }
    },
  };
}

describe('installChunkReloadGuard', () => {
  it('reloads on a preload error, then suppresses a second one', () => {
    const page = createFakeWindow();
    installChunkReloadGuard(page.win);

    page.fire('vite:preloadError');
    expect(page.reload).toHaveBeenCalledTimes(1);

    page.fire('vite:preloadError');
    expect(page.reload).toHaveBeenCalledTimes(1);
  });

  it('installs without throwing when sessionStorage is blocked', () => {
    // The regression this guards: a throw here escapes main.tsx module
    // evaluation, createRoot() is never reached, and the SPA renders nothing.
    const page = createFakeWindow({ sessionStorageThrows: true });

    expect(() => installChunkReloadGuard(page.win)).not.toThrow();

    page.fire('vite:preloadError');
    expect(page.reload).toHaveBeenCalledTimes(1);
  });

  it('keeps the loop guard across a reload when sessionStorage is blocked', () => {
    const first = createFakeWindow({ sessionStorageThrows: true });
    installChunkReloadGuard(first.win);
    first.fire('vite:preloadError');
    expect(first.reload).toHaveBeenCalledTimes(1);

    // The reloaded page gets a fresh Window; only `name` carries over. A
    // purely in-memory fallback would reset here and loop forever.
    const second = createFakeWindow({
      sessionStorageThrows: true,
      name: first.win.name,
    });
    installChunkReloadGuard(second.win);
    second.fire('vite:preloadError');
    expect(second.reload).not.toHaveBeenCalled();
  });
});
