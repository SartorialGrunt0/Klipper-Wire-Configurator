import { memo, useState, useCallback } from 'react';
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
  gcode_macro: '📝',
  bed_leveling: '🗺️',
  homing: '🏠',
  resonance: '〰️',
  other: '⬜',
};

function GroupNode({ data, selected, id }: NodeProps) {
  const nodeData = data as unknown as GroupNodeData;
  const [expanded, setExpanded] = useState(false);
  const color = GROUP_COLORS[nodeData.componentGroup] || GROUP_COLORS.other;
  const icon = GROUP_ICONS[nodeData.componentGroup] || GROUP_ICONS.other;
  const isFeature = nodeData.isFeature;
  const children: GroupChildItem[] = nodeData.children || [];
  // Hide handles when this group lives inside a hardware container
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
      className={`kwc-node rounded-xl ${selected ? 'selected' : ''} ${nodeData.hasErrors ? 'kwc-error' : ''}`}
      style={{
        borderColor: color,
        borderStyle: isFeature ? 'dashed' : 'solid',
        backgroundColor: 'var(--color-bg-secondary)',
        width: 268,
      }}
    >
      <Handle type="target" position={Position.Left} id="left-in"
        style={{ background: color, width: 12, height: 12, top: '50%', display: isEmbedded ? 'none' : undefined }} />
      <Handle type="source" position={Position.Right} id="right-out"
        style={{ background: color, width: 12, height: 12, top: '50%', display: isEmbedded ? 'none' : undefined }} />
      <Handle type="target" position={Position.Top} id="top-in"
        style={{ background: color, width: 12, height: 12, left: '50%', display: isEmbedded ? 'none' : undefined }} />
      <Handle type="source" position={Position.Bottom} id="bottom-out"
        style={{ background: color, width: 12, height: 12, left: '50%', display: isEmbedded ? 'none' : undefined }} />

      {/* Header - clickable to expand/collapse */}
      <div
        className="kwc-node-header cursor-pointer select-none"
        style={{ backgroundColor: `${color}22`, borderBottom: `1px solid ${color}44` }}
        onClick={(e) => { e.stopPropagation(); setExpanded(!expanded); }}
      >
        <span className="text-sm">{icon}</span>
        <span className="text-xs font-semibold" style={{ color }}>
          {nodeData.label}
        </span>
        <span className="ml-auto flex items-center gap-1">
          <span
            className="text-[10px] px-1.5 py-0.5 rounded-full font-bold"
            style={{ backgroundColor: `${color}33`, color }}
          >
            {children.length}
          </span>
          <span className="text-[10px] text-[var(--color-text-secondary)] transition-transform" style={{
            display: 'inline-block',
            transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)',
          }}>
            ▼
          </span>
          <NodeActions nodeId={id} color={color} />
        </span>
      </div>

      {/* Collapsed: show compact summary */}
      {!expanded && (
        <div className="kwc-node-body">
          <div className="space-y-0.5">
            {children.slice(0, 4).map((child) => (
              <div key={child.sectionHeader} className="text-[10px] text-[var(--color-text-secondary)] truncate max-w-[240px]">
                {child.label}
              </div>
            ))}
            {children.length > 4 && (
              <div className="text-[10px] text-[var(--color-text-secondary)] opacity-50">
                +{children.length - 4} more
              </div>
            )}
          </div>
        </div>
      )}

      {/* Expanded: show all children with details */}
      {expanded && (
        <div className="kwc-node-body max-h-[400px] overflow-y-auto">
          <div className="space-y-1.5">
            {children.map((child) => (
              <div
                key={child.sectionHeader}
                className="p-1.5 rounded-lg border transition-colors hover:bg-[var(--color-bg-primary)] cursor-pointer"
                style={{ borderColor: `${color}33` }}
                onClick={(e) => handleChildClick(e, child)}
              >
                <div className="text-[11px] font-medium text-[var(--color-text-primary)] truncate">
                  {child.label}
                </div>
                {child.params && child.params.length > 0 && (
                  <div className="mt-0.5 space-y-0.5">
                    {child.params.slice(0, 2).map((p) => (
                      <div key={p.key} className="text-[9px] text-[var(--color-text-secondary)] truncate">
                        <span className="text-[var(--color-accent)]">{p.key}:</span> {p.value}
                      </div>
                    ))}
                    {child.params.length > 2 && (
                      <div className="text-[9px] text-[var(--color-text-secondary)] opacity-50">
                        +{child.params.length - 2} params
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default memo(GroupNode);
