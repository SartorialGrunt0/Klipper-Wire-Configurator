/**
 * Where the review strip's cursor lands after the review moved under it.
 *
 * The stops themselves are the mechanical ledger's runs now (Sir, 2026-10-07):
 * `reviewEngine.reviewStops()` walks `diff(FRAME, LIVE)` directly, so the old
 * change-stop pairing (`changeStops`, `buildReviewStops`) that matched a
 * rendered diff row against a pending row's own diff text is gone — there is
 * no second coordinate space to reconcile.
 *
 * Only the anchor rule survives, kept pure because the cursor's behaviour on a
 * decision is easy to get subtly wrong.
 *
 * Pure: no React, no store, no DOM.
 */

/**
 * Where the cursor lands after the review moved under it.
 *
 * IDENTITY FIRST: if the change the reader was on is still in the list, the
 * cursor stays on it — so a change decided from somewhere else (the chat's
 * summary bar) must not drag the reader off what they are reading. Otherwise
 * the change is gone (decided, or undone): the cursor takes whatever now
 * occupies its slot, clamped to the last item, so reviewing downward stays
 * downward.
 *
 * Identity is the stop's key (the caller passes single-element `ids` arrays).
 * Line numbers deliberately play no part — they are numbered inside ONE file,
 * and this list spans every file in the review.
 */
export function stopIndexForAnchor(
  stops: readonly { ids: readonly string[] }[],
  anchorIds: readonly string[],
  fallbackIndex: number,
): number {
  if (stops.length === 0) return -1;
  const anchor = new Set(anchorIds);
  const at = stops.findIndex((stop) => stop.ids.some((id) => anchor.has(id)));
  if (at >= 0) return at;
  return Math.min(Math.max(fallbackIndex, 0), stops.length - 1);
}
