import { memo, useCallback } from 'react';
import { type NodeProps } from '@xyflow/react';
import type { GroupNodeData, GroupChildItem } from '../../types/graph';
import { useGraphStore } from '../../stores/graphStore';
import { useConfigStore } from '../../stores/configStore';
import NodeActions from './NodeActions';
import WarningBadge from './WarningBadge';
import type { ValidationStatus } from '../../types/graph';
import { getValidationStatusColor } from '../../utils/validationStatus';
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
  const isStandalone = !!(nodeData as Record<string, unknown>).isStandalone;
  const isOrphan = !isEmbedded && !isStandalone;
  const validationStatus = (nodeData.validationStatus || 'valid') as ValidationStatus;
  const effectiveValidationStatus = isOrphan ? 'error' : validationStatus;
  const hasErrors = nodeData.hasErrors || isOrphan;

  const { setSelectedNode, removeFromGroup } = useGraphStore();
  const { setSelectedSection } = useConfigStore();

  const handleChildClick = useCallback((e: React.MouseEvent, child: GroupChildItem) => {
    e.stopPropagation();
    setSelectedNode(id);
    setSelectedSection(child.sectionHeader, child.configFile ?? null, child.sectionLineNumber ?? null);
  }, [id, setSelectedNode, setSelectedSection]);

  const handleRemoveChild = useCallback((e: React.MouseEvent, idx: number) => {
    e.stopPropagation();
    removeFromGroup(id, idx);
  }, [id, removeFromGroup]);

  return (
    <div
      className={`kwc-compact-tile rounded-lg ${selected ? 'selected' : ''} ${hasErrors ? 'kwc-error' : ''} ${effectiveValidationStatus === 'warning' ? 'kwc-warning' : ''}`}
      style={{
        borderColor: color,
        borderStyle: isFeature ? 'dashed' : 'solid',
        backgroundColor: 'var(--color-bg-secondary)',
        width: 180,
        position: 'relative',
      }}
    >
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
        <WarningBadge status={effectiveValidationStatus} />
        <span className="text-xs font-semibold truncate" style={{ color }}>
          {nodeData.label}
        </span>
        {isOrphan && (
          <span className="text-[9px] px-1 py-0.5 rounded bg-red-500/15 text-[var(--color-error)] shrink-0">
            ORPHAN
          </span>
        )}
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
          {children.map((child, idx) => (
            <div
              key={`${child.configFile || 'cfg'}::${child.sectionHeader}::${idx}`}
              className="flex items-center gap-1 group/child"
            >
              <span
                className="w-1.5 h-1.5 rounded-full shrink-0"
                style={{ backgroundColor: getValidationStatusColor(child.validationStatus || 'valid') }}
              />
              <div
                className="text-[10px] truncate px-1 py-0.5 rounded cursor-pointer hover:bg-[var(--color-bg-primary)] flex-1 min-w-0"
                style={{ color: child.isSuppressed ? 'var(--color-text-secondary)' : undefined, opacity: child.isSuppressed ? 0.5 : 1 }}
                onClick={(e) => handleChildClick(e, child)}
              >
                {child.label}
              </div>
              {child.isSuppressed && (
                <span className="text-[9px] px-1 py-0.5 rounded bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)] shrink-0">
                  OFF
                </span>
              )}
              <button
                title="Remove from group"
                className="shrink-0 w-4 h-4 flex items-center justify-center rounded opacity-0 group-hover/child:opacity-100 hover:bg-red-500/20 text-red-400 transition-opacity"
                onClick={(e) => handleRemoveChild(e, idx)}
              >
                <svg width="8" height="8" viewBox="0 0 10 10" fill="none">
                  <path d="M2 2l6 6M8 2l-6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default memo(GroupNode);
