/**
 * UI-level, cross-component state for the text view shell.
 *
 * Distinct from `editorPrefs` (which is dependency-free and read once at
 * mount): this store exists for the two things the dock needs that React
 * cannot express as props — a persisted fold flag, and a *DOM host element*
 * that `TextEditor` publishes and `ChatDialog` portals its docked shell into.
 *
 * `dockHost` is deliberately transient: an element reference is only
 * meaningful for the lifetime of the mount that produced it, so it is never
 * written to storage.
 */
import { create } from 'zustand';

export const CHAT_DOCK_STORAGE_KEY = 'kwc.ui.showChatDock';

export interface UiState {
  /** Dock folded out (true) or collapsed to the rail (false). */
  showChatDock: boolean;
  /** Element the docked chat shell portals into. Set by `TextEditor`'s ref
   *  callback; null while the text view is unmounted. */
  dockHost: HTMLElement | null;
  /**
   * Bumped to ask the panel to focus its composer. A counter rather than a
   * boolean so repeat requests are distinguishable — the toolbar's Chat
   * button means "put me in the box" every time it is pressed.
   */
  composerFocusNonce: number;

  setShowChatDock: (show: boolean) => void;
  toggleChatDock: () => void;
  setDockHost: (host: HTMLElement | null) => void;
  requestComposerFocus: () => void;
}

/** Folded out by default — the panel is the point of the text view, and the
 *  rail is one click away for anyone who disagrees. */
export function readShowChatDock(storage: Storage | null = safeStorage()): boolean {
  try {
    return storage?.getItem(CHAT_DOCK_STORAGE_KEY) !== 'false';
  } catch {
    return true;
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function persist(show: boolean): void {
  try {
    safeStorage()?.setItem(CHAT_DOCK_STORAGE_KEY, show ? 'true' : 'false');
  } catch {
    // Storage unavailable (private mode, quota) — the flag stays session-only.
  }
}

export const useUiStore = create<UiState>((set, get) => ({
  showChatDock: readShowChatDock(),
  dockHost: null,
  composerFocusNonce: 0,

  setShowChatDock: (showChatDock) => {
    set({ showChatDock });
    persist(showChatDock);
  },

  toggleChatDock: () => {
    get().setShowChatDock(!get().showChatDock);
  },

  setDockHost: (dockHost) => set({ dockHost }),

  requestComposerFocus: () => set((state) => ({ composerFocusNonce: state.composerFocusNonce + 1 })),
}));
