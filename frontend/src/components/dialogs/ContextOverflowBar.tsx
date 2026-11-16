/**
 * W8 overflow banner.
 *
 * Shown when a send lands on the backend's structured context_overflow
 * error (its pre-flight refusal or a mapped provider context-length error).
 * Mirrors ContextPressureBar's idiom — one user-facing label, no numbers —
 * but wears the error token and, unlike the advisory, PERSISTS: overflow is
 * an event outcome, cleared only by starting/loading a chat (store reset),
 * not by a later quiet reply.
 */
import React from 'react';
import { useContextPressureStore } from '../../stores/contextPressureStore';

const ContextOverflowBar: React.FC = () => {
  const overflowMessage = useContextPressureStore((state) => state.overflowMessage);
  if (!overflowMessage) return null;
  return (
    <div
      role="status"
      className="border-t border-[var(--color-bg-tertiary)] bg-[var(--color-bg-secondary)] px-3 py-2 text-[10px]"
    >
      <span className="rounded-full bg-[var(--color-error)]/20 px-2 py-0.5 font-medium text-[var(--color-error)]">
        {overflowMessage}
      </span>
    </div>
  );
};

export default ContextOverflowBar;
