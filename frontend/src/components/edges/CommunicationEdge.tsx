import { memo, useMemo } from 'react';
import {
  BaseEdge,
  useNodes,
  type EdgeProps,
} from '@xyflow/react';
import { getAvoidancePath, type NodeRect, type AvoidanceResult } from '../../utils/edgeRouting';

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

function CommunicationEdge(props: EdgeProps) {
  const { sourceX, sourceY, targetX, targetY, data, source, target, sourcePosition, targetPosition } = props;
  const edgeData = data as { commType?: string; isNotIncluded?: boolean } | undefined;
  const commType = edgeData?.commType || 'usb';
  const isNotIncluded = !!edgeData?.isNotIncluded;

  const activeColor = COMM_COLORS[commType] || COMM_COLORS.usb;
  const color = isNotIncluded ? '#475569' : activeColor;
  const label = COMM_LABELS[commType] || 'USB';
  const description = COMM_DESCRIPTIONS[commType] || '';

  // Build obstacle list from all hardware nodes except source/target
  const allNodes = useNodes();
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

  const edgeResult = useMemo<AvoidanceResult>(
    () => getAvoidancePath(sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, obstacles),
    [sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, obstacles],
  );

  // Label position: midpoint of the actual path (not the raw geometric midpoint)
  const labelX = edgeResult.labelX;
  const labelY = edgeResult.labelY;

  return (
    <>
      <BaseEdge
        id={props.id}
        path={edgeResult.path}
        style={{
          stroke: color,
          strokeWidth: isNotIncluded ? 1.5 : 2.5,
          strokeDasharray: isNotIncluded ? '4 8' : '8 4',
          opacity: isNotIncluded ? 0.5 : 1,
        }}
      />
      {/* Label badge */}
      <foreignObject
        x={labelX - 32}
        y={labelY - 14}
        width={isNotIncluded ? 80 : 64}
        height={isNotIncluded ? 28 : 20}
        requiredExtensions="http://www.w3.org/1999/xhtml"
      >
        <div
          style={{
            background: isNotIncluded ? '#1e293b' : color,
            color: isNotIncluded ? '#64748b' : '#0f172a',
            fontSize: 9,
            fontWeight: 700,
            padding: '2px 6px',
            borderRadius: 4,
            textAlign: 'center',
            lineHeight: '14px',
            border: isNotIncluded ? '1px dashed #475569' : 'none',
          }}
        >
          {isNotIncluded ? (
            <>
              <div style={{ fontSize: 8, color: '#94a3b8' }}>⚡ {label}</div>
              <div style={{ fontSize: 7, color: '#475569' }}>not included</div>
            </>
          ) : (
            <span title={description}>{label}</span>
          )}
        </div>
      </foreignObject>
    </>
  );
}

export default memo(CommunicationEdge);
