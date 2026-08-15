import { memo, useMemo, useState } from 'react';
import {
  BaseEdge,
  useNodes,
  type EdgeProps,
  type Node,
} from '@xyflow/react';
import { type NodeRect } from '../../utils/edgeRouting';
import { useBendPath } from '../../utils/edgeBend';
import EdgeBendHandles from './EdgeBendHandles';
import { HARDWARE_COLORS } from '../../constants/graphColors';

function rectForNode(n: Node): NodeRect {
  return {
    x: n.position.x,
    y: n.position.y,
    w: (n.style?.width as number) ?? 400,
    h: (n.style?.height as number) ?? 160,
  };
}

function ConfigurationEdge(props: EdgeProps) {
  const { id, sourceX, sourceY, targetX, targetY, data, source, target, sourcePosition, targetPosition } = props;
  const [isHovered, setIsHovered] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const showHandles = isHovered || isDragging;
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

  const { obstacles, sourceRect, targetRect } = useMemo<{
    obstacles: NodeRect[];
    sourceRect?: NodeRect;
    targetRect?: NodeRect;
  }>(() => {
    const sourceNode = allNodes.find((n) => n.id === source);
    const targetNode = allNodes.find((n) => n.id === target);
    return {
      obstacles: allNodes
        .filter((n) => n.type === 'hardware' && n.id !== source && n.id !== target && !n.parentId)
        .map(rectForNode),
      sourceRect: sourceNode && sourceNode.type === 'hardware' ? rectForNode(sourceNode) : undefined,
      targetRect: targetNode && targetNode.type === 'hardware' ? rectForNode(targetNode) : undefined,
    };
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
    sourceRect,
    targetRect,
    edgeData?.customMiddlePoints,
  );

  return (
    <g
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => { if (!isDragging) setIsHovered(false); }}
    >
      {/* Wide invisible path for easier hover detection */}
      <path
        d={path}
        stroke="transparent"
        strokeWidth={20}
        fill="none"
        style={{ pointerEvents: 'stroke' }}
      />
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
      <EdgeBendHandles
        handles={handles}
        color={color}
        visible={showHandles}
        onPointerDown={onHandlePointerDown}
        onPointerMove={onHandlePointerMove}
        onPointerUp={onHandlePointerUp}
        onDragStart={() => setIsDragging(true)}
        onDragEnd={() => setIsDragging(false)}
      />
    </g>
  );
}

export default memo(ConfigurationEdge);
