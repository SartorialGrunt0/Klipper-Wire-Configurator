import { useState, useRef, useCallback } from 'react';
import { useConfigStore } from '../stores/configStore';
import { useGraphStore } from '../stores/graphStore';
import * as api from '../services/api';
import ImportDialog from './dialogs/ImportDialog';
import ExportDialog from './dialogs/ExportDialog';
import GenerateDialog from './dialogs/GenerateDialog';
import DiffDialog from './dialogs/DiffDialog';

interface ToolbarProps {
  showTextView: boolean;
  onToggleTextView: () => void;
}

export default function Toolbar({ showTextView, onToggleTextView }: ToolbarProps) {
  const [showImport, setShowImport] = useState(false);
  const [showExport, setShowExport] = useState(false);
  const [showGenerate, setShowGenerate] = useState(false);
  const [showDiff, setShowDiff] = useState(false);
  const hasOriginals = Object.keys(useConfigStore((s) => s.originalTexts)).length > 0;

  return (
    <div className="flex items-center gap-2">
      {/* Import */}
      <button
        onClick={() => setShowImport(true)}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] hover:bg-[var(--color-accent)] hover:text-[var(--color-bg-primary)] transition-colors"
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
          <path d="M2 10v3a1 1 0 001 1h10a1 1 0 001-1v-3M8 2v9M5 8l3 3 3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
        Import
      </button>

      {/* Generate */}
      <button
        onClick={() => setShowGenerate(true)}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] hover:bg-[var(--color-accent)] hover:text-[var(--color-bg-primary)] transition-colors"
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
          <path d="M8 2v12M2 8h12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
        </svg>
        Generate
      </button>

      {/* Export */}
      <button
        onClick={() => setShowExport(true)}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] hover:bg-[var(--color-accent)] hover:text-[var(--color-bg-primary)] transition-colors"
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
          <path d="M2 10v3a1 1 0 001 1h10a1 1 0 001-1v-3M8 11V2M5 5l3-3 3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
        Export
      </button>

      {/* Diff */}
      {hasOriginals && (
        <button
          onClick={() => setShowDiff(true)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] hover:bg-[var(--color-accent)] hover:text-[var(--color-bg-primary)] transition-colors"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <path d="M4 3v10M8 3v10M12 6l-4 4M12 10l-4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          Diff
        </button>
      )}

      {/* Divider */}
      <div className="w-px h-5 bg-[var(--color-bg-tertiary)]" />

      {/* Toggle text/graph view */}
      <button
        onClick={onToggleTextView}
        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
          showTextView
            ? 'bg-[var(--color-accent)] text-[var(--color-bg-primary)]'
            : 'bg-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] hover:bg-[var(--color-accent)] hover:text-[var(--color-bg-primary)]'
        }`}
      >
        {showTextView ? (
          <>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <circle cx="4" cy="4" r="2" stroke="currentColor" strokeWidth="1.5"/>
              <circle cx="12" cy="12" r="2" stroke="currentColor" strokeWidth="1.5"/>
              <path d="M6 4h4l-4 8h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
            </svg>
            Graph View
          </>
        ) : (
          <>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <path d="M3 4h10M3 8h7M3 12h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
            </svg>
            Text View
          </>
        )}
      </button>

      {/* Dialogs */}
      {showImport && <ImportDialog onClose={() => setShowImport(false)} />}
      {showExport && <ExportDialog onClose={() => setShowExport(false)} />}
      {showGenerate && <GenerateDialog onClose={() => setShowGenerate(false)} />}
      {showDiff && <DiffDialog onClose={() => setShowDiff(false)} />}
    </div>
  );
}
