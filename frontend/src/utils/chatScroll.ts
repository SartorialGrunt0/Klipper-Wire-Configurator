/**
 * Chat auto-scroll stickiness (display logic, no DOM).
 *
 * The AI chat messages area should follow new content while the user is
 * at the bottom, and get out of the way the moment they scroll up to read
 * history. The component owns the refs; the decision itself is here so it
 * is testable:
 * - `isNearBottom` — bottom detection with a small tolerance so tiny
 *   layout reflows (KaTeX/code-block growth) still count as "at bottom".
 * - `nextStickToBottom` — stick-state machine folded from each scroll
 *   event: reaching the bottom sticks; a genuine upward scroll releases;
 *   anything else (programmatic smooth-scroll ticks, content-shrink
 *   clamps) leaves the state untouched.
 */

/** Distance from the bottom (px) still treated as "at the bottom". */
export const CHAT_STICK_THRESHOLD_PX = 48;

/** True when the viewport sits within the stick threshold of the bottom.
 *  Non-overflowing content (scrollHeight <= clientHeight) is always bottom. */
export function isNearBottom(
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
): boolean {
  return scrollHeight - (scrollTop + clientHeight) <= CHAT_STICK_THRESHOLD_PX;
}

/**
 * Fold one scroll event into the stick state.
 *
 * @param stick       current follow state
 * @param nearBottom  viewport within threshold of the bottom NOW
 * @param scrolledUp  the event's delta was upward (scrollTop decreased)
 *
 * - At the bottom → stick (the user arriving at the bottom re-arms follow).
 * - Genuine upward scroll away from the bottom → release.
 * - Downward/neutral deltas keep the state: a mid-animation programmatic
 *   smooth scroll must not unstick itself, and scrolling DOWN through
 *   history must not re-arm follow before the bottom is actually reached.
 */
export function nextStickToBottom(
  stick: boolean,
  nearBottom: boolean,
  scrolledUp: boolean,
): boolean {
  if (nearBottom) return true;
  if (scrolledUp) return false;
  return stick;
}
