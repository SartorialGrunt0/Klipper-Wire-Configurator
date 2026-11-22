/**
 * Context chip — per-reply context telemetry, kept pure so the rules are
 * testable without a DOM.
 *
 * The chip's ring is the reply's prompt size as a share of the model's REAL
 * window (the router's n_ctx, not the model card). It fires its warm band at
 * the SAME ratio as the W7 advisory, so the little ring and the big warning
 * label can never disagree about what "most of the window" means.
 *
 * Every unknown stays unknown: a missing measurement is an em dash, never a
 * zero. A provider that over-reports clamps to a full ring instead of drawing
 * past the circle.
 */

import { CONTEXT_PRESSURE_ADVISORY_RATIO } from './contextPressure';

/** The ring turns red here — one step past "start a new chat". */
export const CONTEXT_CHIP_TIGHT_RATIO = 0.9;

export type ContextBand = 'calm' | 'warm' | 'tight';

export interface ContextGaugeInput {
  /** Prompt tokens the provider reported for this reply's last call. */
  promptTokens: number | null | undefined;
  /** The provider's real context window for the model that answered. */
  contextWindow: number | null | undefined;
}

export interface ContextGauge {
  promptTokens: number;
  contextWindow: number;
  /** prompt/window clamped to [0, 1]. */
  ratio: number;
  band: ContextBand;
}

export interface ChipDetail {
  label: string;
  value: string;
}

export interface ChipDetailsInput extends ContextGaugeInput {
  /** Cached prefix tokens of the same call (null when unreported). */
  cachedTokens: number | null | undefined;
  /** Wall-clock duration of the reply as the client saw it. */
  replyMs: number | null | undefined;
  /** Executed tool calls in this reply (0 clears the row). */
  toolCalls: number | null | undefined;
  model: string | null | undefined;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Build the ring. Null — meaning "draw no gauge" — whenever either side is
 * unknown or nonsensical, exactly like evaluateContextPressure.
 */
export function computeContextGauge(input: ContextGaugeInput): ContextGauge | null {
  const promptTokens = finiteNumber(input.promptTokens);
  const contextWindow = finiteNumber(input.contextWindow);
  if (promptTokens === null || contextWindow === null) return null;
  if (promptTokens < 0 || contextWindow <= 0) return null;

  const raw = promptTokens / contextWindow;
  const ratio = Math.min(1, Math.max(0, raw));
  let band: ContextBand = 'calm';
  if (ratio >= CONTEXT_CHIP_TIGHT_RATIO) band = 'tight';
  else if (ratio >= CONTEXT_PRESSURE_ADVISORY_RATIO) band = 'warm';

  return { promptTokens, contextWindow, ratio, band };
}

/**
 * Which window a rendered chip may use.
 *
 * A reply captures the window it knew when it landed; the session's probe
 * usually settles DURING that reply (ensureWindow is fire-and-forget), so the
 * first reply of a session would otherwise draw a ring with no percentage
 * forever. The live probe may fill that gap only when it belongs to the SAME
 * provider+model the reply was sent under — a window probed for a different
 * model must never be borrowed (it would draw a confident, wrong ring).
 */
export interface ContextWindowResolutionInput {
  /** Window captured with the message, if the probe had already landed. */
  messageWindow: number | null | undefined;
  /** Provider+model identity that reply was sent under. */
  messageKey: string | null | undefined;
  /** The session store's currently probed identity + window. */
  probedKey: string | null | undefined;
  probedWindow: number | null | undefined;
}

export function resolveContextWindow(input: ContextWindowResolutionInput): number | null {
  const own = finiteNumber(input.messageWindow);
  if (own !== null && own > 0) return own;

  const key = typeof input.messageKey === 'string' ? input.messageKey : null;
  const probedKey = typeof input.probedKey === 'string' ? input.probedKey : null;
  if (key === null || probedKey === null || key !== probedKey) return null;

  const live = finiteNumber(input.probedWindow);
  return live !== null && live > 0 ? live : null;
}

/** 47,707 — grouped, so used/total reads at a glance. */
export function formatExactTokens(tokens: number | null | undefined): string {
  const value = finiteNumber(tokens);
  if (value === null || value < 0) return '—';
  return Math.round(value).toLocaleString('en-US');
}

/** 47.7K — compact, for reuse figures. */
export function formatTokenCount(tokens: number | null | undefined): string {
  const value = finiteNumber(tokens);
  if (value === null || value < 0) return '—';
  const round = Math.round(value);
  if (round < 1000) return String(round);
  if (round < 1_000_000) return `${(round / 1000).toFixed(1)}K`;
  return `${(round / 1_000_000).toFixed(1)}M`;
}

/** 850 ms / 8.2 s / 2m 05s — the scale a reply actually lives at. */
export function formatDuration(ms: number | null | undefined): string {
  const value = finiteNumber(ms);
  if (value === null || value < 0) return '—';
  if (value < 1000) return `${Math.round(value)} ms`;
  if (value < 60_000) return `${(value / 1000).toFixed(1)} s`;
  const minutes = Math.floor(value / 60_000);
  const seconds = Math.round((value % 60_000) / 1000);
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

/**
 * The hover/tap panel's rows, in reading order. Rows that carry no knowledge
 * are dropped rather than shown empty; a provider that reports no cache
 * numbers yields no Cached row at all (a missing measurement must never read
 * as a 0% hit rate), while a reported zero renders as a miss.
 */
export function buildContextChipDetails(input: ChipDetailsInput): ChipDetail[] {
  const details: ChipDetail[] = [];
  const promptTokens = finiteNumber(input.promptTokens);
  const contextWindow = finiteNumber(input.contextWindow);

  if (promptTokens !== null && promptTokens >= 0) {
    if (contextWindow !== null && contextWindow > 0) {
      const percent = Math.round(Math.min(1, promptTokens / contextWindow) * 100);
      details.push({
        label: 'Context',
        value: `${formatExactTokens(promptTokens)} / ${formatExactTokens(contextWindow)} tokens (${percent}%)`,
      });
    } else {
      details.push({ label: 'Context', value: `${formatExactTokens(promptTokens)} tokens` });
    }
  }

  const cached = finiteNumber(input.cachedTokens);
  if (cached !== null && cached >= 0 && promptTokens !== null && promptTokens > 0) {
    const share = Math.round(Math.min(1, cached / promptTokens) * 100);
    details.push({
      label: 'Cached',
      value: cached === 0
        ? '0% — nothing reused'
        : `${share}% — ${formatTokenCount(cached)} tokens reused`,
    });
  }

  const replyMs = finiteNumber(input.replyMs);
  if (replyMs !== null && replyMs >= 0) {
    details.push({ label: 'Reply', value: formatDuration(replyMs) });
  }

  const toolCalls = finiteNumber(input.toolCalls);
  if (toolCalls !== null && toolCalls > 0) {
    details.push({
      label: 'Tool calls',
      value: `${Math.round(toolCalls)} ${toolCalls === 1 ? 'call' : 'calls'}`,
    });
  }

  if (typeof input.model === 'string' && input.model.trim() !== '') {
    details.push({ label: 'Model', value: input.model.trim() });
  }

  return details;
}
