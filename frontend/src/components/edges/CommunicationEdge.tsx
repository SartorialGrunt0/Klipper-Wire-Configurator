import { memo } from 'react';
import {
  BaseEdge,
  getSmoothStepPath,
  type EdgeProps,
} from '@xyflow/react';

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

function CommunicationEdge(props: EdgeProps) {
  const { sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data } = props;
  const commType = (data as { commType?: string })?.commType || 'usb';
  const color = COMM_COLORS[commType] || COMM_COLORS.usb;
  const label = COMM_LABELS[commType] || 'USB';

  const [edgePath, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    borderRadius: 8,
  });

  return (
    <>
      <BaseEdge
        id={props.id}
        path={edgePath}
        style={{
          stroke: color,
          strokeWidth: 2.5,
          strokeDasharray: '8 4',
        }}
      />
      <foreignObject
        x={labelX - 20}
        y={labelY - 10}
        width={40}
        height={20}
        requiredExtensions="http://www.w3.org/1999/xhtml"
      >
        <div
          style={{
            background: color,
            color: '#0f172a',
            fontSize: 9,
            fontWeight: 700,
            padding: '2px 6px',
            borderRadius: 4,
            textAlign: 'center',
            lineHeight: '14px',
          }}
        >
          {label}
        </div>
      </foreignObject>
    </>
  );
}

export default memo(CommunicationEdge);
