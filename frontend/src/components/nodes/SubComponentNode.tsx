import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { SubComponentNodeData } from '../../types/graph';
import NodeActions from './NodeActions';

const GROUP_COLORS: Record<string, string> = {
  stepper: '#3b82f6',
  stepper_driver: '#6366f1',
  extruder: '#f97316',
  heater: '#ef4444',
  fan: '#06b6d4',
  probe: '#ec4899',
  temperature: '#f59e0b',
  accelerometer: '#84cc16',
  led: '#a855f7',
  servo: '#14b8a6',
  pin: '#64748b',
  display: '#8b5cf6',
  filament_sensor: '#d946ef',
  sensor: '#0ea5e9',
  mcu: '#22c55e',
  other: '#6b7280',
};

function SubComponentNode({ data, selected, id }: NodeProps) {
  const nodeData = data as unknown as SubComponentNodeData;
  const color = GROUP_COLORS[nodeData.componentGroup] || GROUP_COLORS.other;
  const isSuppressed = !!(nodeData as Record<string, unknown>).isSuppressed;
  const isEmbedded = !!nodeData.parentHardwareId;

  return (
    <div
      className={`kwc-compact-tile rounded-lg ${selected ? 'selected' : ''} ${nodeData.hasErrors ? 'kwc-error' : ''}`}
      style={{
        borderColor: color,
        backgroundColor: 'var(--color-bg-secondary)',
        width: 180,
        opacity: isSuppressed ? 0.45 : 1,
        position: 'relative',
      }}
    >
      {!isEmbedded && (
        <>
          <Handle type="target" position={Position.Left} id="left-in"
            style={{ background: color, width: 10, height: 10 }} isConnectableStart={false} />
          <Handle type="source" position={Position.Right} id="right-out"
            style={{ background: color, width: 10, height: 10 }} />
          <Handle type="target" position={Position.Top} id="top-in"
            style={{ background: color, width: 10, height: 10 }} isConnectableStart={false} />
          <Handle type="source" position={Position.Bottom} id="bottom-out"
            style={{ background: color, width: 10, height: 10 }} />
        </>
      )}

      {/* Actions overlay — shown above the card when selected */}
      {selected && (
        <div className="kwc-actions-overlay" style={{ borderColor: color }}>
          <NodeActions nodeId={id} color={color} />
        </div>
      )}

      <div
        className="kwc-tile-header"
        style={{ backgroundColor: `${color}22`, borderLeft: `3px solid ${color}` }}
      >
        <span className="text-xs font-semibold truncate" style={{ color }}>
          {nodeData.label}
        </span>
        {isSuppressed && (
          <span className="text-[9px] px-1 py-0.5 rounded bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)] ml-auto shrink-0">
            OFF
          </span>
        )}
      </div>
    </div>
  );
}

export default memo(SubComponentNode);
