import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CHAT_DOCK_STORAGE_KEY,
  readShowChatDock,
  useUiStore,
} from '@/stores/uiStore';

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => { map.set(key, value); },
    removeItem: (key: string) => { map.delete(key); },
    clear: () => { map.clear(); },
    key: (index: number) => Array.from(map.keys())[index] ?? null,
    get length() { return map.size; },
  } as Storage;
}

let storage: Storage;

beforeEach(() => {
  storage = memoryStorage();
  vi.stubGlobal('localStorage', storage);
  useUiStore.setState({ showChatDock: true, dockHost: null, composerFocusNonce: 0 });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('readShowChatDock', () => {
  it('defaults to folded out when nothing is stored', () => {
    expect(readShowChatDock(storage)).toBe(true);
  });

  it('reads back a stored collapse', () => {
    storage.setItem(CHAT_DOCK_STORAGE_KEY, 'false');
    expect(readShowChatDock(storage)).toBe(false);
  });

  it('reads back a stored expansion', () => {
    storage.setItem(CHAT_DOCK_STORAGE_KEY, 'true');
    expect(readShowChatDock(storage)).toBe(true);
  });

  it('falls back to folded out when storage is unavailable', () => {
    expect(readShowChatDock(null)).toBe(true);
  });

  it('survives a storage that throws on read', () => {
    const hostile = {
      getItem: () => { throw new Error('nope'); },
    } as unknown as Storage;
    expect(readShowChatDock(hostile)).toBe(true);
  });
});

describe('useUiStore', () => {
  it('starts folded out', () => {
    expect(useUiStore.getState().showChatDock).toBe(true);
  });

  it('persists the fold flag', () => {
    useUiStore.getState().setShowChatDock(false);
    expect(useUiStore.getState().showChatDock).toBe(false);
    expect(storage.getItem(CHAT_DOCK_STORAGE_KEY)).toBe('false');
  });

  it('toggles', () => {
    useUiStore.getState().toggleChatDock();
    expect(useUiStore.getState().showChatDock).toBe(false);
    useUiStore.getState().toggleChatDock();
    expect(useUiStore.getState().showChatDock).toBe(true);
    expect(storage.getItem(CHAT_DOCK_STORAGE_KEY)).toBe('true');
  });

  it('survives a storage that throws on write', () => {
    const hostile = {
      getItem: () => null,
      setItem: () => { throw new Error('quota'); },
    } as unknown as Storage;
    vi.stubGlobal('localStorage', hostile);
    expect(() => useUiStore.getState().setShowChatDock(false)).not.toThrow();
    expect(useUiStore.getState().showChatDock).toBe(false);
  });

  it('holds the dock host element and never persists it', () => {
    const host = { nodeName: 'DIV' } as unknown as HTMLElement;
    useUiStore.getState().setDockHost(host);
    expect(useUiStore.getState().dockHost).toBe(host);
    useUiStore.getState().setDockHost(null);
    expect(useUiStore.getState().dockHost).toBeNull();
    // The only thing that ever reaches storage is the fold flag.
    expect(storage.length).toBe(0);
  });

  it('counts composer-focus requests so a repeat press still lands', () => {
    useUiStore.setState({ composerFocusNonce: 0 });
    useUiStore.getState().requestComposerFocus();
    expect(useUiStore.getState().composerFocusNonce).toBe(1);
    useUiStore.getState().requestComposerFocus();
    expect(useUiStore.getState().composerFocusNonce).toBe(2);
    expect(storage.length).toBe(0);
  });
});
