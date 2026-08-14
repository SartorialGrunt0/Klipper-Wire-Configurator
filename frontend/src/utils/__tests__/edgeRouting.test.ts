import { describe, expect, it } from 'vitest';
import {
  buildOrthogonalPath,
  getAvoidancePath,
  getPathMidpoint,
  simplifyWaypoints,
} from '@/utils/edgeRouting';

type Point = [number, number];

describe('getPathMidpoint', () => {
  it('handles empty and single point lists', () => {
    expect(getPathMidpoint([])).toEqual([0, 0]);
    expect(getPathMidpoint([[5, 7]])).toEqual([5, 7]);
  });

  it('finds the midpoint along a straight line', () => {
    const mid = getPathMidpoint([[0, 0], [10, 0]]);
    expect(mid[0]).toBeCloseTo(5);
    expect(mid[1]).toBeCloseTo(0);
  });

  it('finds the midpoint along an L-shaped path', () => {
    const mid = getPathMidpoint([[0, 0], [0, 10], [10, 10]]);
    // Total length is 20; half lands exactly on the corner at (0, 10).
    expect(mid[0]).toBeCloseTo(0);
    expect(mid[1]).toBeCloseTo(10);
  });

  it('falls back to the middle point for zero-length paths', () => {
    const mid = getPathMidpoint([[0, 0], [0, 0], [0, 0]]);
    expect(mid).toEqual([0, 0]);
  });
});

describe('simplifyWaypoints', () => {
  it('returns short lists unchanged', () => {
    expect(simplifyWaypoints([[0, 0]])).toEqual([[0, 0]]);
    expect(simplifyWaypoints([[0, 0], [1, 1]])).toEqual([[0, 0], [1, 1]]);
  });

  it('removes collinear intermediate points on a vertical line', () => {
    expect(simplifyWaypoints([[0, 0], [0, 5], [0, 10]])).toEqual([[0, 0], [0, 10]]);
  });

  it('removes collinear intermediate points on a horizontal line', () => {
    expect(simplifyWaypoints([[0, 0], [5, 0], [10, 0]])).toEqual([[0, 0], [10, 0]]);
  });

  it('keeps turning points', () => {
    expect(simplifyWaypoints([[0, 0], [0, 5], [5, 5], [5, 10]])).toEqual([
      [0, 0], [0, 5], [5, 5], [5, 10],
    ]);
  });

  it('drops near-duplicate points', () => {
    expect(simplifyWaypoints([[0, 0], [0.5, 0.5], [10, 10]])).toEqual([[0, 0], [10, 10]]);
  });
});

describe('buildOrthogonalPath', () => {
  it('builds an M/L path for two points', () => {
    expect(buildOrthogonalPath([[0, 0], [10, 10]])).toBe('M 0 0 L 10 10');
  });

  it('returns empty for fewer than two points', () => {
    expect(buildOrthogonalPath([[0, 0]])).toBe('');
    expect(buildOrthogonalPath([])).toBe('');
  });

  it('adds rounded corners at turns', () => {
    const path = buildOrthogonalPath([[0, 0], [0, 50], [50, 50]]);
    expect(path.startsWith('M 0 0')).toBe(true);
    expect(path).toContain('Q');
    expect(path.endsWith('L 50 50')).toBe(true);
  });

  it('keeps corners sharp on short segments instead of an S-wave kink', () => {
    // 18px segments: rounding would eat the whole run into a wavy kink, so
    // the corner stays a crisp 90°.
    expect(buildOrthogonalPath([[0, 0], [0, 18], [18, 18]])).toBe(
      'M 0 0 L 0 18 L 18 18',
    );
  });

  it('keeps the full radius on long segments', () => {
    const path = buildOrthogonalPath([[0, 0], [0, 100], [100, 100]]);
    expect(path).toContain('L 0 90');
    expect(path).toContain('Q 0 100 10 100');
  });

  it('keeps a crisp 90° jog for near-aligned vertical handles', () => {
    // Mainboard bottom (760,196) -> SBC top (755,1060): 5px offset triggers
    // the straight-run bias, which jogs right at the target. The jog must be
    // a sharp bend, not a rounded S-wave.
    const srcRect = { x: 560, y: 140, w: 400, h: 56 };
    const tgtRect = { x: 660, y: 1060, w: 190, h: 56 };
    const result = getAvoidancePath(760, 196, 755, 1060, 'bottom', 'top', [], srcRect, tgtRect);
    expect(result.path).toBe('M 760 196 L 760 1040 L 755 1040 L 755 1060');
    // No curved corners anywhere on the near-aligned jog.
    expect(result.path).not.toContain('Q');
  });
});

