/**
 * W8 — graceful context-window overflow (pure frontend logic).
 *
 * The backend (services/ai_context_overflow.py) owns the decision: the
 * pre-flight refusal and the provider-error mapping both answer
 * `errorCode: 'context_overflow'` on the /ai/chat error payload. The
 * frontend NEVER prose-matches the error message — the banner keys on the
 * structured code only. The fallback label exists for display when the
 * thrown error carries no usable message; both texts name the two actions
 * that actually fit in a window and demand no numbers of the user (W7 law).
 */

/** Structured error code from the backend — the single key for overflow UI. */
export const CONTEXT_OVERFLOW_ERROR_CODE = 'context_overflow';

/** Fallback banner label, mirroring the backend constant. Test-locked. */
export const CONTEXT_OVERFLOW_BANNER_FALLBACK =
  "This conversation exceeds the model's context window — start a new chat or drop pinned references.";

/** True only for the exact structured code — never prose, never nullish. */
export function isContextOverflowErrorCode(code: unknown): boolean {
  return code === CONTEXT_OVERFLOW_ERROR_CODE;
}
