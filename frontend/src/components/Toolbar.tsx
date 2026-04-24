import { useState } from 'react';
import { useConfigStore } from '../stores/configStore';
import { useNativeStore } from '../stores/nativeStore';
import ImportDialog from './dialogs/ImportDialog';
import ExportDialog from './dialogs/ExportDialog';
import DiffDialog from './dialogs/DiffDialog';
import OpenFromPiDialog from './dialogs/OpenFromPiDialog';
import ApplyDialog from './dialogs/ApplyDialog';
import RevertDialog from './dialogs/RevertDialog';

interface ToolbarProps {
  showTextView: boolean;
  onToggleTextView: () => void;
  onToggleAddMenu?: () => void;
  onOpenMacroDesigner?: () => void;
}

export default function Toolbar({
  showTextView,
  onToggleTextView,
  onToggleAddMenu,
  onOpenMacroDesigner,
}: ToolbarProps) {
  const [showImport, setShowImport] = useState(false);
  const [showExport, setShowExport] = useState(false);
  const [showDiff, setShowDiff] = useState(false);
  const [showOpenFromPi, setShowOpenFromPi] = useState(false);
  const [showApply, setShowApply] = useState(false);
  const [showRevert, setShowRevert] = useState(false);
  const hasOriginals = Object.keys(useConfigStore((s) => s.originalTexts)).length > 0;
  const isNative = useNativeStore((s) => s.isNative);
  const hasConfig = Object.keys(useConfigStore((s) => s.configFiles)).length > 0;
  const isConfigDirty = useConfigStore((s) => s.isDirty);
  const isTextDirty = useConfigStore((s) => s.textEditorDirty);
  const validation = useConfigStore((s) => s.validation);
  const hasPendingChanges = isConfigDirty || isTextDirty;

  // Compute Save button color based on dirty state and validation
  const getSaveButtonClass = () => {
    if (!isConfigDirty) {
      // No changes — normal grey
      return 'bg-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] hover:bg-[var(--color-accent)] hover:text-[var(--color-bg-primary)]';
    }
    const hasErrors = Object.values(validation).some((v) =>
      v.errors.some((e) => e.severity === 'error'),
    );
    const hasWarnings = Object.values(validation).some((v) =>
      v.errors.some((e) => e.severity === 'warning'),
    );
    if (hasErrors) {
      return 'bg-red-600 text-white hover:bg-red-700';
    }
    if (hasWarnings) {
      return 'bg-orange-500 text-white hover:bg-orange-600';
    }
    // Valid changes
    return 'bg-green-600 text-white hover:bg-green-700';
  };

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

      {/* Open from Pi (native only) */}
      {isNative && (
        <button
          onClick={() => setShowOpenFromPi(true)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] hover:bg-[var(--color-accent)] hover:text-[var(--color-bg-primary)] transition-colors"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <path d="M2 3h12v8H2zM5 14h6M8 11v3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          Open from Pi
        </button>
      )}

      {/* + Component */}
      {onToggleAddMenu && (
        <button
          onClick={onToggleAddMenu}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] hover:bg-[var(--color-accent)] hover:text-[var(--color-bg-primary)] transition-colors"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
          </svg>
          Component
        </button>
      )}

      {onOpenMacroDesigner && (
        <button
          onClick={onOpenMacroDesigner}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] hover:bg-[var(--color-accent)] hover:text-[var(--color-bg-primary)] transition-colors"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
          </svg>
          Macro
        </button>
      )}

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

      {/* Save to Pi (native only) */}
      {isNative && hasConfig && (
        <button
          onClick={() => setShowApply(true)}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${getSaveButtonClass()}`}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <path d="M3 8l3.5 3.5L13 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          Save
        </button>
      )}

      {/* Revert Changes (native or when originals exist) */}
      {hasPendingChanges && hasOriginals && (
        <button
          onClick={() => setShowRevert(true)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] hover:bg-[var(--color-accent)] hover:text-[var(--color-bg-primary)] transition-colors"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <path d="M3 6h7a3 3 0 010 6H8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            <path d="M6 3L3 6l3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          Revert
        </button>
      )}

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
      {showDiff && <DiffDialog onClose={() => setShowDiff(false)} />}
      {showOpenFromPi && <OpenFromPiDialog onClose={() => setShowOpenFromPi(false)} />}
      {showApply && <ApplyDialog onClose={() => setShowApply(false)} />}
      {showRevert && <RevertDialog onClose={() => setShowRevert(false)} />}
    </div>
  );
}
