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
