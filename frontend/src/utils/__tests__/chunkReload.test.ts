import { describe, expect, it, vi } from 'vitest';
import {
  CHUNK_RELOAD_GUARD_MS,
  CHUNK_RELOAD_STORAGE_KEY,
  handleChunkLoadError,
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
});
