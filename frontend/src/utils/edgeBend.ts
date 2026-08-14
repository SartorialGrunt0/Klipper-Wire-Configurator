/**
 * Hook for interactive bend points on orthogonal edges.
 *
 * Segment handles appear at the midpoint of each draggable segment.
 * Dragging a horizontal handle moves it up/down; a vertical handle left/right.
 * The path stays orthogonal throughout.
 *
 * - The whole segment body is draggable (not just the midpoint dot).
 * - On release the waypoints are simplified, so dragging a segment to align
 *   with its neighbour collapses the corner — a natural "straighten".
 * - Double-clicking the edge resets to auto-routing.
 */

import { useState, useCallback, useRef, useMemo } from 'react';
import { useReactFlow } from '@xyflow/react';
import type React from 'react';
import { useGraphStore } from '../stores/graphStore';
import { getAvoidancePath, getPathMidpoint, buildOrthogonalPath, simplifyWaypoints, type NodeRect } from './edgeRouting';

type Point = [number, number];

export interface SegHandle {
  x: number;
  y: number;
  /** Segment endpoints (axis-aligned), for whole-segment hit targets */
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  segIndex: number;
  isHorizontal: boolean;
}

export interface BendPathResult {
  path: string;
  labelX: number;
  labelY: number;
  handles: SegHandle[];
  hasCustomRoute: boolean;
  onHandlePointerDown: (segIndex: number, isHorizontal: boolean, e: React.PointerEvent<SVGElement>) => void;
  onHandlePointerMove: (e: React.PointerEvent<SVGElement>) => void;
  onHandlePointerUp: (e: React.PointerEvent<SVGElement>) => void;
  onEdgeDoubleClick: () => void;
}

/** Minimum segment length (flow units) before a drag handle is shown */
const MIN_HANDLE_LEN = 30;

