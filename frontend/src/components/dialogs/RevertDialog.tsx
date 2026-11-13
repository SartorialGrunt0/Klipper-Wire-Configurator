import { useState, useCallback } from 'react';
import { useConfigStore } from '../../stores/configStore';
import { useGraphStore } from '../../stores/graphStore';
import { useMacroDesignerStore } from '../../stores/macroDesignerStore';
import { useNativeStore } from '../../stores/nativeStore';
import * as api from '../../services/api';
import { buildProjectGraph } from '../../utils/graphBuilder';
import { buildLayoutPayload, restoreLayoutAfterRebuild } from '../../utils/layoutPersistence';
import { discardReview } from '../../services/changeSetReview';
import type { ConfigFile, ValidationResult } from '../../types/config';
import Modal from '../Modal';

interface RevertDialogProps {
  onClose: () => void;
}

export default function RevertDialog({ onClose }: RevertDialogProps) {
  const configPath = useNativeStore((s) => s.configPath);
  const [status, setStatus] = useState<'idle' | 'reverting' | 'success' | 'error'>('idle');
  const [message, setMessage] = useState('');
  const [clearMacroDesignerState, setClearMacroDesignerState] = useState(true);

  const persistClearedMacroDesignerState = useCallback(async () => {
    const macroDesignerStore = useMacroDesignerStore.getState();
    macroDesignerStore.clearPersistedState();

    const graphState = useGraphStore.getState();
    await api.saveNativeLayout(
      buildLayoutPayload(graphState.nodes, graphState.edges, macroDesignerStore.exportPersistedState()),
    ).catch(() => {});
  }, []);

  const handleRevert = useCallback(async () => {
    setStatus('reverting');
    setMessage('Reverting changes...');

    try {
      const configStore = useConfigStore.getState();
      const schemas = configStore.schemas;

      // Re-read both the current working set and the original files so
      // deleted files come back.
      const filenames = Array.from(new Set([
        ...Object.keys(configStore.originalTexts),
        ...Object.keys(configStore.configFiles),
      ]));
      if (filenames.length === 0) {
        setStatus('error');
        setMessage('No files to revert.');
        return;
      }

      // The buffer is thrown away wholesale, so the review goes with it:
      // `discardReview` clears the change set and the pane's pending view.
      // Without it the next keep/undo replays this request's staged edits
      // onto a file that no longer contains them (live report 2026-10-04).
      discardReview();
      configStore.clearAll();
      useGraphStore.getState().clearGraph();

      const result = await api.readNativeConfigFiles(filenames, configPath);

      const allConfigs: Record<string, ConfigFile> = {};
      const allValidations: Record<string, ValidationResult> = {};

      for (const [filename, fileResult] of Object.entries(result.files)) {
        configStore.setConfigFile(filename, fileResult.config);
        configStore.setValidation(filename, fileResult.validation);
        allConfigs[filename] = fileResult.config;
        allValidations[filename] = fileResult.validation;

        if (fileResult.raw_text) {
          configStore.setOriginalText(filename, fileResult.raw_text);
        }
      }

      // Rebuild graph
      const graphStore = useGraphStore.getState();
      buildProjectGraph(allConfigs, graphStore, schemas, allValidations);
      // Re-apply the saved layout — the rebuild renumbers node ids, and the
      // macro-state persist below must save the restored arrangement, not
      // the auto-arranged one. Pass the state GETTER (not the pre-build
      // snapshot, which is empty right after clearGraph()) so the layout
      // lands on the freshly built graph.
      await restoreLayoutAfterRebuild(useGraphStore.getState);

      if (clearMacroDesignerState) {
        await persistClearedMacroDesignerState();
      }

      configStore.markClean();
      setStatus('success');
      setMessage('Changes reverted successfully.');
      setTimeout(onClose, 800);
    } catch (err) {
      setStatus('error');
      setMessage(err instanceof Error ? err.message : 'Revert failed');
    }
  }, [clearMacroDesignerState, configPath, onClose, persistClearedMacroDesignerState]);

  return (
    <Modal
      onClose={onClose}
      label="Revert Changes"
      backdropClassName="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
      panelClassName="bg-[var(--color-bg-secondary)] rounded-xl shadow-2xl w-[420px] flex flex-col border border-[var(--color-bg-tertiary)]"
    >
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-[var(--color-bg-tertiary)]">
          <h2 className="text-base font-semibold text-[var(--color-text-primary)]">Revert Changes</h2>
          <button aria-label="Close" onClick={onClose} className="p-1 rounded hover:bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)]">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        {/* Content */}
        <div className="p-4">
          {status === 'idle' && (
            <div className="space-y-3">
              <div className="px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/30">
                <p className="text-xs text-amber-400">
                  This will discard all unsaved changes and reload the config from the host.
                </p>
              </div>
              <p className="text-xs text-[var(--color-text-secondary)]">
                Are you sure you want to revert?
              </p>
              <label className="flex items-center gap-2 text-xs text-[var(--color-text-secondary)] cursor-pointer">
                <input
                  type="checkbox"
                  checked={clearMacroDesignerState}
                  onChange={(event) => setClearMacroDesignerState(event.target.checked)}
                  className="rounded"
                />
                Clear Macro Designer drafts/layout
              </label>
            </div>
          )}

          {message && status !== 'idle' && (
            <p className={`text-xs ${
              status === 'error' ? 'text-red-400' :
              status === 'success' ? 'text-green-400' :
              'text-[var(--color-text-secondary)]'
            }`}>
              {message}
            </p>
          )}
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-[var(--color-bg-tertiary)] flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-4 py-1.5 rounded-md text-xs font-medium bg-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] hover:bg-[var(--color-bg-primary)] transition-colors"
          >
            Cancel
          </button>
          {status === 'idle' && (
            <button
              onClick={handleRevert}
              className="px-4 py-1.5 rounded-md text-xs font-medium bg-red-600 text-white hover:bg-red-700 transition-colors"
            >
              Revert All Changes
            </button>
          )}
        </div>
      
    </Modal>
  );
}
