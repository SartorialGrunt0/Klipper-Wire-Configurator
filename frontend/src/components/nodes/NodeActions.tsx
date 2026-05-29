import { memo, useCallback } from 'react';
import { useGraphStore } from '../../stores/graphStore';

interface NodeActionsProps {
  nodeId: string;
  color: string;
  onDeleteRequested?: () => void;
}

function NodeActions({ nodeId, color, onDeleteRequested }: NodeActionsProps) {
  const { removeNode, duplicateNode } = useGraphStore();

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
    removeNode(nodeId);
  }, [nodeId, onDeleteRequested, removeNode]);

  return (
    <div className="flex items-center gap-0.5 ml-auto shrink-0">
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
    </div>
  );
}

export default memo(NodeActions);
