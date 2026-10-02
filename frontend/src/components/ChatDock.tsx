/**
 * The text view's right-hand chat column.
 *
 * This component owns the *shell* only — the rail/expanded geometry and the
 * host element. The panel's content is the app's single `ChatDialog`
 * instance, portalled in from `Toolbar` (see the `variant` prop there):
 * mounting a second dialog here would mean two drafts, two approval cards
 * and an "which instance owns the in-flight request?" bug on the first fold.
 *
 * The fold control deliberately mirrors `ConfigTree`: expanded → a `>`
 * button in the header; collapsed → a `w-10` rail with a `<` button. One
 * idiom, two sides.
 */
import { useEffect, useRef } from 'react';

export interface ChatDockProps {
  /** Rail (true) or expanded column (false). */
  collapsed: boolean;
  /** Whether an AI provider is configured. Unconfigured → inert rail only. */
  configured: boolean;
  onToggle: () => void;
  /** Publishes the host element the chat shell portals into. */
  onRegisterHost: (host: HTMLElement | null) => void;
}

const RAIL_BUTTON_CLASS =
  'rounded border px-1.5 py-0.5 text-[10px] font-semibold transition-colors';

function ChatDock({ collapsed, configured, onToggle, onRegisterHost }: ChatDockProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const showRail = collapsed || !configured;

  // Publish the host element the chat shell portals into, and un-publish it
  // the moment the column goes away (folding, view switch, unmount). A stale
  // host would render the panel into a detached node — an invisible chat that
  // still owns the in-flight request.
  //
  // A ref callback would work too, but React 19 reads a returned function as
  // a cleanup, so this stays an effect where the contract is unambiguous.
  useEffect(() => {
    onRegisterHost(showRail ? null : hostRef.current);
    return () => onRegisterHost(null);
  }, [onRegisterHost, showRail]);

  if (showRail) {
    return (
      <div className="flex w-10 shrink-0 items-start justify-center border-l border-[var(--color-bg-tertiary)] bg-[var(--color-bg-secondary)] pt-2">
        <button
          onClick={onToggle}
          disabled={!configured}
          title={configured ? 'Show AI chat' : 'Configure an AI provider in AI Chat → Settings to enable the panel'}
          className={`${RAIL_BUTTON_CLASS} ${
            configured
              ? 'border-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]'
              : 'cursor-not-allowed border-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)] opacity-40'
          }`}
        >
          {'<'}
        </button>
      </div>
    );
  }

  return (
    <div
      ref={hostRef}
      className="flex w-[360px] shrink-0 flex-col border-l border-[var(--color-bg-tertiary)] bg-[var(--color-bg-secondary)] xl:w-[420px]"
    />
  );
}

export default ChatDock;
