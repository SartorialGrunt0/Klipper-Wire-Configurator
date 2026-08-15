import { memo } from 'react';
import { type NodeProps } from '@xyflow/react';
import type { FeatureNodeData } from '../../types/graph';
import NodeActions from './NodeActions';
import WarningBadge from './WarningBadge';
import type { ValidationStatus } from '../../types/graph';
import { FEATURE_COLORS } from '../../constants/graphColors';

function FeatureNode({ data, selected, id }: NodeProps) {
  const nodeData = data as unknown as FeatureNodeData;
  const color = FEATURE_COLORS[nodeData.sectionType] || FEATURE_COLORS.default;
  const isSuppressed = !!(nodeData as Record<string, unknown>).isSuppressed;
  const isEmbedded = !!(nodeData.parentId);
  const isStandalone = !!(nodeData as Record<string, unknown>).isStandalone;
  const isOrphan = !isEmbedded && !isStandalone;
  const validationStatus = (nodeData.validationStatus || 'valid') as ValidationStatus;
  const effectiveValidationStatus = isOrphan ? 'error' : validationStatus;
  const hasErrors = nodeData.hasErrors || isOrphan;

  return (
    <div
      className={`kwc-compact-tile rounded-lg ${selected ? 'selected' : ''} ${hasErrors ? 'kwc-error' : ''} ${effectiveValidationStatus === 'warning' ? 'kwc-warning' : ''}`}
      style={{
        borderColor: color,
        borderStyle: 'dashed',
        backgroundColor: 'var(--color-bg-secondary)',
        width: 180,
        opacity: isSuppressed ? 0.45 : 1,
        position: 'relative',
      }}
    >
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
        <WarningBadge status={effectiveValidationStatus} />
        <span className="text-xs truncate" style={{ color }}>
          {nodeData.label}
        </span>
        {isOrphan && (
          <span className="text-[9px] px-1 py-0.5 rounded bg-red-500/15 text-[var(--color-error)] ml-auto shrink-0">
            ORPHAN
          </span>
        )}
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
