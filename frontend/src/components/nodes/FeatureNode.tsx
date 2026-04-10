import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { FeatureNodeData } from '../../types/graph';
import NodeActions from './NodeActions';

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

const FEATURE_ICONS: Record<string, string> = {
  bed_mesh: '🗺️',
  z_tilt: '📐',
  quad_gantry_level: '📐',
  skew_correction: '🔀',
  input_shaper: '〰️',
  resonance_tester: '📊',
  firmware_retraction: '↩️',
  gcode_macro: '📝',
  idle_timeout: '⏱️',
  save_variables: '💾',
  virtual_sdcard: '💿',
  pause_resume: '⏸️',
  respond: '💬',
  exclude_object: '🚫',
  force_move: '💪',
  homing_override: '🏠',
  safe_z_home: '🏠',
  endstop_phase: '🔚',
  default: '✨',
};

function FeatureNode({ data, selected, id }: NodeProps) {
  const nodeData = data as unknown as FeatureNodeData;
  const color = FEATURE_COLORS[nodeData.sectionType] || FEATURE_COLORS.default;
  const icon = FEATURE_ICONS[nodeData.sectionType] || FEATURE_ICONS.default;
  const isSuppressed = !!(nodeData as Record<string, unknown>).isSuppressed;
  // Hide connection handles when node lives inside a container
  const isEmbedded = !!(nodeData.parentId);

  return (
    <div
      className={`kwc-node rounded-xl ${selected ? 'selected' : ''} ${nodeData.hasErrors ? 'kwc-error' : ''}`}
      style={{
        borderColor: color,
        borderStyle: 'dashed',
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
        style={{ backgroundColor: `${color}15`, borderBottom: `1px dashed ${color}44` }}
      >
        {nodeData.customImage ? (
          <img src={nodeData.customImage} alt="" className="w-4 h-4 object-contain" />
        ) : (
          <span className="text-sm">{icon}</span>
        )}
        <span className="text-xs" style={{ color }}>
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
        {nodeData.section.params.filter((p) => !p.is_commented_out).length > 0 && (
          <div className="text-[10px] mt-0.5 text-[var(--color-text-secondary)]">
            {nodeData.section.params.filter((p) => !p.is_commented_out).length} params
          </div>
        )}
      </div>
    </div>
  );
}

export default memo(FeatureNode);
