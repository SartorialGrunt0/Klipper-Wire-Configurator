import { memo, useCallback, useState } from 'react';
import { useGraphStore } from '../../stores/graphStore';

interface NodeActionsProps {
  nodeId: string;
  color: string;
  onDeleteRequested?: () => void;
}

/**
 * Multi-section node types remove several config sections at once — deleting
 * them silently is a footgun (Pattern 9e), so they confirm inline. Single-
 * section tiles delete directly. HardwareNode passes onDeleteRequested and
 * renders its own richer dialog (config file deletion).
 */
const MULTI_SECTION_TYPES = new Set(['group', 'customGroup']);

function NodeActions({ nodeId, color, onDeleteRequested }: NodeActionsProps) {
  const { removeNode, duplicateNode, nodes } = useGraphStore();
  const [showConfirm, setShowConfirm] = useState(false);

  const nodeType = nodes.find((n) => n.id === nodeId)?.type;

  const handleCopy = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    duplicateNode(nodeId);
  }, [nodeId, duplicateNode]);

  const handleDelete = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (onDeleteRequested) {
      onDeleteRequested();
      return;
    }
    if (nodeType && MULTI_SECTION_TYPES.has(nodeType)) {
      setShowConfirm(true);
      return;
    }
    removeNode(nodeId);
  }, [nodeId, nodeType, onDeleteRequested, removeNode]);

  const handleConfirmDelete = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setShowConfirm(false);
    removeNode(nodeId);
  }, [nodeId, removeNode]);

  return (
    <div className="flex items-center gap-0.5 ml-auto shrink-0 relative">
      <button
        onClick={handleCopy}
        title="Duplicate"
        className="flex items-center justify-center w-5 h-5 rounded hover:bg-white/10 transition-colors"
        style={{ color }}
      >
        <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
          <rect x="5" y="5" width="9" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
          <path d="M11 5V3.5A1.5 1.5 0 009.5 2h-6A1.5 1.5 0 002 3.5v6A1.5 1.5 0 003.5 11H5" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      </button>
      <button
        onClick={handleDelete}
        title="Delete"
        className="flex items-center justify-center w-5 h-5 rounded hover:bg-red-500/20 transition-colors text-red-400"
      >
        <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
          <path d="M3 4h10M5.5 4V3a1 1 0 011-1h3a1 1 0 011 1v1M6 7v4M10 7v4M4 4l.8 9a1 1 0 001 .9h4.4a1 1 0 001-.9L12 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {showConfirm && (
        <div
          className="absolute right-0 top-full mt-1 z-50 w-52 rounded-xl border border-[var(--color-bg-tertiary)] bg-[var(--color-bg-secondary)] p-3 shadow-2xl"
          onClick={(event) => event.stopPropagation()}
        >
          <p className="text-[11px] leading-5 text-[var(--color-text-primary)]">
            Delete this group and all its configuration sections?
          </p>
          <div className="mt-3 flex justify-end gap-2">
            <button
              onClick={() => setShowConfirm(false)}
              className="rounded-md border border-[var(--color-bg-tertiary)] px-2.5 py-1 text-[11px] text-[var(--color-text-primary)] hover:border-[var(--color-accent)]"
            >
              Cancel
            </button>
            <button
              onClick={handleConfirmDelete}
              className="rounded-md bg-[var(--color-error)] px-2.5 py-1 text-[11px] font-medium text-[var(--color-bg-primary)] hover:opacity-90"
            >
              Delete
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default memo(NodeActions);
