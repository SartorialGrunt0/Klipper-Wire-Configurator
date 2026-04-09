import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { HardwareNodeData } from '../../types/graph';

const HARDWARE_COLORS: Record<string, string> = {
  sbc: 'var(--color-sbc)',
  mainboard: 'var(--color-mainboard)',
  toolhead: 'var(--color-toolhead)',
  expander: 'var(--color-expander)',
  probe: 'var(--color-probe)',
  accelerometer: 'var(--color-accelerometer)',
  other: 'var(--color-other)',
};

const HARDWARE_ICONS: Record<string, string> = {
  sbc: '🖥️',
  mainboard: '📟',
  toolhead: '🔧',
  expander: '🔌',
  probe: '📍',
  accelerometer: '📊',
  other: '⬜',
};

const HARDWARE_SHAPES: Record<string, string> = {
  sbc: 'rounded-xl',
  mainboard: 'rounded-lg',
  toolhead: 'rounded-2xl',
  expander: 'rounded-lg',
  probe: 'rounded-full min-w-[120px] text-center',
  accelerometer: 'rounded-lg',
  other: 'rounded-md',
};

function HardwareNode({ data, selected }: NodeProps) {
  const nodeData = data as unknown as HardwareNodeData;
  const color = HARDWARE_COLORS[nodeData.hardwareType] || HARDWARE_COLORS.other;
  const icon = HARDWARE_ICONS[nodeData.hardwareType] || HARDWARE_ICONS.other;
  const shape = HARDWARE_SHAPES[nodeData.hardwareType] || HARDWARE_SHAPES.other;
  const isPrimary = !!(nodeData as Record<string, unknown>).isPrimary;

  return (
    <div
      className={`kwc-node ${shape} ${selected ? 'selected' : ''} ${nodeData.hasErrors ? 'kwc-error' : ''}`}
      style={{
        borderColor: color,
        borderWidth: isPrimary ? 3 : 2,
        backgroundColor: 'var(--color-bg-secondary)',
        minWidth: 200,
      }}
    >
      {/* Handles on all sides for flexible connections */}
      <Handle type="target" position={Position.Left} id="left-in"
        style={{ background: color, width: 10, height: 10, top: '40%' }} />
      <Handle type="source" position={Position.Left} id="left-out"
        style={{ background: color, width: 10, height: 10, top: '60%' }} />

      <Handle type="target" position={Position.Right} id="right-in"
        style={{ background: color, width: 10, height: 10, top: '40%' }} />
      <Handle type="source" position={Position.Right} id="right-out"
        style={{ background: color, width: 10, height: 10, top: '60%' }} />

      <Handle type="target" position={Position.Top} id="top-in"
        style={{ background: color, width: 10, height: 10, left: '40%' }} />
      <Handle type="source" position={Position.Top} id="top-out"
        style={{ background: color, width: 10, height: 10, left: '60%' }} />

      <Handle type="target" position={Position.Bottom} id="bottom-in"
        style={{ background: color, width: 10, height: 10, left: '40%' }} />
      <Handle type="source" position={Position.Bottom} id="bottom-out"
        style={{ background: color, width: 10, height: 10, left: '60%' }} />

      {/* Header */}
      <div
        className="kwc-node-header"
        style={{ backgroundColor: `${color}22`, borderBottom: `1px solid ${color}44` }}
      >
        {nodeData.customImage ? (
          <img src={nodeData.customImage} alt="" className="w-5 h-5 object-contain" />
        ) : (
          <span className="text-base">{icon}</span>
        )}
        <span style={{ color }}>{nodeData.label}</span>
        {isPrimary && (
          <span className="ml-auto text-[9px] px-1.5 py-0.5 rounded bg-[var(--color-accent)] text-[var(--color-bg-primary)] font-bold">
            PRIMARY
          </span>
        )}
      </div>

      {/* Body */}
      <div className="kwc-node-body">
        <div className="text-xs opacity-60 uppercase tracking-wider">
          {nodeData.hardwareType}
        </div>
        <div className="text-xs mt-1 text-[var(--color-text-secondary)]">
          {nodeData.configFile}
        </div>
        {nodeData.sections.length > 0 && (
          <div className="text-xs mt-1 text-[var(--color-text-secondary)]">
            {nodeData.sections.length} section{nodeData.sections.length !== 1 ? 's' : ''}
          </div>
        )}
      </div>
    </div>
  );
}

export default memo(HardwareNode);
