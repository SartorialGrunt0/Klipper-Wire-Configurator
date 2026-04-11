import { memo, useCallback } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { CustomGroupNodeData } from '../../types/graph';
import { useGraphStore } from '../../stores/graphStore';
import NodeActions from './NodeActions';

const selectNodes = (s: { nodes: ReturnType<typeof useGraphStore.getState>['nodes'] }) => s.nodes;
const selectToggle = (s: ReturnType<typeof useGraphStore.getState>) => s.toggleHardwareCollapse;

function CustomGroupNode({ data, selected, id }: NodeProps) {
  const nodeData = data as unknown as CustomGroupNodeData;
  const color = nodeData.color || '#64748b';
  const collapsed = !!nodeData.collapsed;

  const nodes = useGraphStore(selectNodes);
  const toggleHardwareCollapse = useGraphStore(selectToggle);

  // Compute derived values from the stable nodes array
  const children = nodes.filter((n) => n.parentId === id);
  const childCount = children.length;
  const self = nodes.find((n) => n.id === id);
  const isEmbedded = !!self?.parentId;

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
        borderStyle: 'solid',
        backgroundColor: 'var(--color-bg-secondary)',
        width: '100%',
        height: '100%',
        boxSizing: 'border-box',
      }}
    >
      {/* Connection handles — hidden when embedded inside a hardware node */}
      {!isEmbedded && (
        <>
          <Handle type="target" position={Position.Left} id="left-in"
            style={{ background: color, width: 14, height: 14 }} />
          <Handle type="source" position={Position.Right} id="right-out"
            style={{ background: color, width: 14, height: 14 }} />
          <Handle type="target" position={Position.Top} id="top-in"
            style={{ background: color, width: 14, height: 14 }} />
          <Handle type="source" position={Position.Bottom} id="bottom-out"
            style={{ background: color, width: 14, height: 14 }} />
        </>
      )}

      {/* Header */}
      <div
        className="kwc-node-header cursor-pointer select-none"
        style={{ backgroundColor: `${color}22`, borderBottom: `1px solid ${color}44` }}
        onClick={(e) => { e.stopPropagation(); toggleHardwareCollapse(id); }}
      >
        <span className="text-sm">📦</span>
        <span className="text-xs font-semibold" style={{ color }}>
          {nodeData.label}
        </span>
        <span className="ml-auto flex items-center gap-1">
          <span
            className="text-[10px] px-1.5 py-0.5 rounded-full font-bold"
            style={{ backgroundColor: `${color}33`, color }}
          >
            {childCount}
          </span>
          <span
            className="text-[10px] text-[var(--color-text-secondary)] transition-transform inline-block"
            style={{ transform: collapsed ? 'rotate(-90deg)' : 'rotate(0deg)' }}
          >
            ▼
          </span>
          <NodeActions nodeId={id} color={color} />
        </span>
      </div>

      {/* Body — list child node labels */}
      {!collapsed && (
        <div className="kwc-node-body">
          {childCount === 0 ? (
            <div className="text-[10px] opacity-40 text-center italic" style={{ color }}>
              Drag components here
            </div>
          ) : (
            <div className="space-y-0.5">
              {children.slice(0, 4).map((child) => {
                const label = (child.data as Record<string, unknown>).label as string || child.id;
                return (
                  <div key={child.id} className="text-[10px] text-[var(--color-text-secondary)] truncate max-w-[240px]">
                    {label}
                  </div>
                );
              })}
              {childCount > 4 && (
                <div className="text-[10px] text-[var(--color-text-secondary)] opacity-50">
                  +{childCount - 4} more
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default memo(CustomGroupNode);
