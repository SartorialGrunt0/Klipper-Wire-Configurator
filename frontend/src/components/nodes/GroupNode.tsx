import { memo, useCallback } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { GroupNodeData, GroupChildItem } from '../../types/graph';
import { useGraphStore } from '../../stores/graphStore';
import { useConfigStore } from '../../stores/configStore';
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
  gcode_macro: '#22c55e',
  bed_leveling: '#8b5cf6',
  homing: '#ec4899',
  resonance: '#f59e0b',
  other: '#6b7280',
};

function GroupNode({ data, selected, id }: NodeProps) {
  const nodeData = data as unknown as GroupNodeData;
  const color = GROUP_COLORS[nodeData.componentGroup] || GROUP_COLORS.other;
  const isFeature = nodeData.isFeature;
  const children: GroupChildItem[] = nodeData.children || [];
  const isEmbedded = !!nodeData.parentHardwareId;

  const { setSelectedNode } = useGraphStore();
  const { setSelectedSection } = useConfigStore();

  const handleChildClick = useCallback((e: React.MouseEvent, child: GroupChildItem) => {
    e.stopPropagation();
    setSelectedNode(id);
    setSelectedSection(child.sectionHeader);
  }, [id, setSelectedNode, setSelectedSection]);

  return (
    <div
      className={`kwc-compact-tile rounded-lg ${selected ? 'selected' : ''} ${nodeData.hasErrors ? 'kwc-error' : ''}`}
      style={{
        borderColor: color,
        borderStyle: isFeature ? 'dashed' : 'solid',
        backgroundColor: 'var(--color-bg-secondary)',
        width: 180,
        position: 'relative',
      }}
    >
      {!isEmbedded && (
        <>
          <Handle type="target" position={Position.Left} id="left-in"
            style={{ background: color, width: 10, height: 10, top: '50%' }}
            isConnectableStart={false} />
          <Handle type="source" position={Position.Right} id="right-out"
            style={{ background: color, width: 10, height: 10, top: '50%' }} />
          <Handle type="target" position={Position.Top} id="top-in"
            style={{ background: color, width: 10, height: 10, left: '50%' }}
            isConnectableStart={false} />
          <Handle type="source" position={Position.Bottom} id="bottom-out"
            style={{ background: color, width: 10, height: 10, left: '50%' }} />
        </>
      )}

      {/* Actions overlay — shown above card when selected */}
      {selected && (
        <div className="kwc-actions-overlay" style={{ borderColor: color }}>
          <NodeActions nodeId={id} color={color} />
        </div>
      )}

      {/* Header — title + count badge */}
      <div
        className="kwc-tile-header"
        style={{ backgroundColor: `${color}22`, borderLeft: `3px solid ${color}` }}
      >
        <span className="text-xs font-semibold truncate" style={{ color }}>
          {nodeData.label}
        </span>
        <span
          className="text-[10px] px-1.5 py-0.5 rounded-full font-bold ml-auto shrink-0"
          style={{ backgroundColor: `${color}33`, color }}
        >
          {children.length}
        </span>
      </div>

      {/* Expanded when selected: show child titles only */}
      {selected && children.length > 0 && (
        <div className="px-2 py-1.5 space-y-0.5">
          {children.map((child) => (
            <div
              key={child.sectionHeader}
              className="text-[10px] text-[var(--color-text-secondary)] truncate px-1 py-0.5 rounded cursor-pointer hover:bg-[var(--color-bg-primary)]"
              onClick={(e) => handleChildClick(e, child)}
            >
              {child.label}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default memo(GroupNode);
