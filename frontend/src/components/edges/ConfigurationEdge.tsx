import { memo } from 'react';
import {
  BaseEdge,
  getSmoothStepPath,
  type EdgeProps,
} from '@xyflow/react';

function ConfigurationEdge(props: EdgeProps) {
  const { sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data } = props;
  const edgeData = data as Record<string, unknown> | undefined;
  const color = (edgeData?.color as string) || '#64748b';

  const [edgePath] = getSmoothStepPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    borderRadius: 8,
  });

  return (
    <BaseEdge
      id={props.id}
      path={edgePath}
      style={{
        stroke: color,
        strokeWidth: 2,
      }}
    />
  );
}

export default memo(ConfigurationEdge);
