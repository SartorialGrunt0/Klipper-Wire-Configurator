/**
 * Obstacle-avoidance edge routing utilities.
 *
 * Given source/target positions, handle directions, and a list of hardware
 * node bounding boxes, returns an SVG path string that routes around any
 * blocking nodes while maintaining proper handle attachment.
 */

export interface NodeRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Extra space around each obstacle box */
const CLEARANCE = 28;
/** Extra space around the connected source/target cards (they can be approached closely) */
const CONNECTED_CLEARANCE = 2;
/** SVG corner radius at waypoint turns */
const CORNER_R = 10;
/** Distance to extend from handle before routing */
const STUB_LEN = 20;
/** Prefer endpoint-local bends over midpoint doglegs for almost-straight runs */
const STRAIGHT_RUN_BIAS_THRESHOLD = 16;

type Point = [number, number];

interface CheckRect extends NodeRect {
  clearance: number;
}

export function getPathMidpoint(pts: Point[]): Point {
  if (pts.length === 0) return [0, 0];
  if (pts.length === 1) return pts[0];

  const lengths = pts.slice(1).map((point, index) => (
    Math.abs(point[0] - pts[index][0]) + Math.abs(point[1] - pts[index][1])
  ));
  const totalLength = lengths.reduce((sum, length) => sum + length, 0);

  if (totalLength <= 0) {
    return pts[Math.floor(pts.length / 2)];
  }

  const targetLength = totalLength / 2;
  let traversed = 0;

  for (let index = 0; index < lengths.length; index += 1) {
    const segmentLength = lengths[index];
    if (traversed + segmentLength < targetLength) {
      traversed += segmentLength;
      continue;
    }

    const [x1, y1] = pts[index];
    const [x2, y2] = pts[index + 1];
    if (segmentLength === 0) {
      return [x1, y1];
    }

    const ratio = (targetLength - traversed) / segmentLength;
    return [
      x1 + (x2 - x1) * ratio,
      y1 + (y2 - y1) * ratio,
    ];
  }

  return pts[pts.length - 1];
}

// ── Liang-Barsky segment vs AABB intersection ──────────────────────────────

function segmentIntersectsRect(
  x1: number, y1: number,
  x2: number, y2: number,
  rect: CheckRect,
): boolean {
  const rx = rect.x - rect.clearance;
  const ry = rect.y - rect.clearance;
  const rw = rect.w + rect.clearance * 2;
  const rh = rect.h + rect.clearance * 2;

  const dx = x2 - x1;
  const dy = y2 - y1;

  let tMin = 0;
  let tMax = 1;

  const clip = (p: number, q: number): boolean => {
    if (p === 0) return q >= 0;
    const r = q / p;
    if (p < 0) {
      if (r > tMax) return false;
      if (r > tMin) tMin = r;
    } else {
      if (r < tMin) return false;
      if (r < tMax) tMax = r;
    }
    return true;
  };

  return (
    clip(-dx, x1 - rx) &&
    clip(dx, rx + rw - x1) &&
    clip(-dy, y1 - ry) &&
    clip(dy, ry + rh - y1) &&
    tMin <= tMax
  );
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Compute a stub point offset from handle position in the handle's facing direction */
function stubPoint(x: number, y: number, side: string): Point {
  switch (side) {
    case 'left': return [x - STUB_LEN, y];
    case 'right': return [x + STUB_LEN, y];
    case 'top': return [x, y - STUB_LEN];
    case 'bottom': return [x, y + STUB_LEN];
    default: return [x + STUB_LEN, y];
  }
}

function isHorizontalSide(side: string): boolean {
  return side === 'left' || side === 'right';
}

/** Remove collinear intermediate points and near-duplicates */
export function simplifyWaypoints(pts: Point[]): Point[] {
  if (pts.length <= 2) return pts;
  const result: Point[] = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const prev = result[result.length - 1];
    const curr = pts[i];
    const next = pts[i + 1];
    // Skip if all three are on the same vertical or horizontal line
    if (prev[0] === curr[0] && curr[0] === next[0]) continue;
    if (prev[1] === curr[1] && curr[1] === next[1]) continue;
    // Skip if effectively same point as prev
    if (Math.abs(prev[0] - curr[0]) < 1 && Math.abs(prev[1] - curr[1]) < 1) continue;
    result.push(curr);
  }
  const last = pts[pts.length - 1];
  const beforeLast = result[result.length - 1];
  if (Math.abs(beforeLast[0] - last[0]) < 1 && Math.abs(beforeLast[1] - last[1]) < 1) {
    result[result.length - 1] = last;
  } else {
    result.push(last);
  }
  return result;
}

