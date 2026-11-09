/**
 * Focus-trap primitives for modal dialogs.
 *
 * The trap algorithm is kept pure (plain data in, index out) so it is unit
 * testable without a DOM, per this repo's test conventions. The thin DOM glue
 * lives in components/Modal.tsx: it maps HTMLElements to TabbableProbe and
 * calls nextTrapIndex on Tab keydown.
 */

/** Structural view of an element's tabbability inputs (DOM-free for tests). */
export interface TabbableProbe {
  tagName: string;
  disabled: boolean;
  /** The tabIndex attribute coerced to number; NaN when the attribute is absent. */
  tabIndex: number;
  ariaHidden: boolean;
  hiddenAttr: boolean;
  inert: boolean;
  displayNone: boolean;
  visibilityHidden: boolean;
}

const INTERACTIVE_TAGS = new Set(['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'AUDIO', 'VIDEO']);

/**
 * True when the probe describes an element that participates in sequential
 * keyboard focus. Interactive tags are tabbable by default; anything else is
 * tabbable only with an explicit non-negative tabIndex. ARIA [hidden] is
 * treated as inert here (simplification: focusables inside an aria-hidden
 * subtree are still in the DOM; modals should not mark live content hidden).
 */
export function isTabbable(el: TabbableProbe): boolean {
  if (el.disabled || el.ariaHidden || el.hiddenAttr || el.inert) return false;
  if (el.displayNone || el.visibilityHidden) return false;
  // An explicit tabindex >= 0 makes ANY element sequentially focusable;
  // a negative one removes it. Absent (NaN) falls through to tag defaults.
  if (!Number.isNaN(el.tabIndex)) return el.tabIndex >= 0;
  return INTERACTIVE_TAGS.has(el.tagName.toUpperCase());
}

/**
 * Given the tabbability flags of the elements inside a trapped container
 * (document order) and the index of the currently focused element inside that
 * list (-1 when focus is outside the list), return the index Tab should move
 * to next, wrapping within the list. Returns null when nothing is tabbable
 * (the container itself should keep focus).
 */
export function nextTrapIndex(tabbable: readonly boolean[], active: number, shift: boolean): number | null {
  const n = tabbable.length;
  if (n === 0) return null;
  const step = shift ? -1 : 1;
  // When focus is outside the list, forward lands on the first tabbable and
  // backward lands on the last — start searching "just outside" accordingly.
  let start = active;
  if (active < 0 || active >= n) start = shift ? 0 : n - 1;
  for (let hops = 1; hops <= n; hops++) {
    const idx = (((start + step * hops) % n) + n) % n;
    if (tabbable[idx]) return idx;
  }
  return null;
}

/** Build a TabbableProbe from a live element (DOM glue; untested by design). */
export function probeElement(el: HTMLElement): TabbableProbe {
  const cs = typeof el.ownerDocument !== 'undefined' ? el.ownerDocument.defaultView?.getComputedStyle(el) : undefined;
  const tabIndexAttr = el.getAttribute('tabindex');
  return {
    tagName: el.tagName,
    disabled: (el as HTMLButtonElement).disabled === true,
    tabIndex: tabIndexAttr === null ? Number.NaN : Number.parseInt(tabIndexAttr, 10),
    ariaHidden: el.getAttribute('aria-hidden') === 'true',
    hiddenAttr: el.hasAttribute('hidden'),
    inert: (el as HTMLElement & { inert?: boolean }).inert === true || el.hasAttribute('inert'),
    displayNone: cs?.display === 'none',
    visibilityHidden: cs?.visibility === 'hidden',
  };
}
