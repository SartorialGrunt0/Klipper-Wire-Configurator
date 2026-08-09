import { useState, useEffect, useCallback } from 'react';
import { useConfigStore } from '../../stores/configStore';
import { useGraphStore } from '../../stores/graphStore';
import { useMacroDesignerStore } from '../../stores/macroDesignerStore';
import { useNativeStore } from '../../stores/nativeStore';
import * as api from '../../services/api';
import { buildProjectGraph } from '../../utils/graphBuilder';
import type { ConfigFile, ValidationResult } from '../../types/config';

interface OpenFromPiDialogProps {
  onClose: () => void;
}

export default function OpenFromPiDialog({ onClose }: OpenFromPiDialogProps) {
  const { configPath, setConfigPath, isNative } = useNativeStore();
  const [pathInput, setPathInput] = useState(configPath);
  const [files, setFiles] = useState<api.NativeConfigFile[]>([]);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [status, setStatus] = useState<'loading' | 'idle' | 'importing' | 'success' | 'error'>('loading');
  const [message, setMessage] = useState('');
  const [clearExisting, setClearExisting] = useState(true);
  const [clearMacroDesignerState, setClearMacroDesignerState] = useState(true);

  const { setConfigFile, setValidation } = useConfigStore();

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

  const loadFiles = useCallback(async (path: string) => {
    setStatus('loading');
    setMessage('');
    // Extract the filename component from a relative POSIX path returned by the backend.
    // The backend (Linux/Raspberry Pi) always uses forward slashes, so splitting on '/'
    // is safe here.
    const basename = (p: string) => p.split('/').pop() ?? p;
    try {
      const result = await api.listNativeConfigFiles(path);
      // Filter out backup files like printer-20251130_014641.cfg
      const isBackup = (name: string) => /^printer-\d{8}_\d+\.cfg$/i.test(name);
      const visible = result.files.filter((f) => !isBackup(basename(f.name)));
      setFiles(visible);
      // Auto-select all .cfg files, deselect known non-klipper ones
      const sel: Record<string, boolean> = {};
      for (const f of visible) {
        const base = basename(f.name).toLowerCase();
        const skip = base === 'moonraker.conf' || base === 'crowsnest.conf' ||
          base === 'klipperscreen.conf' || base === 'sonar.conf' ||
          base.endsWith('.bak') || base.endsWith('.old');
        sel[f.name] = !skip;
      }
      setSelected(sel);
      setStatus('idle');
      if (visible.length === 0) {
        setMessage('No .cfg files found in this directory.');
      }
    } catch (err) {
      setStatus('error');
      setMessage(err instanceof Error ? err.message : 'Failed to list files');
    }
  }, []);

  useEffect(() => {
    loadFiles(configPath);
  }, [configPath, loadFiles]);

  const handlePathChange = useCallback(() => {
    setConfigPath(pathInput);
    loadFiles(pathInput);
  }, [pathInput, setConfigPath, loadFiles]);

  const handleImport = useCallback(async () => {
    // Persist the typed path first so every downstream operation (diff,
    // Apply/Save, Revert, AI tools) maps back to the path the user entered,
    // even when they did not click "Browse" first.
    setConfigPath(pathInput);

    const filenames = Object.entries(selected)
      .filter(([, v]) => v)
      .map(([k]) => k);

    if (filenames.length === 0) {
      setStatus('error');
      setMessage('No files selected.');
      return;
    }

    setStatus('importing');
    setMessage(`Reading ${filenames.length} file${filenames.length > 1 ? 's' : ''}...`);

    try {
      // Ensure schemas are loaded
      let schemas = useConfigStore.getState().schemas;
      if (Object.keys(schemas).length === 0) {
        try {
          const schemaResult = await api.getSchema();
          useConfigStore.getState().setSchemas(schemaResult.schemas);
          schemas = schemaResult.schemas;
        } catch { /* proceed without */ }
      }

      if (clearExisting) {
        useConfigStore.getState().clearAll();
        useGraphStore.getState().clearGraph();
      }

      const result = await api.readNativeConfigFiles(filenames, pathInput);

      const allConfigs: Record<string, ConfigFile> = {};
      const allValidations: Record<string, ValidationResult> = {};

      for (const [filename, fileResult] of Object.entries(result.files)) {
        setConfigFile(filename, fileResult.config);
        setValidation(filename, fileResult.validation);
        allConfigs[filename] = fileResult.config;
        allValidations[filename] = fileResult.validation;

        if (fileResult.raw_text) {
          useConfigStore.getState().setOriginalText(filename, fileResult.raw_text);
        }
      }

      // Build graph
      const graphStore = useGraphStore.getState();
      buildProjectGraph(allConfigs, graphStore, schemas, allValidations);

      if (clearMacroDesignerState) {
        await persistClearedMacroDesignerState();
      }

      setStatus('success');
      setMessage(
        `Loaded ${Object.keys(result.files).length} file${Object.keys(result.files).length > 1 ? 's' : ''} ` +
        `from ${pathInput}`,
      );
    } catch (err) {
      setStatus('error');
      setMessage(err instanceof Error ? err.message : 'Import failed');
    }
  }, [selected, pathInput, clearExisting, clearMacroDesignerState, persistClearedMacroDesignerState, setConfigFile, setValidation]);

  const toggleFile = (name: string) => {
    setSelected((prev) => ({ ...prev, [name]: !prev[name] }));
  };

  const selectAll = () => setSelected((prev) => {
    const next = { ...prev };
    for (const k of Object.keys(next)) next[k] = true;
    return next;
  });

  const selectNone = () => setSelected((prev) => {
    const next = { ...prev };
    for (const k of Object.keys(next)) next[k] = false;
    return next;
  });

  const selectedCount = Object.values(selected).filter(Boolean).length;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="bg-[var(--color-bg-secondary)] rounded-xl shadow-2xl w-[520px] max-h-[80vh] flex flex-col border border-[var(--color-bg-tertiary)]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-[var(--color-bg-tertiary)]">
          <div>
            <h2 className="text-base font-semibold text-[var(--color-text-primary)]">Open from Pi</h2>
            <p className="text-xs text-[var(--color-text-secondary)] mt-0.5">
              Read Klipper config files directly from the Raspberry Pi
            </p>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)]">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        {/* Config path */}
        <div className="p-4 border-b border-[var(--color-bg-tertiary)]">
          <label className="block text-xs font-medium text-[var(--color-text-secondary)] mb-1">
            Config Directory
          </label>
          <div className="flex gap-2">
            <input
              type="text"
              value={pathInput}
              onChange={(e) => setPathInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handlePathChange()}
              className="flex-1 px-2 py-1.5 rounded-md border border-[var(--color-bg-tertiary)] bg-[var(--color-bg-primary)] text-xs text-[var(--color-text-primary)] font-mono"
            />
            <button
              onClick={handlePathChange}
              className="px-3 py-1.5 rounded-md text-xs font-medium bg-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] hover:bg-[var(--color-accent)] hover:text-[var(--color-bg-primary)] transition-colors"
            >
              Browse
            </button>
          </div>
        </div>

        {/* File list */}
        <div className="flex-1 overflow-y-auto p-4">
          {status === 'loading' && (
            <div className="flex items-center justify-center py-8 text-sm text-[var(--color-text-secondary)]">
              Loading files...
            </div>
          )}

          {status !== 'loading' && files.length > 0 && (
            <>
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs text-[var(--color-text-secondary)]">
                  {selectedCount} of {files.length} files selected
                </span>
                <div className="flex gap-2">
                  <button onClick={selectAll} className="text-xs text-[var(--color-accent)] hover:underline">All</button>
                  <button onClick={selectNone} className="text-xs text-[var(--color-accent)] hover:underline">None</button>
                </div>
              </div>
              <div className="space-y-1">
                {files.map((f) => (
                  <label
                    key={f.name}
                    className="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-[var(--color-bg-primary)] cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      checked={selected[f.name] ?? false}
                      onChange={() => toggleFile(f.name)}
                      className="rounded"
                    />
                    <span className="text-xs font-mono text-[var(--color-text-primary)] flex-1">{f.name}</span>
                    <span className="text-[10px] text-[var(--color-text-secondary)]">
                      {f.size < 1024 ? `${f.size} B` : `${(f.size / 1024).toFixed(1)} KB`}
                    </span>
                  </label>
                ))}
              </div>
            </>
          )}

          {status !== 'loading' && files.length === 0 && (
            <div className="flex items-center justify-center py-8 text-sm text-[var(--color-text-secondary)]">
              No .cfg files found in this directory.
            </div>
          )}
        </div>

        {/* Status message */}
        {message && (
          <div className={`px-4 py-2 text-xs ${
            status === 'error' ? 'text-red-400' :
            status === 'success' ? 'text-green-400' :
            'text-[var(--color-text-secondary)]'
          }`}>
            {message}
          </div>
        )}

        {/* Footer */}
        <div className="p-4 border-t border-[var(--color-bg-tertiary)] flex items-center justify-between gap-4">
          <div className="space-y-2">
            <label className="flex items-center gap-2 text-xs text-[var(--color-text-secondary)] cursor-pointer">
              <input
                type="checkbox"
                checked={clearExisting}
                onChange={(e) => setClearExisting(e.target.checked)}
                className="rounded"
              />
              Clear existing config
            </label>
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
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="px-4 py-1.5 rounded-md text-xs font-medium bg-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] hover:bg-[var(--color-bg-primary)] transition-colors"
            >
              {status === 'success' ? 'Done' : 'Cancel'}
            </button>
            {status !== 'success' && (
              <button
                onClick={handleImport}
                disabled={status === 'importing' || selectedCount === 0}
                className="px-4 py-1.5 rounded-md text-xs font-medium bg-[var(--color-accent)] text-[var(--color-bg-primary)] hover:opacity-90 transition-colors disabled:opacity-50"
              >
                {status === 'importing' ? 'Reading...' : `Open ${selectedCount} File${selectedCount !== 1 ? 's' : ''}`}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
