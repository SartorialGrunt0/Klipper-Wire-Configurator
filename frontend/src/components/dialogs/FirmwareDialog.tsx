import { useEffect, useState } from 'react';
import * as api from '../../services/api';
import type {
  NativeFirmwareArtifact,
  NativeFirmwareBuildResult,
  NativeFirmwareField,
  NativeFirmwareState,
} from '../../services/api';

interface FirmwareDialogProps {
  onClose: () => void;
}

type DialogStatus = 'idle' | 'loading' | 'saving' | 'building';
type MessageTone = 'info' | 'success' | 'error';

function cloneFields(fields: NativeFirmwareField[]): NativeFirmwareField[] {
  return fields.map((field) => ({
    ...field,
    menu_path: [...field.menu_path],
    assignable: [...field.assignable],
    options: field.options?.map((option) => ({ ...option })),
  }));
}

function buildAssignments(fields: NativeFirmwareField[]): Array<{ symbol: string; value: string }> {
  const assignments: Array<{ symbol: string; value: string }> = [];
  for (const field of fields) {
    if (field.kind === 'choice') {
      if (field.value) {
        assignments.push({ symbol: field.value, value: 'y' });
      }
      continue;
    }
    if (field.symbol) {
      assignments.push({ symbol: field.symbol, value: field.value });
    }
  }
  return assignments;
}

