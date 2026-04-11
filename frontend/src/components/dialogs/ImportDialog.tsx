import { useState, useRef, useCallback } from 'react';
import { useConfigStore } from '../../stores/configStore';
import { useGraphStore } from '../../stores/graphStore';
import * as api from '../../services/api';
import { buildProjectGraph } from '../../utils/graphBuilder';
import type { ConfigFile } from '../../types/config';

interface ImportDialogProps {
  onClose: () => void;
}

interface ImportResult {
  filename: string;
  sections: number;
  errors: number;
  boardName: string;
  isMainFile: boolean;
  mcuNames: string[];
}

interface ProjectSummary {
  mainFile: string;
  mcus: Array<{ name: string; file: string }>;
  resolvedIncludes: number;
  unresolvedIncludes: string[];
}

export default function ImportDialog({ onClose }: ImportDialogProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [status, setStatus] = useState<'idle' | 'loading' | 'selecting' | 'success' | 'error'>('idle');
  const [message, setMessage] = useState('');
  const [results, setResults] = useState<ImportResult[]>([]);
  const [projectSummary, setProjectSummary] = useState<ProjectSummary | null>(null);
  const [clearExisting, setClearExisting] = useState(true);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  // File selection state — for folder imports, let user deselect files
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [fileSelection, setFileSelection] = useState<Record<string, boolean>>({});

  const { setConfigFile, setValidation } = useConfigStore();

  const doImport = useCallback(async (files: File[]) => {
    setStatus('loading');
    setResults([]);
    setProjectSummary(null);
    setMessage(`Importing ${files.length} config file${files.length > 1 ? 's' : ''}...`);

    try {
      // Ensure schemas are loaded
      let schemas = useConfigStore.getState().schemas;
      if (Object.keys(schemas).length === 0) {
        try {
          const schemaResult = await api.getSchema();
          useConfigStore.getState().setSchemas(schemaResult.schemas);
          schemas = schemaResult.schemas;
        } catch { /* proceed without schemas */ }
      }

      // Clear existing data if requested
      if (clearExisting) {
        useConfigStore.getState().clearAll();
        useGraphStore.getState().clearGraph();
      }

      // Use project-level import for all cases (single or multi-file)
      const projectResult = await api.importProject(files);

      // Store all parsed configs in configStore
      const allConfigs: Record<string, ConfigFile> = {};
      const importResults: ImportResult[] = [];

      for (const [filename, fileResult] of Object.entries(projectResult.files)) {
        setConfigFile(filename, fileResult.config);
        setValidation(filename, fileResult.validation);
        allConfigs[filename] = fileResult.config;

        // Find MCU names in this file
        const mcuNames = projectResult.project.mcus
          .filter((m) => m.file === filename)
          .map((m) => m.name || '(primary)');

        importResults.push({
          filename,
          sections: fileResult.config.sections.length,
          errors: fileResult.validation.errors.filter((e) => e.severity === 'error').length,
          boardName: fileResult.board_info?.board_name || '',
          isMainFile: filename === projectResult.project.main_file,
          mcuNames,
        });
      }

      // Build unified project graph from all configs at once
      const graphStore = useGraphStore.getState();
      const allValidations: Record<string, import('../../types/config').ValidationResult> = {};
      for (const [filename, fileResult] of Object.entries(projectResult.files)) {
        allValidations[filename] = fileResult.validation;
      }
      buildProjectGraph(allConfigs, graphStore, schemas, allValidations);

      // Sort results: main file first, then alphabetical
      importResults.sort((a, b) => {
        if (a.isMainFile) return -1;
        if (b.isMainFile) return 1;
        return a.filename.localeCompare(b.filename);
      });

      setResults(importResults);

      // Build project summary
      const unresolvedIncludes = projectResult.project.includes
        .filter((inc) => !inc.resolved)
        .map((inc) => inc.path);

      setProjectSummary({
        mainFile: projectResult.project.main_file,
        mcus: projectResult.project.mcus,
        resolvedIncludes: projectResult.project.includes.filter((i) => i.resolved).length,
        unresolvedIncludes,
      });

      const totalSections = importResults.reduce((sum, r) => sum + r.sections, 0);
      const mcuCount = projectResult.project.mcus.length;
      setStatus('success');
      setMessage(
        `Imported ${importResults.length} file${importResults.length > 1 ? 's' : ''} ` +
        `with ${totalSections} sections and ${mcuCount} MCU${mcuCount !== 1 ? 's' : ''}`,
      );
    } catch (err) {
      setStatus('error');
      setMessage(err instanceof Error ? err.message : 'Import failed');
    }
  }, [setConfigFile, setValidation, clearExisting]);

  const handleFiles = useCallback(async (files: File[], isFolder: boolean) => {
    // Filter to only .cfg files
    const cfgFiles = files.filter((f) => f.name.endsWith('.cfg'));
    if (cfgFiles.length === 0) {
      setStatus('error');
      setMessage('No .cfg files found. Only Klipper .cfg files can be imported.');
      return;
    }

    // For folder imports with multiple files, show selection UI first
    if (isFolder && cfgFiles.length > 1) {
      setPendingFiles(cfgFiles);
      const sel: Record<string, boolean> = {};
      for (const f of cfgFiles) {
        // Auto-deselect known non-klipper config files
        const name = f.name.toLowerCase();
        const skip = name === 'moonraker.conf' || name === 'crowsnest.conf' ||
                     name === 'klipperscreen.conf' || name === 'sonar.conf' ||
                     name === 'webcam.txt' || name.endsWith('.bak') ||
                     name.endsWith('.old');
        sel[f.name] = !skip;
      }
      setFileSelection(sel);
      setStatus('selecting');
      setMessage(`Found ${cfgFiles.length} .cfg files. Deselect any you don't want to import.`);
      return;
    }

    doImport(cfgFiles);
  }, [doImport]);

  const handleConfirmSelection = useCallback(() => {
    const selectedFiles = pendingFiles.filter((f) => fileSelection[f.name] !== false);
    if (selectedFiles.length === 0) {
      setStatus('error');
      setMessage('No files selected for import.');
      return;
    }
    doImport(selectedFiles);
  }, [pendingFiles, fileSelection, doImport]);

  const toggleFile = useCallback((filename: string) => {
    setFileSelection((prev) => ({ ...prev, [filename]: !prev[filename] }));
  }, []);

  const selectAll = useCallback(() => {
    setFileSelection((prev) => {
      const next = { ...prev };
      for (const k of Object.keys(next)) next[k] = true;
      return next;
    });
  }, []);

  const selectNone = useCallback(() => {
    setFileSelection((prev) => {
      const next = { ...prev };
      for (const k of Object.keys(next)) next[k] = false;
      return next;
    });
  }, []);

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);

      // Try to get files from items (supports folder drops in some browsers)
      const items = Array.from(e.dataTransfer.items);
      const allFiles: File[] = [];
      let isFolder = false;

      // Check if any entries are directories
      const hasDirectorySupport = items.some(
        (item) => 'webkitGetAsEntry' in item && item.webkitGetAsEntry()?.isDirectory,
      );

      if (hasDirectorySupport) {
        isFolder = true;
        // Read directory entries recursively
        for (const item of items) {
          const entry = item.webkitGetAsEntry?.();
          if (entry) {
            const files = await readEntryFiles(entry);
            allFiles.push(...files);
          }
        }
      } else {
        // Fall back to regular file list
        allFiles.push(...Array.from(e.dataTransfer.files));
      }

      if (allFiles.length > 0) {
        handleFiles(allFiles, isFolder);
      } else {
        setStatus('error');
        setMessage('No files found. Drop .cfg files or a config folder.');
      }
    },
    [handleFiles],
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="bg-[var(--color-bg-secondary)] rounded-xl border border-[var(--color-bg-tertiary)] shadow-2xl w-[520px] overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-4 border-b border-[var(--color-bg-tertiary)]">
          <h2 className="text-sm font-semibold">Import Klipper Configuration</h2>
          <button onClick={onClose} className="text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]">
            ✕
          </button>
        </div>

        <div className="p-6">
          {/* Clear existing toggle */}
          <label className="flex items-center gap-2 mb-4 cursor-pointer">
            <input
              type="checkbox"
              checked={clearExisting}
              onChange={(e) => setClearExisting(e.target.checked)}
              className="rounded border-[var(--color-bg-tertiary)]"
            />
            <span className="text-xs text-[var(--color-text-secondary)]">
              Clear existing project before importing
            </span>
          </label>

          {/* Drop zone */}
          <div
            onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={handleDrop}
            className={`border-2 border-dashed rounded-xl p-8 text-center transition-colors ${
              isDragging
                ? 'border-[var(--color-accent)] bg-[var(--color-accent)]/10'
                : 'border-[var(--color-bg-tertiary)] hover:border-[var(--color-accent)]'
            }`}
          >
            <svg width="40" height="40" viewBox="0 0 40 40" fill="none" className="mx-auto mb-3 text-[var(--color-text-secondary)]">
              <path d="M20 5v20M12 17l8 8 8-8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              <path d="M5 25v8a2 2 0 002 2h26a2 2 0 002-2v-8" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
            </svg>
            <p className="text-sm text-[var(--color-text-secondary)] mb-2">
              Drop config files or folder here
            </p>
            <p className="text-[10px] text-[var(--color-text-secondary)] opacity-60 mb-3">
              Import your entire Klipper config directory — printer.cfg + all included .cfg files
            </p>

            {/* Action buttons */}
            <div className="flex items-center justify-center gap-2">
              <button
                onClick={(e) => { e.stopPropagation(); fileInputRef.current?.click(); }}
                className="px-3 py-1.5 rounded-lg text-xs font-medium bg-[var(--color-accent)] text-white hover:opacity-90 transition-opacity"
              >
                Select Files
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); folderInputRef.current?.click(); }}
                className="px-3 py-1.5 rounded-lg text-xs font-medium bg-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] hover:bg-[var(--color-bg-primary)] transition-colors"
              >
                Select Folder
              </button>
            </div>
          </div>

          {/* Hidden file inputs */}
          <input
            ref={fileInputRef}
            type="file"
            accept=".cfg"
            multiple
            className="hidden"
            onChange={(e) => {
              const files = Array.from(e.target.files || []);
              if (files.length > 0) handleFiles(files, false);
              e.target.value = '';
            }}
          />
          <input
            ref={folderInputRef}
            type="file"
            // @ts-expect-error webkitdirectory is a non-standard but widely supported attribute
            webkitdirectory="true"
            className="hidden"
            onChange={(e) => {
              const files = Array.from(e.target.files || []);
              if (files.length > 0) handleFiles(files, true);
              e.target.value = '';
            }}
          />

          {/* File selection UI — shown when importing a folder */}
          {status === 'selecting' && pendingFiles.length > 0 && (
            <div className="mt-4">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-semibold text-[var(--color-text-secondary)] uppercase tracking-wider">
                  Select files to import
                </span>
                <div className="flex gap-2">
                  <button onClick={selectAll} className="text-[10px] text-[var(--color-accent)] hover:underline">All</button>
                  <button onClick={selectNone} className="text-[10px] text-[var(--color-accent)] hover:underline">None</button>
                </div>
              </div>
              <div className="max-h-52 overflow-y-auto space-y-0.5 border border-[var(--color-bg-tertiary)] rounded-lg p-2">
                {pendingFiles.map((f) => {
                  const checked = fileSelection[f.name] !== false;
                  return (
                    <label
                      key={f.name}
                      className={`flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer text-xs transition-colors ${
                        checked ? 'hover:bg-[var(--color-bg-primary)]' : 'opacity-50 hover:bg-[var(--color-bg-primary)]'
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleFile(f.name)}
                        className="rounded border-[var(--color-bg-tertiary)]"
                      />
                      <span className={`font-mono ${checked ? 'text-[var(--color-text-primary)]' : 'text-[var(--color-text-secondary)] line-through'}`}>
                        {f.name}
                      </span>
                    </label>
                  );
                })}
              </div>
              <div className="flex justify-end mt-3">
                <button
                  onClick={handleConfirmSelection}
                  className="px-4 py-2 rounded-lg text-xs font-medium bg-[var(--color-accent)] text-white hover:opacity-90 transition-opacity"
                >
                  Import {Object.values(fileSelection).filter(Boolean).length} Files
                </button>
              </div>
            </div>
          )}

          {/* Status */}
          {status !== 'idle' && (
            <div className={`mt-4 p-3 rounded-lg text-xs ${
              status === 'loading' ? 'bg-[var(--color-accent)]/10 text-[var(--color-accent)]' :
              status === 'success' ? 'bg-[var(--color-success)]/10 text-[var(--color-success)]' :
              'bg-[var(--color-error)]/10 text-[var(--color-error)]'
            }`}>
              {message}
            </div>
          )}

          {/* Project summary */}
          {projectSummary && (
            <div className="mt-3 p-3 rounded-lg bg-[var(--color-bg-primary)] border border-[var(--color-bg-tertiary)]">
              <div className="text-[10px] font-semibold text-[var(--color-text-secondary)] uppercase tracking-wider mb-2">
                Project Structure
              </div>
              <div className="space-y-1 text-xs">
                <div className="flex items-center gap-2">
                  <span className="text-[var(--color-text-secondary)]">Main file:</span>
                  <span className="font-mono text-[var(--color-text-primary)]">{projectSummary.mainFile.replace(/^.*[\\/]/, '')}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[var(--color-text-secondary)]">MCUs:</span>
                  <span className="text-[var(--color-text-primary)]">
                    {projectSummary.mcus.map((m) => m.name || 'primary').join(', ')}
                  </span>
                </div>
                {projectSummary.resolvedIncludes > 0 && (
                  <div className="flex items-center gap-2">
                    <span className="text-[var(--color-text-secondary)]">Resolved includes:</span>
                    <span className="text-[var(--color-success)]">{projectSummary.resolvedIncludes}</span>
                  </div>
                )}
                {projectSummary.unresolvedIncludes.length > 0 && (
                  <div>
                    <span className="text-[var(--color-text-secondary)]">Missing includes: </span>
                    <span className="text-[var(--color-error)] font-mono">
                      {projectSummary.unresolvedIncludes.join(', ')}
                    </span>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Import results list */}
          {results.length > 0 && (
            <div className="mt-3 space-y-1 max-h-48 overflow-y-auto">
              {results.map((r) => (
                <div key={r.filename} className="flex items-center justify-between p-2 rounded-lg bg-[var(--color-bg-primary)] text-xs">
                  <div className="flex items-center gap-2 min-w-0">
                    {r.isMainFile && (
                      <span className="text-[9px] px-1 py-0.5 rounded bg-[var(--color-accent)]/20 text-[var(--color-accent)] font-semibold shrink-0">
                        MAIN
                      </span>
                    )}
                    <span className="text-[var(--color-text-primary)] font-mono truncate">{r.filename}</span>
                    <span className="text-[var(--color-text-secondary)] shrink-0">
                      {r.sections} sections
                    </span>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {r.mcuNames.length > 0 && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)]">
                        MCU: {r.mcuNames.join(', ')}
                      </span>
                    )}
                    {r.boardName && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)]">
                        {r.boardName}
                      </span>
                    )}
                    {r.errors > 0 && (
                      <span className="text-[10px] text-[var(--color-error)]">
                        {r.errors} errors
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 p-4 border-t border-[var(--color-bg-tertiary)]">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg text-xs font-medium bg-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] hover:bg-[var(--color-bg-primary)] transition-colors"
          >
            {status === 'success' ? 'Done' : 'Cancel'}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Recursively read all files from a FileSystemEntry (for folder drag-drop support).
 */
async function readEntryFiles(entry: FileSystemEntry): Promise<File[]> {
  if (entry.isFile) {
    return new Promise((resolve) => {
      (entry as FileSystemFileEntry).file(
        (file) => resolve([file]),
        () => resolve([]),
      );
    });
  }
  if (entry.isDirectory) {
    const dirReader = (entry as FileSystemDirectoryEntry).createReader();
    const entries = await new Promise<FileSystemEntry[]>((resolve) => {
      dirReader.readEntries(
        (results) => resolve(results),
        () => resolve([]),
      );
    });
    const files: File[] = [];
    for (const childEntry of entries) {
      const childFiles = await readEntryFiles(childEntry);
      files.push(...childFiles);
    }
    return files;
  }
  return [];
}
