import { memo, useEffect, useState } from 'react';
import { Handle, Position, type NodeProps, useConnection } from '@xyflow/react';
import type { CustomGroupNodeData } from '../../types/graph';
import { useGraphStore } from '../../stores/graphStore';
import NodeActions from './NodeActions';
import WarningBadge from './WarningBadge';

const selectNodes = (s: { nodes: ReturnType<typeof useGraphStore.getState>['nodes'] }) => s.nodes;
const selectToggle = (s: ReturnType<typeof useGraphStore.getState>) => s.toggleHardwareCollapse;

function CustomGroupNode({ data, selected, id }: NodeProps) {
  const nodeData = data as unknown as CustomGroupNodeData;
  const color = nodeData.color || '#64748b';
  const collapsed = !!nodeData.collapsed;

  const nodes = useGraphStore(selectNodes);
  const toggleHardwareCollapse = useGraphStore(selectToggle);

  const children = nodes.filter((n) => n.parentId === id);
  const childCount = children.length;
  const self = nodes.find((n) => n.id === id);
  const isEmbedded = !!self?.parentId;

  const selectedNodeId = useGraphStore((s) => s.selectedNodeId);
  const childSelected = !!selectedNodeId && nodes.some(
    (n) => n.id === selectedNodeId && n.parentId === id,
  );
  const isSelected = selectedNodeId === id;

  const [isHovered, setIsHovered] = useState(false);
  const { inProgress: isConnecting } = useConnection();
  const showHandles = isHovered || isConnecting;

  // Collapse when neither this node nor any child is selected
  useEffect(() => {
    if (!isSelected && !childSelected && !collapsed) {
      toggleHardwareCollapse(id);
    }
  }, [isSelected, childSelected, collapsed, id, toggleHardwareCollapse]);

  return (
    <div
      className={`kwc-node rounded-xl ${selected ? 'selected' : ''} ${nodeData.hasErrors ? 'kwc-error' : ''}`}
      style={{
        borderColor: color,
        borderWidth: 2,
        borderStyle: 'solid',
        backgroundColor: 'var(--color-bg-secondary)',
        width: '100%',
        height: '100%',
        boxSizing: 'border-box',
        position: 'relative',
      }}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      {!isEmbedded && (
        <>
          <Handle type="target" position={Position.Left} id="left-in"
            style={{ background: color, width: 14, height: 14, opacity: showHandles ? 1 : 0, transition: 'opacity 0.15s' }}
            isConnectableStart={false} />
          <Handle type="source" position={Position.Right} id="right-out"
            style={{ background: color, width: 14, height: 14, opacity: showHandles ? 1 : 0, transition: 'opacity 0.15s' }} />
          <Handle type="target" position={Position.Top} id="top-in"
            style={{ background: color, width: 14, height: 14, opacity: showHandles ? 1 : 0, transition: 'opacity 0.15s' }}
            isConnectableStart={false} />
          <Handle type="source" position={Position.Bottom} id="bottom-out"
            style={{ background: color, width: 14, height: 14, opacity: showHandles ? 1 : 0, transition: 'opacity 0.15s' }} />
        </>
      )}

      {/* Header */}
      <div
        className="kwc-node-header"
        style={{ backgroundColor: `${color}22`, borderBottom: `1px solid ${color}44` }}
      >
        {nodeData.hasErrors && <WarningBadge />}
        <span className="text-xs font-semibold" style={{ color }}>
          {nodeData.label}
        </span>
        <span
          className="text-[10px] px-1.5 py-0.5 rounded-full font-bold"
          style={{ backgroundColor: `${color}33`, color }}
        >
          {childCount}
        </span>
        {/* Actions — inline right side, visible on hover */}
        {isHovered && (
          <div className="ml-auto shrink-0">
            <NodeActions nodeId={id} color={color} />
          </div>
        )}
      </div>

      {/* Body — shown when expanded (selected) */}
      {!collapsed && (
        <div className="kwc-node-body">
          {childCount === 0 ? (
            <div className="text-[10px] opacity-40 text-center italic" style={{ color }}>
              Drag components here
            </div>
          ) : (
            <div className="space-y-0.5">
              {children.map((child) => {
                const label = (child.data as Record<string, unknown>).label as string || child.id;
                return (
                  <div key={child.id} className="text-[10px] text-[var(--color-text-secondary)] truncate max-w-[240px]">
                    {label}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default memo(CustomGroupNode);
