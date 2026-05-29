import { memo, useEffect, useState } from 'react';
import { Handle, Position, type NodeProps, useConnection } from '@xyflow/react';
import type { HardwareNodeData } from '../../types/graph';
import { useGraphStore } from '../../stores/graphStore';
import NodeActions from './NodeActions';
import WarningBadge from './WarningBadge';
import type { ValidationStatus } from '../../types/graph';

const HARDWARE_COLORS: Record<string, string> = {
  sbc: 'var(--color-sbc)',
  mainboard: 'var(--color-mainboard)',
  toolhead: 'var(--color-toolhead)',
  expander: 'var(--color-expander)',
  config_file: '#0f766e',
  probe: 'var(--color-probe)',
  accelerometer: 'var(--color-accelerometer)',
  other: 'var(--color-other)',
};

const HARDWARE_SHAPES: Record<string, string> = {
  sbc: 'rounded-xl',
  mainboard: 'rounded-lg',
  toolhead: 'rounded-2xl',
  expander: 'rounded-lg',
  config_file: 'rounded-md',
  probe: 'rounded-xl',
  accelerometer: 'rounded-lg',
  other: 'rounded-md',
};

const PREVIEW_WIDTH = 400;
const PREVIEW_HEADER_HEIGHT = 110;
const PREVIEW_SLOT_HEIGHT = 40;
const PREVIEW_PADDING_BOTTOM = 16;
const PREVIEW_COLLAPSED_HEIGHT = 56;

