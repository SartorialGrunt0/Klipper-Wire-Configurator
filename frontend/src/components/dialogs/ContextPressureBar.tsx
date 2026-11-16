/**
 * W7 context-pressure advisory bar.
 *
 * One user-facing label, no numbers: when the latest request's prompt size
 * reaches 70% of the model's REAL window (rule: utils/contextPressure),
 * recommend starting a new chat. Renders between the messages and the
 * change-set bar so it sits with the reply it describes, in both the modal
 * dialog and the docked panel.
 */
import React from 'react';
import { CONTEXT_PRESSURE_ADVISORY_TEXT } from '../../utils/contextPressure';
import { useContextPressureStore } from '../../stores/contextPressureStore';

const ContextPressureBar: React.FC = () => {
  const advisory = useContextPressureStore((state) => state.advisory);
  if (!advisory) return null;
  return (
    <div
      role="status"
      className="border-t border-[var(--color-bg-tertiary)] bg-[var(--color-bg-secondary)] px-3 py-2 text-[10px]"
    >
      <span className="rounded-full bg-[var(--color-warning)]/20 px-2 py-0.5 font-medium text-[var(--color-warning)]">
        {CONTEXT_PRESSURE_ADVISORY_TEXT}
      </span>
    </div>
  );
};

export default ContextPressureBar;
