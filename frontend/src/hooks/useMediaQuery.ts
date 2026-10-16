/**
 * Small viewport-query hook.
 *
 * Used by the text view to decide whether the docked chat panel fits. Kept
 * dependency-free and SSR-safe (no `window` at module scope, no matchMedia
 * assumption) — a layout preference must never take the editor down.
 */
import { useEffect, useState } from 'react';

/** Tailwind's `lg` breakpoint — the width below which the dock would squeeze
 *  the editor past usefulness, so the toolbar opens the modal instead. */
export const WIDE_VIEWPORT_QUERY = '(min-width: 1024px)';

function queryNow(query: string): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  try {
    return window.matchMedia(query).matches;
  } catch {
    return false;
  }
}

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => queryNow(query));

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;
    const list = window.matchMedia(query);
    const onChange = () => setMatches(list.matches);
    // Re-read on mount: the initial state was computed during render, which
    // can be before the stylesheet/layout settles.
    onChange();
    list.addEventListener('change', onChange);
    return () => list.removeEventListener('change', onChange);
  }, [query]);

  return matches;
}
