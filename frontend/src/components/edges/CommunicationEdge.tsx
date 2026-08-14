import { memo, useMemo, useState } from 'react';
import {
  BaseEdge,
  useNodes,
  useEdges,
  type EdgeProps,
  type Node,
} from '@xyflow/react';
import { type NodeRect } from '../../utils/edgeRouting';
import { useBendPath } from '../../utils/edgeBend';
import EdgeBendHandles from './EdgeBendHandles';

const COMM_COLORS: Record<string, string> = {
  usb: 'var(--color-usb)',
  canbus: 'var(--color-canbus)',
  uart: 'var(--color-uart)',
};

const COMM_LABELS: Record<string, string> = {
  usb: 'USB',
  canbus: 'CAN',
  uart: 'UART',
};

const COMM_DESCRIPTIONS: Record<string, string> = {
  usb: 'Universal Serial Bus',
  canbus: 'Controller Area Network',
  uart: 'Universal Async Receiver/Transmitter',
};

function rectForNode(n: Node): NodeRect {
  return {
    x: n.position.x,
    y: n.position.y,
    w: (n.style?.width as number) ?? 400,
    h: (n.style?.height as number) ?? 160,
  };
}

function CommunicationEdge(props: EdgeProps) {
  const { id, sourceX, sourceY, targetX, targetY, data, source, target, sourcePosition, targetPosition } = props;
  const [isHovered, setIsHovered] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const showHandles = isHovered || isDragging;
  const edgeData = data as { commType?: string; isNotIncluded?: boolean; customMiddlePoints?: Array<{ x: number; y: number }> } | undefined;
  const commType = edgeData?.commType || 'usb';

  // Build obstacle list from all hardware nodes except source/target
  const allNodes = useNodes();
  const allEdges = useEdges();

  // Dynamically compute whether the target MCU is reachable from the primary hardware
  // node via a configuration (trace) edge. Reacts to user adding/removing trace lines.
  const isNotIncluded = useMemo(() => {
    // The comm edge connects SBC ↔ hardware. Either endpoint could be source/target
    // depending on which direction the user drew the edge — always check the non-SBC side.
    const sourceNode = allNodes.find((n) => n.id === source);
    const targetNode = allNodes.find((n) => n.id === target);
    const sourceData = sourceNode?.data as Record<string, unknown> | undefined;
    const targetData = targetNode?.data as Record<string, unknown> | undefined;

    const hwNodeId = sourceData?.hardwareType === 'sbc' ? target : source;
    const hwNodeData = sourceData?.hardwareType === 'sbc' ? targetData : sourceData;

    // Primary mainboard is always included
    if (hwNodeData?.isPrimary) return false;

    // Find the primary hardware node
    const primaryNode = allNodes.find((n) => {
      const d = n.data as Record<string, unknown>;
      return d.isPrimary === true;
    });
    if (!primaryNode) return false;

    // Check if a configuration edge connects the hardware node ↔ primary
    const hasConfigEdge = allEdges.some((e) => {
      const eData = e.data as Record<string, unknown> | undefined;
      if (eData?.edgeType !== 'configuration') return false;
      return (
        (e.source === hwNodeId && e.target === primaryNode.id) ||
        (e.target === hwNodeId && e.source === primaryNode.id)
      );
    });
    return !hasConfigEdge;
  }, [allNodes, allEdges, source, target]);

  const activeColor = COMM_COLORS[commType] || COMM_COLORS.usb;
  const color = isNotIncluded ? '#475569' : activeColor;
  const label = COMM_LABELS[commType] || 'USB';
  const description = COMM_DESCRIPTIONS[commType] || '';

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
    labelX,
    labelY,
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
          strokeWidth: isNotIncluded ? 1.5 : 2.5,
          strokeDasharray: isNotIncluded ? '4 8' : '8 4',
          opacity: isNotIncluded ? 0.5 : 1,
        }}
        onDoubleClick={onEdgeDoubleClick}
      />
      {/* Label badge */}
      <foreignObject
        x={labelX - 32}
        y={labelY - 10}
        width={64}
        height={20}
        requiredExtensions="http://www.w3.org/1999/xhtml"
      >
        <div
          style={{
            background: isNotIncluded ? '#1e293b' : color,
            color: isNotIncluded ? '#94a3b8' : '#0f172a',
            fontSize: 9,
            fontWeight: 700,
            padding: '2px 6px',
            borderRadius: 4,
            textAlign: 'center',
            lineHeight: '14px',
            border: isNotIncluded ? '1px dashed #475569' : 'none',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 3,
          }}
        >
          {isNotIncluded && (
            <svg width="8" height="8" viewBox="0 0 10 10" fill="none" style={{ flexShrink: 0 }}>
              <path d="M2 2l6 6M8 2l-6 6" stroke="#ef4444" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          )}
          <span title={isNotIncluded ? undefined : description}>{label}</span>
        </div>
      </foreignObject>
      {/* Tooltip shown on hover when the comm line is inactive */}
      {isNotIncluded && isHovered && (
        <foreignObject
          x={labelX - 120}
          y={labelY + 14}
          width={240}
          height={44}
          requiredExtensions="http://www.w3.org/1999/xhtml"
          style={{ pointerEvents: 'none', overflow: 'visible' }}
        >
          <div
            style={{
              background: '#0f172a',
              border: '1px solid #ef4444',
              borderRadius: 6,
              padding: '5px 8px',
              fontSize: 10,
              color: '#fca5a5',
              lineHeight: '14px',
              textAlign: 'center',
              boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
              whiteSpace: 'normal',
            }}
          >
            <strong style={{ color: '#ef4444' }}>Not active</strong> — no trace line to primary config.<br />
            Draw a trace line to activate this {label} link.
          </div>
        </foreignObject>
      )}
      {/* Segment drag handles — rendered last so they sit on top of the label badge */}
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

export default memo(CommunicationEdge);
