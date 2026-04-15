import { memo, useMemo } from 'react';
import {
  BaseEdge,
  useNodes,
  type EdgeProps,
} from '@xyflow/react';
import { type NodeRect } from '../../utils/edgeRouting';
import { useBendPath, type SegHandle } from '../../utils/edgeBend';

const HARDWARE_COLORS: Record<string, string> = {
  sbc: 'var(--color-sbc)',
  mainboard: 'var(--color-mainboard)',
  toolhead: 'var(--color-toolhead)',
  expander: 'var(--color-expander)',
  probe: 'var(--color-probe)',
  accelerometer: 'var(--color-accelerometer)',
  other: 'var(--color-other)',
};

function ConfigurationEdge(props: EdgeProps) {
  const { id, sourceX, sourceY, targetX, targetY, data, source, target, sourcePosition, targetPosition } = props;
  const edgeData = data as Record<string, unknown> & { customMiddlePoints?: Array<{ x: number; y: number }> } | undefined;

  const allNodes = useNodes();

  // Use the non-primary (non-printer.cfg) node's hardware color
  const color = useMemo(() => {
    const sourceNode = allNodes.find((n) => n.id === source);
    const targetNode = allNodes.find((n) => n.id === target);
    const srcData = sourceNode?.data as Record<string, unknown> | undefined;
    const tgtData = targetNode?.data as Record<string, unknown> | undefined;

    if (srcData?.isPrimary && tgtData?.hardwareType) {
      return HARDWARE_COLORS[tgtData.hardwareType as string] || HARDWARE_COLORS.other;
    }
    if (tgtData?.isPrimary && srcData?.hardwareType) {
      return HARDWARE_COLORS[srcData.hardwareType as string] || HARDWARE_COLORS.other;
    }
    // Fallback: use the edge's stored color
    return (edgeData?.color as string) || '#64748b';
  }, [allNodes, source, target, edgeData]);

  const obstacles = useMemo<NodeRect[]>(() => {
    return allNodes
      .filter((n) => n.type === 'hardware' && n.id !== source && n.id !== target && !n.parentId)
      .map((n) => ({
        x: n.position.x,
        y: n.position.y,
        w: (n.style?.width as number) ?? 400,
        h: (n.style?.height as number) ?? 160,
      }));
  }, [allNodes, source, target]);

  const {
    path,
    handles,
    onHandlePointerDown,
    onHandlePointerMove,
    onHandlePointerUp,
    onEdgeDoubleClick,
  } = useBendPath(
    id,
    sourceX, sourceY, targetX, targetY,
    sourcePosition, targetPosition,
    obstacles,
    edgeData?.customMiddlePoints,
  );

  return (
    <>
      <BaseEdge
        id={props.id}
        path={path}
        style={{
          stroke: color,
          strokeWidth: 2,
        }}
        onDoubleClick={onEdgeDoubleClick}
      />
      {/* Segment drag handles */}
      {handles.map((h: SegHandle) => (
        <circle
          key={h.segIndex}
          cx={h.x}
          cy={h.y}
          r={5}
          fill="var(--color-bg-secondary)"
          stroke={color}
          strokeWidth={1.5}
          style={{ cursor: h.isHorizontal ? 'ns-resize' : 'ew-resize', pointerEvents: 'all' }}
          onPointerDown={(e) => onHandlePointerDown(h.segIndex, h.isHorizontal, e)}
          onPointerMove={onHandlePointerMove}
          onPointerUp={onHandlePointerUp}
        />
      ))}
    </>
  );
}

export default memo(ConfigurationEdge);
