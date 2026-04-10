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

const GROUP_ICONS: Record<string, string> = {
  stepper: '⚙️',
  stepper_driver: '🔧',
  extruder: '🖨️',
  heater: '🔥',
  fan: '💨',
  probe: '📍',
  temperature: '🌡️',
  accelerometer: '📊',
  led: '💡',
  servo: '🔄',
  pin: '📌',
  display: '🖥️',
  filament_sensor: '🧵',
  sensor: '📡',
  mcu: '🔲',
  other: '⬜',
};

function SubComponentNode({ data, selected, id }: NodeProps) {
  const nodeData = data as unknown as SubComponentNodeData;
  const color = GROUP_COLORS[nodeData.componentGroup] || GROUP_COLORS.other;
  const icon = GROUP_ICONS[nodeData.componentGroup] || GROUP_ICONS.other;
  const isSuppressed = !!(nodeData as Record<string, unknown>).isSuppressed;
  // Hide connection handles when this node lives inside a hardware/group container
  const isEmbedded = !!nodeData.parentHardwareId;

  const activeParams = nodeData.section.params.filter((p) => !p.is_commented_out);

  return (
    <div
      className={`kwc-node rounded-xl ${selected ? 'selected' : ''} ${nodeData.hasErrors ? 'kwc-error' : ''}`}
      style={{
        borderColor: color,
        backgroundColor: 'var(--color-bg-secondary)',
        width: 268,
        opacity: isSuppressed ? 0.45 : 1,
      }}
    >
      {!isEmbedded && (
        <>
          <Handle type="target" position={Position.Left} id="left-in"
            style={{ background: color, width: 12, height: 12 }} />
          <Handle type="source" position={Position.Right} id="right-out"
            style={{ background: color, width: 12, height: 12 }} />
          <Handle type="target" position={Position.Top} id="top-in"
            style={{ background: color, width: 12, height: 12 }} />
          <Handle type="source" position={Position.Bottom} id="bottom-out"
            style={{ background: color, width: 12, height: 12 }} />
        </>
      )}

      <div
        className="kwc-node-header"
        style={{ backgroundColor: `${color}22`, borderBottom: `1px solid ${color}44` }}
      >
        {nodeData.customImage ? (
          <img src={nodeData.customImage} alt="" className="w-4 h-4 object-contain" />
        ) : (
          <span className="text-sm">{icon}</span>
        )}
        <span className="text-xs font-semibold" style={{ color }}>
          {nodeData.label}
        </span>
        {isSuppressed && (
          <span className="text-[9px] px-1 py-0.5 rounded bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)]">
            OFF
          </span>
        )}
        <div className="ml-auto shrink-0">
          <NodeActions nodeId={id} color={color} />
        </div>
      </div>

      <div className="kwc-node-body">
        <div className="text-[10px] opacity-50 uppercase tracking-wider">
          {nodeData.sectionType}
        </div>
        {activeParams.length > 0 && (
          <div className="mt-1 space-y-0.5">
            {activeParams.slice(0, 3).map((p) => (
              <div key={p.key} className="text-[10px] text-[var(--color-text-secondary)] truncate max-w-[140px]">
                <span className="text-[var(--color-accent)]">{p.key}:</span> {p.value}
              </div>
            ))}
            {activeParams.length > 3 && (
              <div className="text-[10px] text-[var(--color-text-secondary)] opacity-50">
                +{activeParams.length - 3} more
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default memo(SubComponentNode);
