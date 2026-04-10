import { memo, useCallback } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { CustomGroupNodeData } from '../../types/graph';
import { useGraphStore } from '../../stores/graphStore';
import NodeActions from './NodeActions';

function CustomGroupNode({ data, selected, id }: NodeProps) {
  const nodeData = data as unknown as CustomGroupNodeData;
  const color = nodeData.color || '#64748b';
  const collapsed = !!nodeData.collapsed;

  const { toggleHardwareCollapse } = useGraphStore();
  const handleCollapseToggle = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      toggleHardwareCollapse(id);
    },
    [id, toggleHardwareCollapse],
  );

  return (
    <div
      className={`kwc-node rounded-xl ${selected ? 'selected' : ''}`}
      style={{
        borderColor: color,
        borderWidth: 2,
        borderStyle: 'dashed',
        backgroundColor: `${color}0a`,
        width: '100%',
        height: '100%',
        boxSizing: 'border-box',
      }}
    >
      {/* Connection handles — always visible for custom group (top-level container) */}
      <Handle type="target" position={Position.Left} id="left-in"
        style={{ background: color, width: 14, height: 14, top: '20%' }} />
      <Handle type="source" position={Position.Left} id="left-out"
        style={{ background: color, width: 14, height: 14, top: '35%' }} />
      <Handle type="target" position={Position.Right} id="right-in"
        style={{ background: color, width: 14, height: 14, top: '20%' }} />
      <Handle type="source" position={Position.Right} id="right-out"
        style={{ background: color, width: 14, height: 14, top: '35%' }} />
      <Handle type="target" position={Position.Top} id="top-in"
        style={{ background: color, width: 14, height: 14, left: '40%' }} />
      <Handle type="source" position={Position.Bottom} id="bottom-out"
        style={{ background: color, width: 14, height: 14, left: '60%' }} />

      {/* Header */}
      <div
        className="kwc-node-header"
        style={{ backgroundColor: `${color}22`, borderBottom: `1px dashed ${color}44` }}
      >
        <span className="text-base">📦</span>
        <span className="text-sm font-semibold" style={{ color }}>
          {nodeData.label}
        </span>
        <span className="ml-1 text-[9px] px-1.5 py-0.5 rounded-full text-[var(--color-text-secondary)] bg-[var(--color-bg-tertiary)]">
          group
        </span>
        <div className="ml-auto flex items-center gap-0.5 shrink-0">
          <button
            onClick={handleCollapseToggle}
            title={collapsed ? 'Expand' : 'Collapse'}
            className="flex items-center justify-center w-5 h-5 rounded hover:bg-white/10 transition-colors"
            style={{ color }}
          >
            <span
              className="text-[10px] transition-transform inline-block"
              style={{ transform: collapsed ? 'rotate(-90deg)' : 'rotate(0deg)' }}
            >
              ▼
            </span>
          </button>
          <NodeActions nodeId={id} color={color} />
        </div>
      </div>

      {/* Body — hint text, hidden when collapsed */}
      {!collapsed && (
        <div className="kwc-node-body">
          <div
            className="text-[10px] opacity-40 text-center italic"
            style={{ color }}
          >
            Drag components here
          </div>
        </div>
      )}
    </div>
  );
}

export default memo(CustomGroupNode);