/**
 * Check if any segment of a path intersects a rectangle.
 *
 * When `skipStubSegments` is true, the first and last segments (the 20px
 * handle stubs) are exempt — they touch the connected card's edge by design
 * and must not be treated as crossings.
 */
function pathIntersectsRect(pts: Point[], rect: CheckRect, skipStubSegments = false): boolean {
  const start = skipStubSegments ? 1 : 0;
  const end = skipStubSegments ? pts.length - 2 : pts.length - 1;
  for (let i = start; i < end; i++) {
    if (segmentIntersectsRect(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], rect)) {
      return true;
    }
  }
  return false;
}

function pathLength(pts: Point[]): number {
  return pts.reduce(
    (sum, p, i) =>
      i === 0
        ? 0
        : sum + Math.abs(p[0] - pts[i - 1][0]) + Math.abs(p[1] - pts[i - 1][1]),
    0,
  );
}

/** Coordinate of the far side of the target card for same-side handle routing */
function farSideCoordinate(side: string, tx: number, ty: number, targetRect?: NodeRect): number {
  switch (side) {
    case 'right': return (targetRect ? targetRect.x + targetRect.w : tx) + CLEARANCE;
    case 'left': return (targetRect ? targetRect.x : tx) - CLEARANCE;
    case 'bottom': return (targetRect ? targetRect.y + targetRect.h : ty) + CLEARANCE;
    case 'top': return (targetRect ? targetRect.y : ty) - CLEARANCE;
    default: return (targetRect ? targetRect.x + targetRect.w : tx) + CLEARANCE;
  }
}

/**
 * Whether a horizontal lane at `laneY` (spanning x0..x1) may be used, given
 * the handle directions of the connected cards. A top handle must be entered
 * from above, a bottom handle from below — routing a lane the other way would
 * force the line to double back on itself at the stub.
 */
function laneAllowed(side: string, isTop: boolean): boolean {
  if (side === 'top') return isTop;
  if (side === 'bottom') return !isTop;
  return true;
}

function isFiniteNumber(n: number): boolean {
  return Number.isFinite(n);
}

// ── Orthogonal path builder with rounded corners ───────────────────────────

export function buildOrthogonalPath(pts: Point[]): string {
  if (pts.length < 2) return '';
  let d = `M ${pts[0][0]} ${pts[0][1]}`;
  for (let i = 1; i < pts.length; i++) {
    const [x, y] = pts[i];
    if (i < pts.length - 1) {
      const [px, py] = pts[i - 1];
      const [nx, ny] = pts[i + 1];
      const inDx = Math.sign(x - px);
      const inDy = Math.sign(y - py);
      const outDx = Math.sign(nx - x);
      const outDy = Math.sign(ny - y);
      const inLen = Math.sqrt((x - px) ** 2 + (y - py) ** 2);
      const outLen = Math.sqrt((nx - x) ** 2 + (ny - y) ** 2);
      // Clamp the radius so a corner never consumes an entire short segment —
      // two oversized curves meeting on a short run look like a kink/wave
      // instead of a clean 90° bend.
      const cr = Math.min(CORNER_R, inLen / 3, outLen / 3);
      // Sharp 90° corners on short runs: rounding a tiny jog (e.g. the
      // near-aligned straight-run bend) creates an S-wave kink right at the
      // node. Only round when both adjacent runs have room for the curve.
      if (cr < 1 || inLen < 2 * CORNER_R || outLen < 2 * CORNER_R) {
        // Degenerate corner — skip rounding
        d += ` L ${x} ${y}`;
      } else {
        d += ` L ${x - inDx * cr} ${y - inDy * cr}`;
        d += ` Q ${x} ${y} ${x + outDx * cr} ${y + outDy * cr}`;
      }
    } else {
      d += ` L ${x} ${y}`;
    }
  }
  return d;
}

// ── Main export ─────────────────────────────────────────────────────────────

export interface AvoidanceResult {
  path: string;
  /** X coordinate for placing an edge label */
  labelX: number;
  /** Y coordinate for placing an edge label */
  labelY: number;
  /** Waypoints used to build the path (including source and target positions) */
  waypoints: [number, number][];
}