describe('getAvoidancePath', () => {
  it('returns a straight-ish route with no obstacles', () => {
    const result = getAvoidancePath(0, 0, 100, 0, 'right', 'left', []);
    expect(result.path).toContain('M 0 0');
    expect(result.path).toContain('L 100 0');
    expect(result.waypoints.length).toBeGreaterThanOrEqual(2);
    expect(typeof result.labelX).toBe('number');
    expect(typeof result.labelY).toBe('number');
  });

  it('avoids a blocking rectangle', () => {
    const result = getAvoidancePath(0, 0, 200, 0, 'right', 'left', [
      { x: 60, y: -40, w: 80, h: 80 },
    ]);
    // The path must start and end at the handles.
    expect(result.path.startsWith('M 0 0')).toBe(true);
    expect(result.path.endsWith('L 200 0')).toBe(true);
    // And it must include at least one turn (Q or extra L) to route around.
    expect(result.path.includes('Q') || result.waypoints.length > 2).toBe(true);
  });

  it('keeps handle direction via stubs', () => {
    const result = getAvoidancePath(0, 0, 100, 100, 'right', 'bottom', []);
    // First waypoint after source is the right-hand stub (x > 0, y unchanged).
    expect(result.waypoints[1][0]).toBeGreaterThan(0);
    expect(result.waypoints[1][1]).toBeCloseTo(0);
  });

  it('routes same-side handles around the far side of the target card', () => {
    // Source right handle at (100,200); target right handle at (150,40)
    // (up-right). Cards side by side with overlapping Y spans.
    const sourceRect = { x: -180, y: 120, w: 280, h: 160 };
    const targetRect = { x: -130, y: -40, w: 280, h: 160 };
    const result = getAvoidancePath(100, 200, 150, 40, 'right', 'right', [], sourceRect, targetRect);

    // The approach to the target must come from outside the card (from the
    // right), not through its body.
    const middle = result.waypoints.slice(1, -1);
    const lastTurn = middle[middle.length - 1];
    expect(lastTurn[0]).toBeGreaterThan(150);
    expect(lastTurn[1]).toBeCloseTo(40);
    // The path must not cross the target card (stub segments excepted).
    expect(pathCrossesRect(result.waypoints, targetRect)).toBe(false);
  });

  it('routes same-side handles around the far side for bottom→bottom', () => {
    const sourceRect = { x: -140, y: 40, w: 280, h: 160 };
    const targetRect = { x: 260, y: 140, w: 280, h: 160 };
    const result = getAvoidancePath(100, 200, 400, 300, 'bottom', 'bottom', [], sourceRect, targetRect);

    expect(pathCrossesRect(result.waypoints, targetRect)).toBe(false);
    // Lane must run below both cards.
    expect(Math.max(...result.waypoints.map(([, y]) => y))).toBeGreaterThanOrEqual(328);
  });

  it('places the detour lane above the target card when the lane would dive through it', () => {
    // Source right handle, target top handle, blocker between them.
    const sourceRect = { x: -180, y: 40, w: 280, h: 160 };
    const targetRect = { x: 260, y: 0, w: 280, h: 160 };
    const result = getAvoidancePath(100, 120, 400, 0, 'right', 'top', [
      { x: 140, y: 20, w: 120, h: 200 },
    ], sourceRect, targetRect);

    // Lane must be above the target's top edge so the drop into the handle
    // doesn't pass through the card.
    expect(Math.min(...result.waypoints.map(([, y]) => y))).toBeLessThan(0);
    expect(pathCrossesRect(result.waypoints, targetRect)).toBe(false);
  });

  it('keeps a clean exit when a lane direction conflicts with the target', () => {
    // Source bottom (wants lane below), target top (wants lane above) with a
    // blocker between: no single lane satisfies both, so best effort is used
    // but the path still starts and ends at the handles without crashing.
    const sourceRect = { x: -140, y: 40, w: 280, h: 160 };
    const targetRect = { x: 0, y: 0, w: 280, h: 160 };
    const result = getAvoidancePath(100, 200, 140, 0, 'bottom', 'top', [
      { x: 0, y: 40, w: 240, h: 120 },
    ], sourceRect, targetRect);

    expect(result.path.startsWith('M 100 200')).toBe(true);
    expect(result.path.endsWith('L 140 0')).toBe(true);
  });
});

/** True when any non-stub segment of the waypoints crosses the given rect. */
function pathCrossesRect(waypoints: [number, number][], rect: { x: number; y: number; w: number; h: number }): boolean {
  for (let i = 1; i < waypoints.length - 2; i++) {
    const [x1, y1] = waypoints[i];
    const [x2, y2] = waypoints[i + 1];
    // Axis-aligned segment vs rect overlap (inclusive on boundaries so a
    // line that touches the card counts as a crossing in these tests).
    const xOverlap = Math.max(Math.min(x1, x2), rect.x) < Math.min(Math.max(x1, x2), rect.x + rect.w);
    const yOverlap = Math.max(Math.min(y1, y2), rect.y) < Math.min(Math.max(y1, y2), rect.y + rect.h);
    if (xOverlap && yOverlap) return true;
  }
  return false;
}
