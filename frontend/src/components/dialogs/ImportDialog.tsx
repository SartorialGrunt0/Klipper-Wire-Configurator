import { useState, useRef, useCallback } from 'react';
import JSZip from 'jszip';
import { useConfigStore } from '../../stores/configStore';
import { useGraphStore } from '../../stores/graphStore';
import * as api from '../../services/api';
import { buildProjectGraph } from '../../utils/graphBuilder';
import { buildInitialSelection, findOverlappingFiles } from '../../utils/importSelection';
import type { ConfigFile } from '../../types/config';

interface ImportDialogProps {
  onClose: () => void;
}

interface ImportResult {
  filename: string;
  sections: number;
  errors: number;
  warnings: number;
  errorDetails: Array<{ severity: string; section: string; param: string; message: string }>;
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
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  // File selection state — staged file list lets user deselect before import
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [fileSelection, setFileSelection] = useState<Record<string, boolean>>({});

  // Files awaiting overwrite confirmation (name collision with loaded project)
  const [overwriteConfirm, setOverwriteConfirm] = useState<{
    files: File[];
    overlaps: string[];
  } | null>(null);

  const [expandedFile, setExpandedFile] = useState<string | null>(null);
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

      // Import NEVER clears the existing project. Imported files merge into
      // whatever is already loaded; name collisions were confirmed above.
      // Use project-level import for all cases (single or multi-file)
      const projectResult = await api.importProject(files);

      // Store all parsed configs in configStore
      // Seed with existing configs so the rebuilt graph shows old + new files
      const allConfigs: Record<string, ConfigFile> = {
        ...useConfigStore.getState().configFiles,
      };
      const importResults: ImportResult[] = [];

      for (const [filename, fileResult] of Object.entries(projectResult.files)) {
        setConfigFile(filename, fileResult.config);
        setValidation(filename, fileResult.validation);
        allConfigs[filename] = fileResult.config;

        // NOTE: do NOT set originalText here. Import stages files into the
        // session as unsaved changes; the diff baseline must remain whatever
        // was loaded from the Pi (Open from Pi), so Save shows import-vs-Pi.
        // New files keep no original → they render as "new file" in Save.

        // Find MCU names in this file
        const mcuNames = projectResult.project.mcus
          .filter((m) => m.file === filename)
          .map((m) => m.name || '(primary)');

        const fileErrors = fileResult.validation.errors.filter((e) => e.severity === 'error');
        const fileWarnings = fileResult.validation.errors.filter((e) => e.severity === 'warning');
        importResults.push({
          filename,
          sections: fileResult.config.sections.length,
          errors: fileErrors.length,
          warnings: fileWarnings.length,
          errorDetails: fileResult.validation.errors.map((e) => ({
            severity: e.severity,
            section: e.section,
            param: e.param,
            message: e.message,
          })),
          boardName: fileResult.board_info?.board_name || '',
          isMainFile: filename === projectResult.project.main_file,
          mcuNames,
        });
      }

      // Import stages files as unsaved changes (originalTexts is left as the
      // Pi-loaded baseline so Save diffs import-vs-Pi). Flip the dirty flag so
      // the Save button lights up.
      useConfigStore.getState().markDirty();