/**
 * Returns an SVG path + label anchor from (sx,sy) to (tx,ty) that avoids
 * all obstacle rectangles. Respects handle directions for clean entry/exit.
 *
 * `sourceRect`/`targetRect` are the bounding boxes of the connected cards.
 * They are not treated as hard obstacles (the punch-through bandaid), but the
 * fallback detour lane is placed to clear them whenever geometry allows.
 */
export function getAvoidancePath(
  sx: number,
  sy: number,
  tx: number,
  ty: number,
  sourceSide: string,
  targetSide: string,
  obstacles: NodeRect[],
  sourceRect?: NodeRect,
  targetRect?: NodeRect,
): AvoidanceResult {
  // Create exit/entry stub points in handle direction
  const exit = stubPoint(sx, sy, sourceSide);
  const entry = stubPoint(tx, ty, targetSide);

  const srcHoriz = isHorizontalSide(sourceSide);
  const tgtHoriz = isHorizontalSide(targetSide);
  const sameSide = sourceSide === targetSide;

  const candidates: Point[][] = [];
  const addCandidate = (middle: Point[]) => {
    candidates.push(simplifyWaypoints(
      [[sx, sy], exit, ...middle, entry, [tx, ty]],
    ));
  };

  if (sameSide) {
    // Same-side handles (right→right etc.): the normal mid-lane dogleg would
    // cross the target card to reach the handle. Route around the card's far
    // side so the approach comes from outside.
    const far = farSideCoordinate(sourceSide, tx, ty, targetRect);
    if (srcHoriz) {
      // right→right / left→left: go out, vertical at the far X, then in
      addCandidate([[far, exit[1]], [far, entry[1]]]);
    } else {
      // top→top / bottom→bottom: go out, horizontal at the far Y, then in
      addCandidate([[exit[0], far], [entry[0], far]]);
    }
  } else if (srcHoriz && tgtHoriz) {
    // Both horizontal handles: H → V → H
    const laneDelta = Math.abs(exit[1] - entry[1]);
    if (laneDelta <= STRAIGHT_RUN_BIAS_THRESHOLD) {
      addCandidate([[entry[0], exit[1]]]);
      addCandidate([[exit[0], entry[1]]]);
    }
    const midX = (exit[0] + entry[0]) / 2;
    addCandidate([[midX, exit[1]], [midX, entry[1]]]);
  } else if (!srcHoriz && !tgtHoriz) {
    // Both vertical handles: V → H → V
    const laneDelta = Math.abs(exit[0] - entry[0]);
    if (laneDelta <= STRAIGHT_RUN_BIAS_THRESHOLD) {
      addCandidate([[exit[0], entry[1]]]);
      addCandidate([[entry[0], exit[1]]]);
    }
    const midY = (exit[1] + entry[1]) / 2;
    addCandidate([[exit[0], midY], [entry[0], midY]]);
  } else if (srcHoriz) {
    // Source horizontal, target vertical: route through corner
    addCandidate([[entry[0], exit[1]]]);
  } else {
    // Source vertical, target horizontal: route through corner
    addCandidate([[exit[0], entry[1]]]);
  }

  const checkObstacles: CheckRect[] = obstacles.map((r) => ({ ...r, clearance: CLEARANCE }));

  // For same-side far-side candidates also make sure the route doesn't cross
  // the connected cards themselves (that's the whole point of going around).
  // Zero clearance here: the route legitimately runs beside the cards, and an
  // inflated box would false-positive those clean parallel runs.
  const sameSideCheckRects: CheckRect[] = [
    ...checkObstacles,
    ...(sourceRect ? [{ ...sourceRect, clearance: 0 }] : []),
    ...(targetRect ? [{ ...targetRect, clearance: 0 }] : []),
  ];

  for (const waypoints of candidates) {
    const blocking = checkObstacles.filter((r) => pathIntersectsRect(waypoints, r));
    if (blocking.length === 0) {
      if (!sameSide) {
        const [labelX, labelY] = getPathMidpoint(waypoints);
        return {
          path: buildOrthogonalPath(waypoints),
          labelX,
          labelY,
          waypoints: waypoints as [number, number][],
        };
      }
      // Same-side routes must also clear the connected cards (stub segments
      // excepted — they attach to the card edge by design).
      const crossesConnected = sameSideCheckRects.some((r) => pathIntersectsRect(waypoints, r, true));
      if (!crossesConnected) {
        const [labelX, labelY] = getPathMidpoint(waypoints);
        return {
          path: buildOrthogonalPath(waypoints),
          labelX,
          labelY,
          waypoints: waypoints as [number, number][],
        };
      }
    }
  }

  // Avoidance: route above or below the union of blocking obstacles. The lane
  // also clears the connected cards when they lie in the lane's horizontal
  // path, so the detour doesn't dive through the source/target cards.
  const blocking = checkObstacles.filter((rect) => candidates.some((pts) => pathIntersectsRect(pts, rect)));

  const laneRects: CheckRect[] = [
    ...blocking,
    ...(sourceRect ? [{ ...sourceRect, clearance: CONNECTED_CLEARANCE }] : []),
    ...(targetRect ? [{ ...targetRect, clearance: CONNECTED_CLEARANCE }] : []),
  ];

  const laneX0 = Math.min(exit[0], entry[0]);
  const laneX1 = Math.max(exit[0], entry[0]);
  const inLanePath = (r: CheckRect) =>
    Math.max(laneX0, r.x - r.clearance) < Math.min(laneX1, r.x + r.w + r.clearance);
  const laneRectsInPath = laneRects.filter(inLanePath);
  const unionRects = laneRectsInPath.length > 0 ? laneRectsInPath : laneRects;

  if (unionRects.length === 0) {
    // Nothing to avoid — return the basic dogleg so the path stays orthogonal.
    const basicMiddle: Point[] = srcHoriz === tgtHoriz
      ? (srcHoriz
          ? [[(exit[0] + entry[0]) / 2, exit[1]], [(exit[0] + entry[0]) / 2, entry[1]]]
          : [[exit[0], (exit[1] + entry[1]) / 2], [entry[0], (exit[1] + entry[1]) / 2]])
      : [[entry[0], exit[1]]];
    const waypoints = simplifyWaypoints([[sx, sy], exit, ...basicMiddle, entry, [tx, ty]]);
    const [labelX, labelY] = getPathMidpoint(waypoints);
    return {
      path: buildOrthogonalPath(waypoints),
      labelX,
      labelY,
      waypoints: waypoints as [number, number][],
    };
  }

  let unionTop = Math.min(...unionRects.map((r) => r.y - r.clearance));
  let unionBottom = Math.max(...unionRects.map((r) => r.y + r.h + r.clearance));
  if (!isFiniteNumber(unionTop)) unionTop = Math.min(exit[1], entry[1]) - CLEARANCE;
  if (!isFiniteNumber(unionBottom)) unionBottom = Math.max(exit[1], entry[1]) + CLEARANCE;

  const mx = (sx + tx) / 2;

  const aboveWaypoints: Point[] = simplifyWaypoints([
    [sx, sy], exit,
    [exit[0], unionTop], [mx, unionTop], [entry[0], unionTop],
    entry, [tx, ty],
  ]);
  const belowWaypoints: Point[] = simplifyWaypoints([
    [sx, sy], exit,
    [exit[0], unionBottom], [mx, unionBottom], [entry[0], unionBottom],
    entry, [tx, ty],
  ]);

  // Respect handle directions: a top handle must be approached from above, a
  // bottom handle from below. When the source and target disagree (e.g. bottom
  // → top with a blocker between), fall back to the best-effort shorter route.
  const aboveOk = laneAllowed(sourceSide, true) && laneAllowed(targetSide, true);
  const belowOk = laneAllowed(sourceSide, false) && laneAllowed(targetSide, false);

  const laneCandidates: Point[][] = [];
  if (aboveOk) laneCandidates.push(aboveWaypoints);
  if (belowOk) laneCandidates.push(belowWaypoints);
  if (laneCandidates.length === 0) {
    laneCandidates.push(aboveWaypoints, belowWaypoints);
  }
  const chosen = laneCandidates.reduce((best, pts) => (
    pathLength(pts) < pathLength(best) ? pts : best
  ));

  const [labelX, labelY] = getPathMidpoint(chosen);

  return {
    path: buildOrthogonalPath(chosen),
    labelX,
    labelY,
    waypoints: chosen as [number, number][],
  };
}