function HardwareNode({ data, selected, id }: NodeProps) {
  const nodeData = data as unknown as HardwareNodeData;
  const color = HARDWARE_COLORS[nodeData.hardwareType] || HARDWARE_COLORS.other;
  const shape = HARDWARE_SHAPES[nodeData.hardwareType] || HARDWARE_SHAPES.other;
  const hardwareTypeLabel = nodeData.hardwareType.replace(/_/g, ' ');
  const isPrimary = !!(nodeData as Record<string, unknown>).isPrimary;
  const isMcu = !!(nodeData as Record<string, unknown>).isMcu;
  const collapsed = !!nodeData.collapsed;
  const validationStatus = (nodeData.validationStatus || 'valid') as ValidationStatus;

  // Hide the label when it duplicates the type badge:
  // - SBC not enabled as MCU (label is always "SBC")
  // - Primary mainboard (label is "Mainboard", type badge + PRIMARY badge already describe it)
  const isSbc = nodeData.hardwareType === 'sbc';
  const showLabel = !(isSbc && !isMcu) && !(nodeData.hardwareType === 'mainboard' && isPrimary);

  const { toggleHardwareCollapse, nodes, selectedNodeId, dragHoverHardwareId, removeNode } = useGraphStore();

  const [isHovered, setIsHovered] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  // Show handles on all nodes while any connection drag is in progress
  const { inProgress: isConnecting } = useConnection();
  const showHandles = isHovered || isConnecting;
  const hidePrimaryLabel = isPrimary && isHovered && collapsed;

  // True when a direct child of this hardware node is selected
  const childSelected = !!selectedNodeId && nodes.some(
    (n) => n.id === selectedNodeId && n.parentId === id,
  );
  const directChildren = nodes.filter((n) => n.parentId === id);
  const featureCount = directChildren.filter((n) => {
    const childData = n.data as Record<string, unknown>;
    return n.type === 'feature' || (n.type === 'group' && !!childData.isFeature);
  }).length;
  const componentCount = directChildren.filter((n) => {
    const childData = n.data as Record<string, unknown>;
    return n.type === 'subComponent' || (n.type === 'group' && !childData.isFeature);
  }).length;
  const previewExpanded = collapsed && dragHoverHardwareId === id;
  const previewHeight = Math.max(
    PREVIEW_HEADER_HEIGHT + Math.max(featureCount, componentCount, 0) * PREVIEW_SLOT_HEIGHT + PREVIEW_PADDING_BOTTOM,
    160,
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
      className={`kwc-node kwc-hardware-container ${shape} ${selected ? 'selected' : ''} ${nodeData.hasErrors ? 'kwc-error' : ''} ${validationStatus === 'warning' ? 'kwc-warning' : ''}`}
      style={{
        borderColor: color,
        borderWidth: isPrimary ? 3 : 2,
        backgroundColor: 'var(--color-bg-secondary)',
        width: '100%',
        height: '100%',
        boxSizing: 'border-box',
        position: 'relative',
      }}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >

      {showDeleteConfirm && (
        <div
          className="absolute right-2 top-12 z-40 w-56 rounded-xl border border-[var(--color-bg-tertiary)] bg-[var(--color-bg-secondary)] p-3 shadow-2xl"
          onClick={(event) => event.stopPropagation()}
        >
          <p className="text-[11px] leading-5 text-[var(--color-text-primary)]">
            Delete {nodeData.label || hardwareTypeLabel} and all attached configuration sections?
          </p>
          <div className="mt-3 flex justify-end gap-2">
            <button
              onClick={() => setShowDeleteConfirm(false)}
              className="rounded-md border border-[var(--color-bg-tertiary)] px-2.5 py-1 text-[11px] text-[var(--color-text-primary)] hover:border-[var(--color-accent)]"
            >
              Cancel
            </button>
            <button
              onClick={() => {
                setShowDeleteConfirm(false);
                removeNode(id);
              }}
              className="rounded-md bg-[var(--color-error)] px-2.5 py-1 text-[11px] font-medium text-[var(--color-bg-primary)] hover:opacity-90"
            >
              Delete
            </button>
          </div>
        </div>
      )}

      {previewExpanded && (
        <div
          className="kwc-hardware-drop-preview"
          style={{
            width: PREVIEW_WIDTH,
            minHeight: Math.max(previewHeight - PREVIEW_COLLAPSED_HEIGHT, 104),
            borderColor: `${color}44`,
            boxShadow: `0 16px 32px ${color}1f`,
          }}
        >
          <div className="kwc-node-body" style={{ borderBottom: `1px solid ${color}22` }}>
            <div className="flex items-center justify-between gap-2">
              <div className="text-xs opacity-60 uppercase tracking-wider">
                Drop Into {hardwareTypeLabel}
              </div>
              <div className="text-[10px] uppercase tracking-[0.16em]" style={{ color }}>
                {nodeData.configFile}
              </div>
            </div>
            <div className="mt-2 text-[11px] text-[var(--color-text-secondary)]">
              Release to move this card into {nodeData.label || hardwareTypeLabel}.
            </div>
          </div>

          <div
            className="flex justify-between gap-3 px-3 py-2"
            style={{ borderTop: `1px dashed ${color}22` }}
          >
            <div className="flex-1 rounded-lg border border-transparent bg-black/10 px-3 py-2">
              <div className="text-[9px] uppercase tracking-widest font-semibold opacity-50" style={{ color }}>
                Features
              </div>
              <div className="mt-1 text-xs text-[var(--color-text-primary)]">
                {featureCount === 0 ? 'Drop into feature column' : `${featureCount} existing item${featureCount === 1 ? '' : 's'}`}
              </div>
            </div>
            <div className="flex-1 rounded-lg border border-transparent bg-black/10 px-3 py-2 text-right">
              <div className="text-[9px] uppercase tracking-widest font-semibold opacity-50" style={{ color }}>
                Components
              </div>
              <div className="mt-1 text-xs text-[var(--color-text-primary)]">
                {componentCount === 0 ? 'Drop into component column' : `${componentCount} existing item${componentCount === 1 ? '' : 's'}`}
              </div>
            </div>
          </div>
        </div>
      )}

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
          <WarningBadge status={validationStatus} />
          {nodeData.customImage ? (
            <img src={nodeData.customImage} alt="" className="w-5 h-5 object-contain shrink-0" />
          ) : (
            <span className="shrink-0" style={{ color, fontSize: 13, fontWeight: 700 }}>
              {hardwareTypeLabel.toUpperCase()}
            </span>
          )}
          <div className="min-w-0 flex flex-col leading-tight">
            {showLabel && <span className="truncate" style={{ color }}>{nodeData.label}</span>}
            {isPrimary && (
              <span className="kwc-primary-label" style={{ opacity: hidePrimaryLabel ? 0 : 1 }}>
                PRIMARY
              </span>
            )}
          </div>
        </div>
        {/* Actions — visible on hover */}
        {isHovered && (
          <div className="shrink-0">
            <NodeActions
              nodeId={id}
              color={color}
              onDeleteRequested={() => setShowDeleteConfirm(true)}
            />
          </div>
        )}
      </div>

      {/* Body — hidden when collapsed */}
      {!collapsed && (
        <>
          {/* Hardware info */}
          <div className="kwc-node-body" style={{ borderBottom: `1px solid ${color}22` }}>
            <div className="text-xs opacity-60 uppercase tracking-wider">
              {hardwareTypeLabel}
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

