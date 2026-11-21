/**
 * W7 — context-pressure advisory (pure logic).
 *
 * The advisory fires when the provider-reported prompt size of the latest
 * request eats at least 70% of the model's REAL context window (the router's
 * n_ctx, not the model card). One label, no numbers demanded of the user —
 * everything numeric stays here so the rule is testable without a DOM.
 */

/** pi's amber threshold (context-window harness research, 2026-11-12). */
export const CONTEXT_PRESSURE_ADVISORY_RATIO = 0.7;

export const CONTEXT_PRESSURE_ADVISORY_TEXT =
  'This conversation is using most of the model’s context — starting a new chat is recommended.';

export interface ContextPressureInput {
  /** Prompt tokens reported for the latest provider request (usage.prompt_tokens). */
  lastPromptTokens: number | null | undefined;
  /** The provider's real context window for the current model. */
  contextWindow: number | null | undefined;
}

export interface CachedShareInput {
  /** Prompt tokens of the same request cachedShare is measured for. */
  lastPromptTokens: number | null | undefined;
  /** Cached prefix tokens of that request (usage.prompt_tokens_details.
   *  cached_tokens / Anthropic cache_read_input_tokens; backend field
   *  cachedTokens / usage.lastCachedTokens). */
  lastCachedTokens: number | null | undefined;
}

export interface ContextPressureVerdict {
  advisory: boolean;
  /** prompt/window when both sides are known, else null. */
  ratio: number | null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Decide whether to show the context-pressure advisory.
 *
 * Deliberately silent (advisory false, ratio null) whenever either side of
 * the comparison is unknown or nonsensical — a guess about the window must
 * never produce (or suppress) the label.
 */
export function evaluateContextPressure(input: ContextPressureInput): ContextPressureVerdict {
  const tokens = finiteNumber(input.lastPromptTokens);
  const window = finiteNumber(input.contextWindow);
  if (tokens === null || window === null || tokens < 0 || window <= 0) {
    return { advisory: false, ratio: null };
  }
  const ratio = tokens / window;
  return { advisory: ratio >= CONTEXT_PRESSURE_ADVISORY_RATIO, ratio };
}

/**
 * C3 prefix-cache telemetry: the cached share of the latest provider
 * request (cached_tokens / prompt_tokens). Providers that don't report
 * cached_tokens yield null — a missing measurement is never shown as a
 * 0% hit rate. A nonsensical cached > prompt clamps to 1 (a provider
 * bug must not read as a broken cache story). 0 with a warm conversation
 * means something upstream of the tail started moving.
 */
export function computeCachedShare(input: CachedShareInput): number | null {
  const prompt = finiteNumber(input.lastPromptTokens);
  const cached = finiteNumber(input.lastCachedTokens);
  if (prompt === null || cached === null || prompt <= 0 || cached < 0) {
    return null;
  }
  return Math.min(1, cached / prompt);
}