      // Build unified project graph from all configs at once (existing + new).
      // buildProjectGraph is additive — clear the graph first or every node
      // from the previous build duplicates.
      const graphStore = useGraphStore.getState();
      graphStore.clearGraph();
      const allValidations: Record<string, import('../../types/config').ValidationResult> = {
        ...useConfigStore.getState().validation,
      };
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
  }, [setConfigFile, setValidation]);

  const handleFiles = useCallback(async (files: File[], isFolder: boolean) => {
    // Split picks into direct .cfg files and .zip archives
    const cfgFiles: File[] = [];
    const zipFiles: File[] = [];
    for (const f of files) {
      if (f.name.endsWith('.zip')) zipFiles.push(f);
      else if (f.name.endsWith('.cfg')) cfgFiles.push(f);
    }

    // Extract .cfg entries from any zip archives (flatten paths — the
    // backend strips path prefixes anyway, e.g. config/printer.cfg → printer.cfg)
    for (const zipFile of zipFiles) {
      try {
        const zip = await JSZip.loadAsync(zipFile);
        const cfgEntries = Object.values(zip.files).filter(
          (e) => !e.dir && e.name.endsWith('.cfg'),
        );
        for (const entry of cfgEntries) {
          const blob = await entry.async('blob');
          const basename = entry.name.split('/').pop() ?? entry.name;
          cfgFiles.push(new File([blob], basename, { type: 'text/plain' }));
        }
      } catch {
        // Unreadable/corrupt zip — fall through; if no .cfg files survive,
        // the no-cfg error below surfaces it.
      }
    }

    if (cfgFiles.length === 0) {
      setStatus('error');
      setMessage('No .cfg files found. Only Klipper .cfg files (or a .zip archive containing them) can be imported.');
      return;
    }

    // Always show the staged file list with per-file checkboxes (checked by
    // default) so the user can deselect before importing — for single files,
    // multi-file picks, drag-drop, and folders alike.
    setOverwriteConfirm(null);
    setPendingFiles(cfgFiles);
    setFileSelection(buildInitialSelection(cfgFiles.map((f) => f.name)));
    setStatus('selecting');
    setMessage(`Found ${cfgFiles.length} .cfg file${cfgFiles.length > 1 ? 's' : ''}. Deselect any you don't want to import.`);
  }, []);

  const handleConfirmSelection = useCallback(() => {
    const selectedFiles = pendingFiles.filter((f) => fileSelection[f.name] !== false);
    if (selectedFiles.length === 0) {
      setStatus('error');
      setMessage('No files selected for import.');
      return;
    }

    // If any selected file already exists in the loaded project, require an
    // explicit overwrite confirmation listing exactly which files collide.
    const overlaps = findOverlappingFiles(
      fileSelection,
      Object.keys(useConfigStore.getState().configFiles),
    );
    if (overlaps.length > 0) {
      setOverwriteConfirm({ files: selectedFiles, overlaps });
      return;
    }

    doImport(selectedFiles);
  }, [pendingFiles, fileSelection, doImport]);

  const confirmOverwrite = useCallback(() => {
    if (!overwriteConfirm) return;
    const { files } = overwriteConfirm;
    setOverwriteConfirm(null);
    doImport(files);
  }, [overwriteConfirm, doImport]);

  const cancelOverwrite = useCallback(() => {
    setOverwriteConfirm(null);
  }, []);

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
        setMessage('No files found. Drop .cfg files, a config folder, or a .zip archive.');
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
              Drop config files, a folder, or a .zip archive here
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
            accept=".cfg,.zip"
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

          {/* File selection UI — shown for every import so files can be deselected */}
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
              {/* Overwrite confirmation — a selected file already exists in the project */}
              {overwriteConfirm && (
                <div className="mt-3 p-3 rounded-lg bg-amber-500/10 border border-amber-500/30">
                  <p className="text-xs text-amber-400 font-medium mb-1.5">
                    {overwriteConfirm.overlaps.length} file{overwriteConfirm.overlaps.length !== 1 ? 's' : ''} already exist in this project and will be overwritten:
                  </p>
                  <div className="max-h-24 overflow-y-auto space-y-0.5">
                    {overwriteConfirm.overlaps.map((name) => (
                      <div key={name} className="text-xs font-mono text-[var(--color-text-primary)]">
                        {name}
                      </div>
                    ))}
                  </div>
                  <p className="text-[10px] text-[var(--color-text-secondary)] mt-1.5 opacity-70">
                    This stages the imported files as unsaved changes — nothing is written to disk until you Save.
                  </p>
                </div>
              )}
              <div className="flex justify-end gap-2 mt-3">
                {overwriteConfirm ? (
                  <>
                    <button
                      onClick={cancelOverwrite}
                      className="px-4 py-2 rounded-lg text-xs font-medium bg-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] hover:bg-[var(--color-bg-primary)] transition-colors"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={confirmOverwrite}
                      className="px-4 py-2 rounded-lg text-xs font-medium bg-amber-500 text-white hover:bg-amber-600 transition-colors"
                    >
                      Overwrite {overwriteConfirm.overlaps.length} & Import
                    </button>
                  </>
                ) : (
                  <button
                    onClick={handleConfirmSelection}
                    className="px-4 py-2 rounded-lg text-xs font-medium bg-[var(--color-accent)] text-white hover:opacity-90 transition-opacity"
                  >
                    Import {Object.values(fileSelection).filter(Boolean).length} Files
                  </button>
                )}
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
                    <div className="flex items-start gap-1">
                      <span className="text-[var(--color-text-secondary)] shrink-0">Non-MCU files: </span>
                      <span className="text-[var(--color-text-secondary)] font-mono">
                        {projectSummary.unresolvedIncludes.join(', ')}
                      </span>
                    </div>
                    <p className="text-[10px] text-[var(--color-text-secondary)] mt-1 opacity-70">
                      These files are referenced by [include] directives in your config but were not found in the imported files. They may be macros or extras stored elsewhere on your printer.
                    </p>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Import results list */}
          {results.length > 0 && (
            <div className="mt-3 space-y-1 max-h-60 overflow-y-auto">
              {results.map((r) => (
                <div key={r.filename}>
                  <div
                    className={`flex items-center justify-between p-2 rounded-lg bg-[var(--color-bg-primary)] text-xs ${
                      r.errorDetails.length > 0 ? 'cursor-pointer hover:bg-[var(--color-bg-tertiary)]/50' : ''
                    }`}
                    onClick={() => r.errorDetails.length > 0 && setExpandedFile(expandedFile === r.filename ? null : r.filename)}
                  >
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
                        <span className="text-[10px] px-1 py-0.5 rounded bg-[var(--color-error)]/20 text-[var(--color-error)] font-medium">
                          {r.errors} error{r.errors > 1 ? 's' : ''}
                        </span>
                      )}
                      {r.warnings > 0 && (
                        <span className="text-[10px] px-1 py-0.5 rounded bg-[var(--color-warning)]/20 text-[var(--color-warning)] font-medium">
                          {r.warnings} warning{r.warnings > 1 ? 's' : ''}
                        </span>
                      )}
                    </div>
                  </div>
                  {/* Expanded error details */}
                  {expandedFile === r.filename && r.errorDetails.length > 0 && (
                    <div className="ml-2 mr-2 mb-1 p-2 rounded-b-lg bg-[var(--color-bg-primary)] border border-t-0 border-[var(--color-bg-tertiary)] space-y-1">
                      {r.errorDetails.map((err, i) => (
                        <div key={i} className="flex items-start gap-2 text-[10px]">
                          <span className={`shrink-0 px-1 py-0.5 rounded font-semibold uppercase ${
                            err.severity === 'error'
                              ? 'bg-[var(--color-error)]/20 text-[var(--color-error)]'
                              : err.severity === 'warning'
                              ? 'bg-[var(--color-warning)]/20 text-[var(--color-warning)]'
                              : 'bg-[var(--color-accent)]/20 text-[var(--color-accent)]'
                          }`}>
                            {err.severity}
                          </span>
                          <span className="text-[var(--color-text-secondary)] font-mono shrink-0">
                            [{err.section}]{err.param ? ` ${err.param}` : ''}
                          </span>
                          <span className="text-[var(--color-text-primary)]">{err.message}</span>
                        </div>
                      ))}
                    </div>
                  )}
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
