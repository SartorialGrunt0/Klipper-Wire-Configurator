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
});
