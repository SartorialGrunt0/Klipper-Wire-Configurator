/**
 * The text view's right-hand chat column.
 *
 * This component owns the *shell* only — the column geometry and the host
 * element. The panel's content is the app's single `ChatDialog` instance,
 * portalled in from `Toolbar` (see the `variant` prop there): mounting a second
 * dialog here would mean two drafts, two approval cards and an "which instance
 * owns the in-flight request?" bug on the first fold.
 *
 * Folded away it renders NOTHING — a rail would still be 40px of horizontal
 * space doing nothing. The toggle is the editor toolbar's chat bubble, which
 * sits where this panel's own header control does when the panel is open
 * (Cliff, 2026-10-04). The same icon states the panel's visibility: accent blue
 * when the dock is out, grey when it is folded.
 */
import { useEffect, useRef } from 'react';

export interface ChatDockProps {
  /** Rail (true) or expanded column (false). */
  collapsed: boolean;
  /** Whether an AI provider is configured. Unconfigured → no column at all. */
  configured: boolean;
  /** Publishes the host element the chat shell portals into. */
  onRegisterHost: (host: HTMLElement | null) => void;
}

function ChatDock({ collapsed, configured, onRegisterHost }: ChatDockProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const showPanel = !collapsed && configured;

  // Publish the host element the chat shell portals into, and un-publish it
  // the moment the column goes away (folding, view switch, unmount). A stale
  // host would render the panel into a detached node — an invisible chat that
  // still owns the in-flight request.
  //
  // A ref callback would work too, but React 19 reads a returned function as
  // a cleanup, so this stays an effect where the contract is unambiguous.
  useEffect(() => {
    onRegisterHost(showPanel ? hostRef.current : null);
    return () => onRegisterHost(null);
  }, [onRegisterHost, showPanel]);

  if (!showPanel) return null;

  return (
    <div
      ref={hostRef}
      className="flex w-[360px] shrink-0 flex-col border-l border-[var(--color-bg-tertiary)] bg-[var(--color-bg-secondary)] xl:w-[420px]"
    />
  );
}

export default ChatDock;
