/**
 * Context chip — the small ring at the foot of every assistant reply.
 *
 * The ring is this reply's context use: its prompt size against the model's
 * real window (rule: utils/contextChip — calm / warm at the W7 advisory
 * ratio / tight at 90%). Hover, focus or tap reveals the numbers; nothing is
 * on screen but a circle, which is why the reply still reads as one block.
 *
 * Deliberately silent about numbers until asked: the transcript's business is
 * the answer, and a readout next to every message is noise until the moment
 * the user wants it.
 */
import React, { useEffect, useRef, useState } from 'react';

import {
  buildContextChipDetails,
  computeContextGauge,
  formatTokenCount,
  resolveContextWindow,
  type ContextBand,
} from '../../utils/contextChip';
import type { MessageContextUsage } from '../../stores/aiStore';
import { useContextPressureStore } from '../../stores/contextPressureStore';

/** Ring geometry: 16-unit box, 6.5-unit radius, 1.8-unit stroke — sized
 *  so the circle reads at the same weight as the Copy glyph beside it. */
const RADIUS = 6.5;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

const BAND_STROKE: Record<ContextBand, string> = {
  calm: 'var(--color-text-secondary)',
  warm: 'var(--color-warning)',
  tight: 'var(--color-error)',
};

interface ContextChipProps {
  usage: MessageContextUsage;
  /** Executed tool calls for this reply (0 hides the row). */
  toolCalls?: number;
}

const ContextChip: React.FC<ContextChipProps> = ({ usage, toolCalls }) => {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // A tap that lands anywhere else closes the panel — the mouse-leave path
  // never fires on touch, so the outside tap is the touch equivalent.
  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  // The window probe is fire-and-forget, so the first reply of a session
  // lands without one. Subscribing to the store lets that reply's chip fill
  // in once the probe settles, while resolveContextWindow refuses a window
  // probed for a different provider or model.
  const probedKey = useContextPressureStore((state) => state.probedKey);
  const probedWindow = useContextPressureStore((state) => state.contextWindow);
  const contextWindow = resolveContextWindow({
    messageWindow: usage.contextWindow,
    messageKey: usage.windowKey,
    probedKey,
    probedWindow,
  });

  const gauge = computeContextGauge({
    promptTokens: usage.promptTokens,
    contextWindow,
  });
  const details = buildContextChipDetails({
    promptTokens: usage.promptTokens,
    cachedTokens: usage.cachedTokens,
    contextWindow,
    replyMs: usage.replyMs,
    toolCalls: toolCalls ?? 0,
    model: usage.model,
  });

  // Nothing worth showing? Show nothing — a chip with no numbers is furniture.
  if (details.length === 0 && gauge === null) return null;

  const stroke = gauge ? BAND_STROKE[gauge.band] : 'var(--color-text-secondary)';
  const dash = gauge ? CIRCUMFERENCE * gauge.ratio : 0;
  const percent = gauge ? Math.round(gauge.ratio * 100) : null;
  const label = gauge
    ? `Context used: ${percent}% of the model's window`
    : `Context used: ${formatTokenCount(usage.promptTokens)} tokens (window unknown)`;

  return (
    <div ref={containerRef} className="relative inline-flex">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        // Review #9: a touch tap fires pointerenter BEFORE click, so an
        // ungated enter opened the readout and the click then toggled it
        // shut — tap could never open it. Hover-gate to mouse pointers;
        // touch opens via the click toggle and closes via outside tap.
        onPointerEnter={(event) => {
          if (event.pointerType === 'mouse') setOpen(true);
        }}
        onPointerLeave={(event) => {
          if (event.pointerType === 'mouse') setOpen(false);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') setOpen(false);
        }}
        className="rounded p-1 text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-bg-tertiary)]"
        aria-label={label}
        aria-expanded={open}
        title={gauge ? `${percent}% of the context window` : 'Context used'}
        data-testid="context-chip"
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <circle
            cx="8"
            cy="8"
            r={RADIUS}
            stroke="var(--color-bg-tertiary)"
            strokeWidth="1.8"
          />
          {gauge !== null && (
            <circle
              cx="8"
              cy="8"
              r={RADIUS}
              stroke={stroke}
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeDasharray={`${dash} ${CIRCUMFERENCE}`}
              transform="rotate(-90 8 8)"
            />
          )}
        </svg>
      </button>

      {open && (
        <div
          role="tooltip"
          className="absolute bottom-full right-0 z-20 mb-1 min-w-[168px] rounded-md border border-[var(--color-bg-tertiary)] bg-[var(--color-bg-secondary)] px-2 py-1.5 text-[10px] shadow-lg"
          data-testid="context-chip-panel"
        >
          {details.map((detail) => (
            <div key={detail.label} className="flex items-baseline justify-between gap-3 py-0.5">
              <span className="shrink-0 text-[var(--color-text-secondary)]">{detail.label}</span>
              <span className="text-right font-medium text-[var(--color-text-primary)]">
                {detail.value}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default ContextChip;