function matchesQuery(field: NativeFirmwareField, query: string): boolean {
  if (!query) return true;
  const haystack = [
    field.prompt,
    field.symbol || '',
    field.help,
    field.menu_path.join(' '),
    field.options?.map((option) => `${option.prompt} ${option.symbol}`).join(' ') || '',
  ].join(' ').toLowerCase();
  return haystack.includes(query);
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(2)} MB`;
}

function formatModified(timestamp: number): string {
  return new Date(timestamp * 1000).toLocaleString();
}

export default function FirmwareDialog({ onClose }: FirmwareDialogProps) {
  const [status, setStatus] = useState<DialogStatus>('loading');
  const [message, setMessage] = useState('Loading Klipper firmware configuration...');
  const [messageTone, setMessageTone] = useState<MessageTone>('info');
  const [pathInput, setPathInput] = useState('');
  const [firmwareState, setFirmwareState] = useState<NativeFirmwareState | null>(null);
  const [fields, setFields] = useState<NativeFirmwareField[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [isDirty, setIsDirty] = useState(false);
  const [buildResult, setBuildResult] = useState<NativeFirmwareBuildResult | null>(null);

  async function loadState(overridePath?: string) {
    const requestedPath = overridePath?.trim();
    setStatus('loading');
    setMessage('Loading Klipper firmware configuration...');
    setMessageTone('info');
    try {
      const result = await api.getNativeFirmwareState(requestedPath || undefined);
      setFirmwareState(result);
      setFields(cloneFields(result.fields));
      setPathInput(result.klipper_path || requestedPath || '');
      setBuildResult(null);
      setIsDirty(false);
      setStatus('idle');
      if (!result.available) {
        setMessage(result.error || 'Klipper is not available on this SBC.');
        setMessageTone('error');
        return;
      }
      if (result.config_exists) {
        setMessage(`Loaded active Klipper build config from ${result.config_path}`);
      } else {
        setMessage(`No existing .config was found. Defaults from ${result.klipper_path} are ready to edit.`);
      }
      setMessageTone('info');
    } catch (err) {
      setStatus('idle');
      setMessage(err instanceof Error ? err.message : 'Failed to load Klipper firmware configuration.');
      setMessageTone('error');
    }
  }

  useEffect(() => {
    loadState();
  }, []);

  function updateFieldValue(fieldId: string, value: string) {
    setFields((prev) => prev.map((field) => {
      if (field.id !== fieldId) return field;
      if (field.kind === 'choice') {
        return {
          ...field,
          value,
          options: field.options?.map((option) => ({
            ...option,
            selected: option.symbol === value,
          })),
        };
      }
      return { ...field, value };
    }));
    setIsDirty(true);
  }

  async function persistConfig(showSuccessMessage: boolean): Promise<boolean> {
    if (!firmwareState?.available) {
      setMessage('Klipper is not available on this SBC.');
      setMessageTone('error');
      return false;
    }

    setStatus('saving');
    setMessage('Saving Klipper build configuration...');
    setMessageTone('info');
    try {
      const result = await api.updateNativeFirmwareConfig(buildAssignments(fields), pathInput.trim() || undefined);
      setFirmwareState(result);
      setFields(cloneFields(result.fields));
      setPathInput(result.klipper_path || pathInput);
      setIsDirty(false);
      setStatus('idle');
      if (!result.available) {
        setMessage(result.error || 'Klipper is not available on this SBC.');
        setMessageTone('error');
        return false;
      }
      if (result.error) {
        setMessage(result.error);
        setMessageTone('error');
        return false;
      }
      if (showSuccessMessage) {
        setMessage(`Saved Klipper build configuration to ${result.config_path}`);
        setMessageTone('success');
      }
      return true;
    } catch (err) {
      setStatus('idle');
      setMessage(err instanceof Error ? err.message : 'Failed to save Klipper build configuration.');
      setMessageTone('error');
      return false;
    }
  }

  async function handleBuild() {
    if (!firmwareState?.available) {
      setMessage('Klipper is not available on this SBC.');
      setMessageTone('error');
      return;
    }
    if (isDirty) {
      const saved = await persistConfig(false);
      if (!saved) return;
    }

    setStatus('building');
    setMessage('Running `make olddefconfig` and `make` in the active Klipper checkout...');
    setMessageTone('info');
    try {
      const result = await api.buildNativeFirmware(pathInput.trim() || undefined);
      setBuildResult(result);
      setStatus('idle');
      if (result.klipper_path) {
        setPathInput(result.klipper_path);
      }
      setFirmwareState((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          klipper_path: result.klipper_path || prev.klipper_path,
          out_path: result.out_path || prev.out_path,
          artifacts: result.artifacts,
          primary_artifact: result.primary_artifact,
        };
      });
      if (!result.success) {
        setMessage(result.error || 'Klipper firmware build failed.');
        setMessageTone('error');
        return;
      }
      setMessage(
        result.primary_artifact
          ? `Built ${result.primary_artifact.name} in ${result.out_path}`
          : `Build completed in ${result.out_path}`,
      );
      setMessageTone('success');
    } catch (err) {
      setStatus('idle');
      setMessage(err instanceof Error ? err.message : 'Failed to build Klipper firmware.');
      setMessageTone('error');
    }
  }

  async function handleDownload(artifact: NativeFirmwareArtifact) {
    try {
      setMessage(`Downloading ${artifact.name}...`);
      setMessageTone('info');
      const blob = await api.downloadNativeFirmwareArtifact(artifact.name, pathInput.trim() || undefined);
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = artifact.name;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);
      setMessage(`Downloaded ${artifact.name}`);
      setMessageTone('success');
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Failed to download firmware artifact.');
      setMessageTone('error');
    }
  }

  const normalizedQuery = searchQuery.trim().toLowerCase();
  const visibleFields = fields.filter((field) => matchesQuery(field, normalizedQuery));
  const groupedFields = new Map<string, NativeFirmwareField[]>();
  for (const field of visibleFields) {
    const groupName = field.menu_path.length > 0 ? field.menu_path.join(' / ') : 'General';
    const group = groupedFields.get(groupName);
    if (group) group.push(field);
    else groupedFields.set(groupName, [field]);
  }

  const artifacts = buildResult?.artifacts || firmwareState?.artifacts || [];
  const primaryArtifact = buildResult?.primary_artifact || firmwareState?.primary_artifact || null;
  const busy = status === 'loading' || status === 'saving' || status === 'building';

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="bg-[var(--color-bg-secondary)] rounded-xl shadow-2xl border border-[var(--color-bg-tertiary)] w-[1100px] max-w-[96vw] max-h-[90vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-4 border-b border-[var(--color-bg-tertiary)]">
          <div>
            <h2 className="text-base font-semibold text-[var(--color-text-primary)]">Klipper Firmware</h2>
            <p className="text-xs text-[var(--color-text-secondary)] mt-0.5">
              Edit the active Klipper build config, run the local build, and download the generated artifact.
            </p>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)]">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <div className="p-4 border-b border-[var(--color-bg-tertiary)] space-y-3">
          <div className="flex flex-col gap-2 lg:flex-row lg:items-end">
            <div className="flex-1 min-w-0">
              <label className="block text-xs font-medium text-[var(--color-text-secondary)] mb-1">
                Klipper Checkout
              </label>
              <input
                type="text"
                value={pathInput}
                onChange={(e) => setPathInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && loadState(pathInput)}
                placeholder="Auto-detect ~/klipper or enter another checkout path"
                className="w-full px-3 py-2 rounded-md border border-[var(--color-bg-tertiary)] bg-[var(--color-bg-primary)] text-xs text-[var(--color-text-primary)] font-mono"
              />
            </div>
            <div className="flex gap-2 shrink-0">
              <button
                onClick={() => loadState(pathInput)}
                disabled={busy}
                className="px-4 py-2 rounded-md text-xs font-medium bg-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] hover:bg-[var(--color-bg-primary)] transition-colors disabled:opacity-50"
              >
                {status === 'loading' ? 'Loading...' : 'Load'}
              </button>
              <button
                onClick={() => persistConfig(true)}
                disabled={busy || !firmwareState?.available || !isDirty}
                className="px-4 py-2 rounded-md text-xs font-medium bg-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] hover:bg-[var(--color-accent)] hover:text-[var(--color-bg-primary)] transition-colors disabled:opacity-50"
              >
                {status === 'saving' ? 'Saving...' : 'Save .config'}
              </button>
              <button
                onClick={handleBuild}
                disabled={busy || !firmwareState?.available}
                className="px-4 py-2 rounded-md text-xs font-medium bg-amber-500 text-black hover:bg-amber-600 transition-colors disabled:opacity-50"
              >
                {status === 'building' ? 'Building...' : 'Build Firmware'}
              </button>
            </div>
          </div>

          <div className="rounded-lg border border-[var(--color-bg-tertiary)] bg-[var(--color-bg-primary)]/60 px-3 py-2">
            <p className="text-xs text-[var(--color-text-secondary)]">
              This frontend writes Klipper&apos;s active <span className="font-mono">.config</span>, then runs <span className="font-mono">make olddefconfig</span> and <span className="font-mono">make</span> inside the selected checkout. The built firmware stays on the SBC under the Klipper <span className="font-mono">out/</span> directory and can also be downloaded here.
            </p>
          </div>
        </div>

        <div className="flex flex-1 min-h-0 flex-col lg:flex-row">
          <div className="lg:w-[58%] lg:border-r border-[var(--color-bg-tertiary)] flex flex-col min-h-0">
            <div className="p-4 border-b border-[var(--color-bg-tertiary)]">
              <label className="block text-xs font-medium text-[var(--color-text-secondary)] mb-1">
                Search Build Options
              </label>
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search by prompt, symbol, help text, or menu path"
                className="w-full px-3 py-2 rounded-md border border-[var(--color-bg-tertiary)] bg-[var(--color-bg-primary)] text-xs text-[var(--color-text-primary)]"
              />
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              {firmwareState && !firmwareState.available && (
                <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-4">
                  <p className="text-sm text-red-300">
                    {firmwareState?.error || 'Klipper was not detected on this SBC.'}
                  </p>
                </div>
              )}

              {firmwareState?.available && !firmwareState.config_exists && (
                <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-4">
                  <p className="text-sm text-amber-200">
                    No existing Klipper <span className="font-mono">.config</span> file was found. Saving or building will generate one from the selected options.
                  </p>
                </div>
              )}

              {firmwareState?.available && groupedFields.size === 0 && (
                <div className="rounded-lg border border-[var(--color-bg-tertiary)] p-4 text-sm text-[var(--color-text-secondary)]">
                  No build options match the current search.
                </div>
              )}

              {Array.from(groupedFields.entries()).map(([groupName, groupFields]) => (
                <section key={groupName} className="rounded-xl border border-[var(--color-bg-tertiary)] overflow-hidden">
                  <div className="px-4 py-3 bg-[var(--color-bg-primary)]/70 border-b border-[var(--color-bg-tertiary)]">
                    <h3 className="text-sm font-semibold text-[var(--color-text-primary)]">{groupName}</h3>
                  </div>
                  <div className="divide-y divide-[var(--color-bg-tertiary)]">
                    {groupFields.map((field) => (
                      <div key={field.id} className="px-4 py-3 space-y-2">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="text-sm font-medium text-[var(--color-text-primary)]">{field.prompt}</p>
                            <p className="text-[10px] font-mono text-[var(--color-text-secondary)] mt-1">
                              {field.kind === 'choice'
                                ? `choice: ${field.value || 'unselected'}`
                                : field.symbol || 'anonymous option'}
                            </p>
                          </div>

                          {field.kind === 'bool' && field.assignable.every((value) => value === 'n' || value === 'y') ? (
                            <label className="inline-flex items-center gap-2 text-xs text-[var(--color-text-secondary)] shrink-0 cursor-pointer">
                              <input
                                type="checkbox"
                                checked={field.value === 'y'}
                                onChange={(e) => updateFieldValue(field.id, e.target.checked ? 'y' : 'n')}
                                className="rounded"
                              />
                              {field.value === 'y' ? 'Enabled' : 'Disabled'}
                            </label>
                          ) : field.kind === 'choice' ? (
                            <select
                              value={field.value}
                              onChange={(e) => updateFieldValue(field.id, e.target.value)}
                              className="w-56 px-2 py-1.5 rounded-md border border-[var(--color-bg-tertiary)] bg-[var(--color-bg-primary)] text-xs text-[var(--color-text-primary)] shrink-0"
                            >
                              <option value="">Select an option</option>
                              {(field.options || []).map((option) => (
                                <option key={option.symbol} value={option.symbol}>
                                  {option.prompt}
                                </option>
                              ))}
                            </select>
                          ) : field.kind === 'tristate' ? (
                            <select
                              value={field.value}
                              onChange={(e) => updateFieldValue(field.id, e.target.value)}
                              className="w-32 px-2 py-1.5 rounded-md border border-[var(--color-bg-tertiary)] bg-[var(--color-bg-primary)] text-xs text-[var(--color-text-primary)] shrink-0"
                            >
                              {field.assignable.map((value) => (
                                <option key={value} value={value}>{value}</option>
                              ))}
                            </select>
                          ) : (
                            <input
                              type="text"
                              value={field.value}
                              onChange={(e) => updateFieldValue(field.id, e.target.value)}
                              className="w-56 px-2 py-1.5 rounded-md border border-[var(--color-bg-tertiary)] bg-[var(--color-bg-primary)] text-xs text-[var(--color-text-primary)] font-mono shrink-0"
                            />
                          )}
                        </div>

                        {field.kind === 'choice' && field.options && field.options.length > 0 && (
                          <div className="flex flex-wrap gap-2">
                            {field.options.map((option) => (
                              <button
                                key={option.symbol}
                                type="button"
                                onClick={() => updateFieldValue(field.id, option.symbol)}
                                className={`px-2.5 py-1 rounded-md text-[11px] transition-colors ${
                                  field.value === option.symbol
                                    ? 'bg-[var(--color-accent)] text-[var(--color-bg-primary)]'
                                    : 'bg-[var(--color-bg-primary)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'
                                }`}
                              >
                                {option.prompt}
                              </button>
                            ))}
                          </div>
                        )}

                        {field.help && (
                          <p className="text-xs leading-5 text-[var(--color-text-secondary)] whitespace-pre-wrap">
                            {field.help}
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          </div>

          <div className="flex-1 min-h-0 flex flex-col">
            <div className="p-4 border-b border-[var(--color-bg-tertiary)] grid gap-3 md:grid-cols-2">
              <div className="rounded-lg border border-[var(--color-bg-tertiary)] bg-[var(--color-bg-primary)]/60 p-3">
                <p className="text-[11px] uppercase tracking-[0.12em] text-[var(--color-text-secondary)] mb-1">Config File</p>
                <p className="text-xs font-mono break-all text-[var(--color-text-primary)]">
                  {firmwareState?.config_path || 'Unavailable'}
                </p>
              </div>
              <div className="rounded-lg border border-[var(--color-bg-tertiary)] bg-[var(--color-bg-primary)]/60 p-3">
                <p className="text-[11px] uppercase tracking-[0.12em] text-[var(--color-text-secondary)] mb-1">Output Directory</p>
                <p className="text-xs font-mono break-all text-[var(--color-text-primary)]">
                  {buildResult?.out_path || firmwareState?.out_path || 'Unavailable'}
                </p>
              </div>
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
              <section className="rounded-xl border border-[var(--color-bg-tertiary)] overflow-hidden">
                <div className="px-4 py-3 border-b border-[var(--color-bg-tertiary)] bg-[var(--color-bg-primary)]/70">
                  <h3 className="text-sm font-semibold text-[var(--color-text-primary)]">Artifacts</h3>
                  <p className="text-xs text-[var(--color-text-secondary)] mt-1">
                    Builds stay on the SBC in Klipper&apos;s <span className="font-mono">out/</span> directory. Download any generated artifact directly from here.
                  </p>
                </div>
                <div className="p-4 space-y-3">
                  {primaryArtifact && (
                    <div className="rounded-lg border border-green-500/30 bg-green-500/10 p-3">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="text-sm font-semibold text-green-300">Primary Artifact</p>
                          <p className="text-xs font-mono text-green-100 mt-1">{primaryArtifact.name}</p>
                          <p className="text-[11px] text-green-200/80 mt-1">
                            {formatBytes(primaryArtifact.size)} • {formatModified(primaryArtifact.modified)}
                          </p>
                        </div>
                        <button
                          onClick={() => handleDownload(primaryArtifact)}
                          className="px-3 py-1.5 rounded-md text-xs font-medium bg-green-500 text-black hover:bg-green-400 transition-colors"
                        >
                          Download
                        </button>
                      </div>
                    </div>
                  )}

                  {artifacts.length === 0 && (
                    <p className="text-sm text-[var(--color-text-secondary)]">
                      No firmware artifacts found yet.
                    </p>
                  )}

                  {artifacts.length > 0 && (
                    <div className="space-y-2">
                      {artifacts.map((artifact) => (
                        <div
                          key={artifact.name}
                          className="flex items-center justify-between gap-3 px-3 py-2 rounded-lg border border-[var(--color-bg-tertiary)] bg-[var(--color-bg-primary)]/50"
                        >
                          <div className="min-w-0">
                            <p className="text-sm font-medium text-[var(--color-text-primary)] truncate">{artifact.name}</p>
                            <p className="text-[11px] text-[var(--color-text-secondary)] mt-1">
                              {formatBytes(artifact.size)} • {formatModified(artifact.modified)}
                            </p>
                          </div>
                          <button
                            onClick={() => handleDownload(artifact)}
                            className="px-3 py-1.5 rounded-md text-xs font-medium bg-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] hover:bg-[var(--color-accent)] hover:text-[var(--color-bg-primary)] transition-colors"
                          >
                            Download
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </section>

              <section className="rounded-xl border border-[var(--color-bg-tertiary)] overflow-hidden flex flex-col min-h-[320px]">
                <div className="px-4 py-3 border-b border-[var(--color-bg-tertiary)] bg-[var(--color-bg-primary)]/70">
                  <h3 className="text-sm font-semibold text-[var(--color-text-primary)]">Build Log</h3>
                  <p className="text-xs text-[var(--color-text-secondary)] mt-1">
                    The latest build output from <span className="font-mono">make olddefconfig</span> and <span className="font-mono">make</span>.
                  </p>
                </div>
                <div className="flex-1 bg-black/30 p-4 overflow-auto">
                  <pre className="text-[11px] leading-5 whitespace-pre-wrap break-words text-[var(--color-text-primary)] font-mono">
                    {buildResult?.log || 'No build has been run in this session yet.'}
                  </pre>
                </div>
              </section>
            </div>
          </div>
        </div>

        <div className="px-4 py-3 border-t border-[var(--color-bg-tertiary)] flex items-center justify-between gap-3">
          <p className={`text-xs ${
            messageTone === 'error'
              ? 'text-red-400'
              : messageTone === 'success'
                ? 'text-green-400'
                : 'text-[var(--color-text-secondary)]'
          }`}>
            {message}
          </p>
          <button
            onClick={onClose}
            className="px-4 py-1.5 rounded-md text-xs font-medium bg-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] hover:bg-[var(--color-bg-primary)] transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}