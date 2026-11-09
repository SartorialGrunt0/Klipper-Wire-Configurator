import { useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { isTabbable, nextTrapIndex, probeElement } from '../utils/focusTrap';

/**
 * Shared modal wrapper: backdrop + panel with role="dialog", aria-modal,
 * initial focus into the dialog, Tab focus trap, and focus restore on close.
 *
 * Behaviour-preserving by construction: the backdrop's layout/opacity/z-classes
 * and click-to-close are per-instance props, so migrating an overlay does not
 * change how it looks or when it closes. Escape-to-close stays exactly where
 * it was (per-dialog); this component deliberately does NOT add it.
 *
 * The trap listens on the overlay (events bubble from anything focused inside
 * the panel). Focus that was never inside (e.g. user clicked the page behind
 * a stale overlay) is pulled to the first control on the next Tab.
 */

/** Elements the trap walks; tabbability is then filtered via isTabbable. */
export const FOCUSABLE_SELECTOR =
  'a[href],button,input,select,textarea,audio[controls],video[controls],[tabindex]';

export interface ModalProps {
  children: ReactNode;
  /** Backdrop click handler; omit to disable click-outside dismissal. */
  onClose?: () => void;
  /** id of the dialog's title element (preferred) ... */
  labelledBy?: string;
  /** ... or a direct accessible name when there is no visible title element. */
  label?: string;
  backdropClassName?: string;
  panelClassName?: string;
  /** Set false when the dialog manages its own initial focus entirely. */
  claimFocus?: boolean;
}

const DEFAULT_BACKDROP = 'fixed inset-0 z-50 flex items-center justify-center bg-black/50';

export default function Modal({
  children,
  onClose,
  labelledBy,
  label,
  backdropClassName = DEFAULT_BACKDROP,
  panelClassName = '',
  claimFocus = true,
}: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    restoreRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const panel = panelRef.current;
    if (!panel || !claimFocus) return;
    // Only claim focus when nothing else has it (a dialog's own autoFocus
    // input already holds focus at commit time — don't steal it).
    if (document.activeElement === document.body || document.activeElement === null) {
      const first = panel.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
      (first ?? panel).focus({ preventScroll: true });
    }
    return () => {
      const prev = restoreRef.current;
      if (prev && document.contains(prev)) prev.focus({ preventScroll: true });
    };
  }, [claimFocus]);

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Tab') return;
    const panel = panelRef.current;
    if (!panel) return;
    const els = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
    const flags = els.map((el) => isTabbable(probeElement(el)));
    const active = els.indexOf(document.activeElement as HTMLElement);
    const next = nextTrapIndex(flags, active, e.shiftKey);
    e.preventDefault();
    if (next !== null) els[next].focus();
  };

  return (
    <div className={backdropClassName} onClick={onClose} onKeyDown={handleKeyDown}>
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        aria-label={label}
        tabIndex={-1}
        className={panelClassName}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}
