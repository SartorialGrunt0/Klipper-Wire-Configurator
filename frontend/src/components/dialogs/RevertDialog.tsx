import { useState, useCallback } from 'react';
import { useConfigStore } from '../../stores/configStore';
import { useGraphStore } from '../../stores/graphStore';
import { useMacroDesignerStore } from '../../stores/macroDesignerStore';
import { useNativeStore } from '../../stores/nativeStore';
import * as api from '../../services/api';
import { buildProjectGraph } from '../../utils/graphBuilder';
import { restoreLayoutAfterRebuild } from '../../utils/layoutPersistence';
import type { ConfigFile, ValidationResult } from '../../types/config';

interface RevertDialogProps {
  onClose: () => void;
}

export default function RevertDialog({ onClose }: RevertDialogProps) {
  const isNative = useNativeStore((s) => s.isNative);
  const configPath = useNativeStore((s) => s.configPath);
  const [status, setStatus] = useState<'idle' | 'reverting' | 'success' | 'error'>('idle');
  const [message, setMessage] = useState('');
  const [clearMacroDesignerState, setClearMacroDesignerState] = useState(true);

  const persistClearedMacroDesignerState = useCallback(async () => {
    const macroDesignerStore = useMacroDesignerStore.getState();
    macroDesignerStore.clearPersistedState();
    if (!isNative) return;

    const graphState = useGraphStore.getState();
    await api.saveNativeLayout({
      graphNodes: graphState.nodes,
      graphEdges: graphState.edges,
      macroDesigner: macroDesignerStore.exportPersistedState(),
    }).catch(() => {});
  }, [isNative]);

  const handleRevert = useCallback(async () => {
    setStatus('reverting');
    setMessage('Reverting changes...');

    try {
      const configStore = useConfigStore.getState();
      const schemas = configStore.schemas;

      if (isNative) {
        // Native mode: re-read both the current working set and original files so deleted files return.
        const filenames = Array.from(new Set([
          ...Object.keys(configStore.originalTexts),
          ...Object.keys(configStore.configFiles),
        ]));
        if (filenames.length === 0) {
          setStatus('error');
          setMessage('No files to revert.');
          return;
        }

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
        // Re-apply the saved layout — the rebuild renumbers node ids, and
        // the macro-state persist below must save the restored arrangement,
        // not the auto-arranged one. Pass the state GETTER (not the
        // pre-build snapshot, which is empty right after clearGraph()) so
        // the layout lands on the freshly built graph.
        await restoreLayoutAfterRebuild(useGraphStore.getState, isNative);
      } else {
        // Non-native mode: re-parse from originalTexts
        const { originalTexts } = configStore;
        if (Object.keys(originalTexts).length === 0) {
          setStatus('error');
          setMessage('No original versions to revert to.');
          return;
        }

        configStore.clearAll();
        useGraphStore.getState().clearGraph();

        const allConfigs: Record<string, ConfigFile> = {};
        const allValidations: Record<string, ValidationResult> = {};

        for (const [filename, text] of Object.entries(originalTexts)) {
          const result = await api.parseConfigText(text, filename);
          configStore.setConfigFile(filename, result.config);
          configStore.setValidation(filename, result.validation);
          configStore.setOriginalText(filename, text);
          allConfigs[filename] = result.config;
          allValidations[filename] = result.validation;
        }

        // Rebuild graph
        const graphStore = useGraphStore.getState();
        buildProjectGraph(allConfigs, graphStore, schemas, allValidations);
        // Re-apply the saved layout (same reason as the native branch above);
        // getter, not pre-build snapshot — see restoreLayoutAfterRebuild.
        await restoreLayoutAfterRebuild(useGraphStore.getState, isNative);
      }

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
  }, [clearMacroDesignerState, configPath, isNative, onClose, persistClearedMacroDesignerState]);

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="bg-[var(--color-bg-secondary)] rounded-xl shadow-2xl w-[420px] flex flex-col border border-[var(--color-bg-tertiary)]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-[var(--color-bg-tertiary)]">
          <h2 className="text-base font-semibold text-[var(--color-text-primary)]">Revert Changes</h2>
          <button onClick={onClose} className="p-1 rounded hover:bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)]">
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
                  This will discard all unsaved changes and reload the config from {isNative ? 'the Pi' : 'the original import'}.
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
              className="px-4 py-1.5 rounded-md text-xs font-medium bg-red-500 text-white hover:bg-red-600 transition-colors"
            >
              Revert All Changes
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
