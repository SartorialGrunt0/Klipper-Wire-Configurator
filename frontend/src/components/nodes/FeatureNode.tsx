import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { FeatureNodeData } from '../../types/graph';
import NodeActions from './NodeActions';
import WarningBadge from './WarningBadge';

const FEATURE_COLORS: Record<string, string> = {
  bed_mesh: '#8b5cf6',
  z_tilt: '#6366f1',
  quad_gantry_level: '#6366f1',
  skew_correction: '#a78bfa',
  input_shaper: '#f59e0b',
  resonance_tester: '#f59e0b',
  firmware_retraction: '#f97316',
  pressure_advance: '#f97316',
  gcode_macro: '#22c55e',
  idle_timeout: '#64748b',
  save_variables: '#64748b',
  virtual_sdcard: '#64748b',
  pause_resume: '#06b6d4',
  respond: '#06b6d4',
  exclude_object: '#06b6d4',
  force_move: '#ef4444',
  homing_override: '#ec4899',
  safe_z_home: '#ec4899',
  endstop_phase: '#3b82f6',
  default: '#6b7280',
};

function FeatureNode({ data, selected, id }: NodeProps) {
  const nodeData = data as unknown as FeatureNodeData;
  const color = FEATURE_COLORS[nodeData.sectionType] || FEATURE_COLORS.default;
  const isSuppressed = !!(nodeData as Record<string, unknown>).isSuppressed;
  const isEmbedded = !!(nodeData.parentId);

  return (
    <div
      className={`kwc-compact-tile rounded-lg ${selected ? 'selected' : ''} ${nodeData.hasErrors ? 'kwc-error' : ''}`}
      style={{
        borderColor: color,
        borderStyle: 'dashed',
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
        style={{ backgroundColor: `${color}15`, borderLeft: `3px solid ${color}` }}
      >
        {nodeData.hasErrors && <WarningBadge />}
        <span className="text-xs truncate" style={{ color }}>
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

export default memo(FeatureNode);
