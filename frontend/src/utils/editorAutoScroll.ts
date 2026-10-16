/**
 * Auto-scroll maths for dragging a text selection inside the editor.
 *
 * Chromium/Firefox drag a selected block of text natively, but neither scrolls
 * the container when the pointer goes near (or past) an edge — so a block can
 * only be dropped on a line that is already on screen. The component runs a
 * requestAnimationFrame loop while a drag is in flight and asks this function
 * for the per-frame scroll delta.
 *
 * Pure so the ramp can be tested without layout (jsdom reports zero geometry).
 */

/** Distance from an edge where auto-scroll starts. */
export const DEFAULT_EDGE_ZONE_PX = 48;
/** Pixels per frame (≈ 60fps → ~960px/s) at full tilt. */
export const DEFAULT_MAX_STEP_PX = 16;

/**
 * Signed scroll delta (px) for a drag pointer at `clientY` over a viewport
 * spanning `[top, bottom]`.
 *
 * - `0` inside the safe band.
 * - ramps linearly to ±`maxStep` at the edge.
 * - saturates at ±`maxStep` once the pointer is outside the viewport entirely,
 *   so dragging past the bottom keeps scrolling while held there.
 *
 * The band is capped at half the viewport height, so a short editor (or a
 * pointer resting in the middle of a small window) never scrolls.
 */
export function autoScrollDelta(
  clientY: number,
  top: number,
  bottom: number,
  edgeZone: number = DEFAULT_EDGE_ZONE_PX,
  maxStep: number = DEFAULT_MAX_STEP_PX,
): number {
  const height = bottom - top;
  if (!Number.isFinite(clientY) || !(height > 0)) return 0;
  const zone = Math.min(edgeZone, height / 2);
  if (!(zone > 0)) return 0;

  const magnitude = (depth: number): number => {
    if (!(depth > 0)) return 0;
    const scaled = (Math.min(depth, zone) / zone) * maxStep;
    const rounded = Math.round(scaled);
    // Never stall right at the zone boundary: any overlap with the band moves.
    return rounded === 0 ? 1 : rounded;
  };

  if (clientY < top + zone) return -magnitude(top + zone - clientY);
  if (clientY > bottom - zone) return magnitude(clientY - (bottom - zone));
  return 0;
}