export function useBendPath(
  edgeId: string,
  sourceX: number,
  sourceY: number,
  targetX: number,
  targetY: number,
  sourceSide: string,
  targetSide: string,
  obstacles: NodeRect[],
  sourceRect: NodeRect | undefined,
  targetRect: NodeRect | undefined,
  storedMiddle: Array<{ x: number; y: number }> | undefined,
): BendPathResult {
  const { screenToFlowPosition } = useReactFlow();
  const updateEdgeData = useGraphStore((s) => s.updateEdgeData);

  // Local state drives re-renders during drag for smooth visual feedback
  const [localMiddle, setLocalMiddle] = useState<Point[] | null>(null);
  // Ref mirrors localMiddle without causing stale closures on commit
  const localMiddleRef = useRef<Point[] | null>(null);

  const dragRef = useRef<{
    segIndex: number;
    isHorizontal: boolean;
    startMiddle: Point[];
  } | null>(null);

  // Effective middle points: local drag > stored > none (use auto-routing)
  const effectiveMiddle: Point[] | undefined =
    localMiddle ?? storedMiddle?.map((p): Point => [p.x, p.y]);

  // Build full waypoints + path
  const { path, labelX, labelY, waypoints } = useMemo((): {
    path: string;
    labelX: number;
    labelY: number;
    waypoints: Point[];
  } => {
    if (effectiveMiddle && effectiveMiddle.length > 0) {
      const full: Point[] = [[sourceX, sourceY], ...effectiveMiddle, [targetX, targetY]];
      const p = buildOrthogonalPath(full);
      const [labelX, labelY] = getPathMidpoint(full);
      return { path: p, labelX, labelY, waypoints: full };
    }
    const r = getAvoidancePath(sourceX, sourceY, targetX, targetY, sourceSide, targetSide, obstacles, sourceRect, targetRect);
    return { path: r.path, labelX: r.labelX, labelY: r.labelY, waypoints: r.waypoints as Point[] };
  }, [effectiveMiddle, sourceX, sourceY, targetX, targetY, sourceSide, targetSide, obstacles, sourceRect, targetRect]);

  // Segment handles: one per draggable segment (not first/last stub segments)
  const handles = useMemo((): SegHandle[] => {
    const result: SegHandle[] = [];
    for (let i = 1; i < waypoints.length - 2; i++) {
      const p1 = waypoints[i];
      const p2 = waypoints[i + 1];
      const dx = Math.abs(p2[0] - p1[0]);
      const dy = Math.abs(p2[1] - p1[1]);
      if (dx + dy < MIN_HANDLE_LEN) continue;
      result.push({
        x: (p1[0] + p2[0]) / 2,
        y: (p1[1] + p2[1]) / 2,
        x1: p1[0],
        y1: p1[1],
        x2: p2[0],
        y2: p2[1],
        segIndex: i,
        isHorizontal: dx >= dy,
      });
    }
    return result;
  }, [waypoints]);

  const onHandlePointerDown = useCallback((
    segIndex: number,
    isHorizontal: boolean,
    e: React.PointerEvent<SVGElement>,
  ) => {
    e.stopPropagation();
    e.preventDefault();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    dragRef.current = {
      segIndex,
      isHorizontal,
      // Capture middle points at drag start (excluding source + target endpoints)
      startMiddle: (waypoints.slice(1, -1) as Point[]).map((p): Point => [p[0], p[1]]),
    };
  }, [waypoints]);

  const onHandlePointerMove = useCallback((e: React.PointerEvent<SVGElement>) => {
    if (!dragRef.current) return;
    const { segIndex, isHorizontal, startMiddle } = dragRef.current;
    const flowPos = screenToFlowPosition({ x: e.clientX, y: e.clientY });

    // Deep copy startMiddle so we don't mutate the ref
    const middle = startMiddle.map((p): Point => [p[0], p[1]]);

    // segIndex is in full waypoints (0-based); middle array is shifted by 1
    const mi1 = segIndex - 1; // first endpoint of dragged segment in middle[]
    const mi2 = segIndex;     // second endpoint of dragged segment in middle[]

    if (isHorizontal) {
      // Move horizontal segment: update Y of both endpoints, snap to 20px grid
      const newY = Math.round(flowPos.y / 20) * 20;
      if (mi1 >= 0 && mi1 < middle.length) middle[mi1] = [middle[mi1][0], newY];
      if (mi2 >= 0 && mi2 < middle.length) middle[mi2] = [middle[mi2][0], newY];
    } else {
      // Move vertical segment: update X of both endpoints, snap to 20px grid
      const newX = Math.round(flowPos.x / 20) * 20;
      if (mi1 >= 0 && mi1 < middle.length) middle[mi1] = [newX, middle[mi1][1]];
      if (mi2 >= 0 && mi2 < middle.length) middle[mi2] = [newX, middle[mi2][1]];
    }

    setLocalMiddle(middle);
    localMiddleRef.current = middle;
  }, [screenToFlowPosition]);

  const onHandlePointerUp = useCallback((_e: React.PointerEvent<SVGElement>) => {
    if (localMiddleRef.current) {
      // Simplify on release: collinear/duplicate waypoints collapse, which
      // turns "drag a segment onto its neighbour" into a straight line.
      const simplified = simplifyWaypoints(localMiddleRef.current);
      updateEdgeData(edgeId, {
        customMiddlePoints: simplified.map(([x, y]) => ({ x, y })),
      } as Record<string, unknown>);
    }
    setLocalMiddle(null);
    localMiddleRef.current = null;
    dragRef.current = null;
  }, [edgeId, updateEdgeData]);

  const onEdgeDoubleClick = useCallback(() => {
    updateEdgeData(edgeId, { customMiddlePoints: undefined } as Record<string, unknown>);
    setLocalMiddle(null);
    localMiddleRef.current = null;
    dragRef.current = null;
  }, [edgeId, updateEdgeData]);

  return {
    path,
    labelX,
    labelY,
    handles,
    hasCustomRoute: !!(storedMiddle && storedMiddle.length > 0),
    onHandlePointerDown,
    onHandlePointerMove,
    onHandlePointerUp,
    onEdgeDoubleClick,
  };
}
