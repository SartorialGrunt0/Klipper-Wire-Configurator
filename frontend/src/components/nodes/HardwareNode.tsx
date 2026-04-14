import { memo, useEffect, useState } from 'react';
import { Handle, Position, type NodeProps, useConnection } from '@xyflow/react';
import type { HardwareNodeData } from '../../types/graph';
import { useGraphStore } from '../../stores/graphStore';
import NodeActions from './NodeActions';
import WarningBadge from './WarningBadge';

const HARDWARE_COLORS: Record<string, string> = {
  sbc: 'var(--color-sbc)',
  mainboard: 'var(--color-mainboard)',
  toolhead: 'var(--color-toolhead)',
  expander: 'var(--color-expander)',
  probe: 'var(--color-probe)',
  accelerometer: 'var(--color-accelerometer)',
  other: 'var(--color-other)',
};

const HARDWARE_SHAPES: Record<string, string> = {
  sbc: 'rounded-xl',
  mainboard: 'rounded-lg',
  toolhead: 'rounded-2xl',
  expander: 'rounded-lg',
  probe: 'rounded-xl',
  accelerometer: 'rounded-lg',
  other: 'rounded-md',
};

function HardwareNode({ data, selected, id }: NodeProps) {
  const nodeData = data as unknown as HardwareNodeData;
  const color = HARDWARE_COLORS[nodeData.hardwareType] || HARDWARE_COLORS.other;
  const shape = HARDWARE_SHAPES[nodeData.hardwareType] || HARDWARE_SHAPES.other;
  const isPrimary = !!(nodeData as Record<string, unknown>).isPrimary;
  const collapsed = !!nodeData.collapsed;

  const { toggleHardwareCollapse, nodes, selectedNodeId } = useGraphStore();

  const [isHovered, setIsHovered] = useState(false);
  // Show handles on all nodes while any connection drag is in progress
  const { inProgress: isConnecting } = useConnection();
  const showHandles = isHovered || isConnecting;

  // True when a direct child of this hardware node is selected
  const childSelected = !!selectedNodeId && nodes.some(
    (n) => n.id === selectedNodeId && n.parentId === id,
  );
  // Derive selection from the store so both values update atomically
  const isSelected = selectedNodeId === id;

  // Collapse when neither this node nor any child is selected
  useEffect(() => {
    if (!isSelected && !childSelected && !collapsed) {
      toggleHardwareCollapse(id);
    }
  }, [isSelected, childSelected, collapsed, id, toggleHardwareCollapse]);

  return (
    <div
      className={`kwc-node kwc-hardware-container ${shape} ${selected ? 'selected' : ''} ${nodeData.hasErrors ? 'kwc-error' : ''}`}
      style={{
        borderColor: color,
        borderWidth: isPrimary ? 3 : 2,
        backgroundColor: `${color}0d`,
        width: '100%',
        height: '100%',
        boxSizing: 'border-box',
        position: 'relative',
      }}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      {/* Handles on all sides for hardware-to-hardware connections */}
      {/* ConnectionMode.Loose lets a single handle on each side serve both roles. */}
      <Handle type="source" position={Position.Left} id="left"
        style={{ background: color, width: 14, height: 14, top: '50%', opacity: showHandles ? 1 : 0, transition: 'opacity 0.15s' }} />
      <Handle type="target" position={Position.Left} id="left-in"
        style={{ background: color, width: 14, height: 14, top: '50%', opacity: 0, pointerEvents: 'none' }}
        isConnectableStart={false} />
      <Handle type="source" position={Position.Left} id="left-out"
        style={{ background: color, width: 14, height: 14, top: '50%', opacity: 0, pointerEvents: 'none' }} />

      <Handle type="source" position={Position.Right} id="right"
        style={{ background: color, width: 14, height: 14, top: '50%', opacity: showHandles ? 1 : 0, transition: 'opacity 0.15s' }} />
      <Handle type="target" position={Position.Right} id="right-in"
        style={{ background: color, width: 14, height: 14, top: '50%', opacity: 0, pointerEvents: 'none' }}
        isConnectableStart={false} />
      <Handle type="source" position={Position.Right} id="right-out"
        style={{ background: color, width: 14, height: 14, top: '50%', opacity: 0, pointerEvents: 'none' }} />

      <Handle type="source" position={Position.Top} id="top"
        style={{ background: color, width: 14, height: 14, left: '50%', opacity: showHandles ? 1 : 0, transition: 'opacity 0.15s' }} />
      <Handle type="target" position={Position.Top} id="top-in"
        style={{ background: color, width: 14, height: 14, left: '50%', opacity: 0, pointerEvents: 'none' }}
        isConnectableStart={false} />
      <Handle type="source" position={Position.Top} id="top-out"
        style={{ background: color, width: 14, height: 14, left: '50%', opacity: 0, pointerEvents: 'none' }} />

      <Handle type="source" position={Position.Bottom} id="bottom"
        style={{ background: color, width: 14, height: 14, left: '50%', opacity: showHandles ? 1 : 0, transition: 'opacity 0.15s' }} />
      <Handle type="target" position={Position.Bottom} id="bottom-in"
        style={{ background: color, width: 14, height: 14, left: '50%', opacity: 0, pointerEvents: 'none' }}
        isConnectableStart={false} />
      <Handle type="source" position={Position.Bottom} id="bottom-out"
        style={{ background: color, width: 14, height: 14, left: '50%', opacity: 0, pointerEvents: 'none' }} />

      {/* Header */}
      <div
        className="kwc-node-header"
        style={{ backgroundColor: `${color}22`, borderBottom: `1px solid ${color}44` }}
      >
        <div className="flex items-start gap-2 min-w-0 flex-1">
          {nodeData.hasErrors && <WarningBadge />}
          {nodeData.customImage ? (
            <img src={nodeData.customImage} alt="" className="w-5 h-5 object-contain shrink-0" />
          ) : (
            <span className="shrink-0" style={{ color, fontSize: 13, fontWeight: 700 }}>
              {nodeData.hardwareType.toUpperCase()}
            </span>
          )}
          <div className="min-w-0 flex flex-col leading-tight">
            <span className="truncate" style={{ color }}>{nodeData.label}</span>
            {isPrimary && (
              <span className="kwc-primary-label">
                PRIMARY
              </span>
            )}
          </div>
        </div>
        {/* Actions — visible on hover */}
        {isHovered && (
          <div className="shrink-0">
            <NodeActions nodeId={id} color={color} />
          </div>
        )}
      </div>

      {/* Body — hidden when collapsed */}
      {!collapsed && (
        <>
          {/* Hardware info */}
          <div className="kwc-node-body" style={{ borderBottom: `1px solid ${color}22` }}>
            <div className="text-xs opacity-60 uppercase tracking-wider">
              {nodeData.hardwareType}
            </div>
            <div className="text-xs mt-1 text-[var(--color-text-secondary)]">
              {nodeData.configFile}
            </div>
          </div>

          {/* Column guide labels */}
          <div
            className="flex justify-between px-3 py-1"
            style={{ borderBottom: `1px dashed ${color}22` }}
          >
            <span
              className="text-[9px] uppercase tracking-widest font-semibold opacity-40"
              style={{ color }}
            >
              Features
            </span>
            <span
              className="text-[9px] uppercase tracking-widest font-semibold opacity-40"
              style={{ color }}
            >
              Components
            </span>
          </div>
        </>
      )}
    </div>
  );
}

export default memo(HardwareNode);

