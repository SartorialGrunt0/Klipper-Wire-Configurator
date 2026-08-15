import type React from 'react';
import type { SegHandle } from '../../utils/edgeBend';

interface EdgeBendHandlesProps {
  handles: SegHandle[];
  color: string;
  /** Whether the edge is hovered or being dragged (handles visible) */
  visible: boolean;
  onPointerDown: (segIndex: number, isHorizontal: boolean, e: React.PointerEvent<SVGElement>) => void;
  onPointerMove: (e: React.PointerEvent<SVGElement>) => void;
  onPointerUp: (e: React.PointerEvent<SVGElement>) => void;
  onDragStart: () => void;
  onDragEnd: () => void;
}

/**
 * Interactive bend handles for orthogonal edges.
 *
 * Each draggable segment gets an invisible wide hit path (grab the segment
 * body anywhere) plus a small midpoint dot for visual affordance.
 */
export default function EdgeBendHandles({
  handles,
  color,
  visible,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onDragStart,
  onDragEnd,
}: EdgeBendHandlesProps) {
  return (
    <g>
      {handles.map((h: SegHandle) => {
        const cursor = h.isHorizontal ? 'ns-resize' : 'ew-resize';
        const pointerProps = {
          onPointerDown: (e: React.PointerEvent<SVGElement>) => {
            onDragStart();
            onPointerDown(h.segIndex, h.isHorizontal, e);
          },
          onPointerMove,
          onPointerUp: (e: React.PointerEvent<SVGElement>) => {
            onDragEnd();
            onPointerUp(e);
          },
        };
        return (
          <g key={h.segIndex}>
            {/* Whole-segment hit target — the visual dot sits on top */}
            <line
              x1={h.x1}
              y1={h.y1}
              x2={h.x2}
              y2={h.y2}
              stroke="transparent"
              strokeWidth={16}
              style={{
                cursor,
                pointerEvents: visible ? 'stroke' : 'none',
              }}
              {...pointerProps}
            />
            <circle
              cx={h.x}
              cy={h.y}
              r={5}
              fill="var(--color-bg-secondary)"
              stroke={color}
              strokeWidth={1.5}
              style={{
                cursor,
                pointerEvents: 'none',
                opacity: visible ? 1 : 0,
                transition: 'opacity 0.15s ease',
              }}
            />
          </g>
        );
      })}
    </g>
  );
}
