/**
 * Keyboard-chord matching for the editor shortcuts (Ctrl/Cmd+F, Ctrl/Cmd+H,
 * Ctrl/Cmd+S). Pure logic so the chords are pinned by unit tests without a
 * DOM — the components only decide what to DO once a chord matches.
 *
 * Matching rules:
 * - Ctrl (Windows/Linux) or Cmd (Mac) qualifies; both map to the same action.
 * - Shift and Alt disqualify: Ctrl+Shift+F etc. stay unbound so a future
 *   chord doesn't silently collide, and Alt belongs to the OS/window manager.
 * - Bare letters never match — `f` must be typing, not a command.
 */

export type EditorShortcut = 'find' | 'replace';

interface ChordLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/** 'find' / 'replace' when the event carries the Ctrl/Cmd+F or Ctrl/Cmd+H
 *  chord, null otherwise. */
export function matchEditorShortcut(e: ChordLike): EditorShortcut | null {
  if (!e.ctrlKey && !e.metaKey) return null;
  if (e.shiftKey || e.altKey) return null;
  const key = e.key.toLowerCase();
  if (key === 'f') return 'find';
  if (key === 'h') return 'replace';
  return null;
}

/** True only for the plain Ctrl/Cmd+S chord (no Shift/Alt). */
export function isSaveShortcut(e: ChordLike): boolean {
  if (!e.ctrlKey && !e.metaKey) return false;
  if (e.shiftKey || e.altKey) return false;
  return e.key.toLowerCase() === 's';
}
