import { useEffect, useState } from 'react';
import * as api from '../../services/api';
import type {
  FlashTargetKey,
  NativeFlashArtifact,
  NativeFlashCommandResult,
  NativeFlashField,
  NativeFlashState,
} from '../../services/api';

interface FirmwareDialogProps {
  onClose: () => void;
}

type DialogStatus = 'idle' | 'loading' | 'previewing' | 'saving' | 'building' | 'flashing';
type MessageTone = 'info' | 'success' | 'error';

interface FlashPanelState {
  status: DialogStatus;
  message: string;
  messageTone: MessageTone;
  loaded: boolean;
  checkoutPath: string;
  flashDevice: string;
  flashState: NativeFlashState | null;
  fields: NativeFlashField[];
  knownFields: Record<string, NativeFlashField>;
  assignmentValues: Record<string, string>;
  isDirty: boolean;
  commandResult: NativeFlashCommandResult | null;
}

const TARGETS: FlashTargetKey[] = ['klipper', 'katapult'];

function cloneField(field: NativeFlashField): NativeFlashField {
  return {
    ...field,
    menu_path: [...field.menu_path],
    assignable: [...field.assignable],
    options: field.options?.map((option) => ({ ...option })),
  };
}

function cloneFields(fields: NativeFlashField[]): NativeFlashField[] {
  return fields.map(cloneField);
}

function fieldRecord(fields: NativeFlashField[]): Record<string, NativeFlashField> {
  const result: Record<string, NativeFlashField> = {};
  for (const field of fields) {
    result[field.id] = cloneField(field);
  }
  return result;
}

function fieldAssignments(fields: NativeFlashField[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const field of fields) {
    result[field.id] = field.value;
  }
  return result;
}

function buildAssignments(
  assignmentValues: Record<string, string>,
  knownFields: Record<string, NativeFlashField>,
): Array<{ symbol: string; value: string }> {
  const assignments: Array<{ symbol: string; value: string }> = [];
  for (const [fieldId, value] of Object.entries(assignmentValues)) {
    const field = knownFields[fieldId];
    if (!field) {
      continue;
    }
    if (field.kind === 'choice') {
      if (value) {
        assignments.push({ symbol: value, value: 'y' });
      }
      continue;
    }
    if (field.symbol) {
      assignments.push({ symbol: field.symbol, value });
    }
  }
  return assignments;
}

function applyFieldValue(fields: NativeFlashField[], fieldId: string, value: string): NativeFlashField[] {
  return fields.map((field) => {
    if (field.id !== fieldId) {
      return field;
    }
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
    return {
      ...field,
      value,
    };
  });
}

function createEmptyPanelState(target: FlashTargetKey): FlashPanelState {
  const displayName = target === 'klipper' ? 'Klipper' : 'Katapult';
  return {
    status: 'idle',
    message: `Load the active ${displayName} build configuration from this SBC.`,
    messageTone: 'info',
    loaded: false,
    checkoutPath: '',
    flashDevice: '',
    flashState: null,
    fields: [],
    knownFields: {},
    assignmentValues: {},
    isDirty: false,
    commandResult: null,
  };
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(2)} MB`;
}

function formatModified(timestamp: number): string {
  return new Date(timestamp * 1000).toLocaleString();
}

function resolveFlashDevice(previous: FlashPanelState, nextState: NativeFlashState, resetToDefault: boolean): string {
  const currentDefault = previous.flashState?.default_flash_device || '';
  const nextDefault = nextState.default_flash_device || '';
  if (resetToDefault) {
    if (previous.flashDevice && previous.flashDevice !== currentDefault) {
      return previous.flashDevice;
    }
    return nextDefault;
  }
  if (!previous.flashDevice || previous.flashDevice === currentDefault) {
    return nextDefault;
  }
  return previous.flashDevice;
}

function createLoadedPanel(
  previous: FlashPanelState,
  result: NativeFlashState,
  options: {
    message: string;
    messageTone: MessageTone;
    keepCommandResult?: boolean;
  },
): FlashPanelState {
  const fields = cloneFields(result.fields);
  return {
    ...previous,
    status: 'idle',
    message: options.message,
    messageTone: options.messageTone,
    loaded: true,
    checkoutPath: result.checkout_path || previous.checkoutPath,
    flashDevice: resolveFlashDevice(previous, result, true),
    flashState: result,
    fields,
    knownFields: fieldRecord(fields),
    assignmentValues: fieldAssignments(fields),
    isDirty: false,
    commandResult: options.keepCommandResult ? previous.commandResult : null,
  };
}

function mergePreviewPanel(previous: FlashPanelState, result: NativeFlashState): FlashPanelState {
  if (!result.available) {
    return {
      ...previous,
      status: 'idle',
      loaded: true,
      flashState: result,
      checkoutPath: result.checkout_path || previous.checkoutPath,
      message: result.error || `${result.display_name} is not available on this SBC.`,
      messageTone: 'error',
    };
  }

  const fields = cloneFields(result.fields);
  const nextKnownFields = { ...previous.knownFields };
  const nextAssignments = { ...previous.assignmentValues };
  for (const field of fields) {
    nextKnownFields[field.id] = cloneField(field);
    nextAssignments[field.id] = field.value;
  }

  return {
    ...previous,
    status: 'idle',
    loaded: true,
    checkoutPath: result.checkout_path || previous.checkoutPath,
    flashDevice: resolveFlashDevice(previous, result, false),
    flashState: result,
    fields,
    knownFields: nextKnownFields,
    assignmentValues: nextAssignments,
    isDirty: true,
    message: result.error || previous.message,
    messageTone: result.error ? 'error' : previous.messageTone,
  };
}

function groupedFields(fields: NativeFlashField[]): Map<string, NativeFlashField[]> {
  const groups = new Map<string, NativeFlashField[]>();
  for (const field of fields) {
    const name = field.menu_path.length > 0 ? field.menu_path.join(' / ') : 'General';
    const existing = groups.get(name);
    if (existing) {
      existing.push(field);
    } else {
      groups.set(name, [field]);
    }
  }
  return groups;
}

function useAnimatedDots(active: boolean): string {
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!active) {
      setTick(0);
      return undefined;
    }
    const handle = window.setInterval(() => {
      setTick((value) => (value + 1) % 4);
    }, 260);
    return () => window.clearInterval(handle);
  }, [active]);

  return '.'.repeat(Math.max(1, tick));
}

function HelpPopover({ text }: { text: string }) {
  const [open, setOpen] = useState(false);

  if (!text) {
    return null;
  }

  return (
    <div className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex h-5 w-5 items-center justify-center rounded-full border border-[var(--color-bg-tertiary)] text-[10px] font-semibold text-[var(--color-text-secondary)] hover:border-[var(--color-accent)] hover:text-[var(--color-text-primary)] transition-colors"
        aria-label="Show option help"
      >
        i
      </button>
      {open && (
        <div className="absolute right-0 top-7 z-20 w-72 rounded-xl border border-[var(--color-bg-tertiary)] bg-[var(--color-bg-secondary)] p-3 shadow-xl">
          <p className="text-xs leading-5 whitespace-pre-wrap text-[var(--color-text-secondary)]">{text}</p>
        </div>
      )}
    </div>
  );
}

export default function FirmwareDialog({ onClose }: FirmwareDialogProps) {
  const [activeTarget, setActiveTarget] = useState<FlashTargetKey>('klipper');
  const [panels, setPanels] = useState<Record<FlashTargetKey, FlashPanelState>>({
    klipper: createEmptyPanelState('klipper'),
    katapult: createEmptyPanelState('katapult'),
  });

  const buildDots = useAnimatedDots(panels[activeTarget].status === 'building');
  const flashDots = useAnimatedDots(panels[activeTarget].status === 'flashing');

  function updatePanel(target: FlashTargetKey, updater: (panel: FlashPanelState) => FlashPanelState) {
    setPanels((previous) => ({
      ...previous,
      [target]: updater(previous[target]),
    }));
  }

  async function loadState(target: FlashTargetKey, overridePath?: string) {
    const requestedPath = overridePath?.trim();
    updatePanel(target, (panel) => ({
      ...panel,
      status: 'loading',
      message: `Loading ${target === 'klipper' ? 'Klipper' : 'Katapult'} build configuration...`,
      messageTone: 'info',
      checkoutPath: requestedPath ?? panel.checkoutPath,
    }));

    try {
      const result = await api.getNativeFlashState(target, requestedPath || undefined);
      updatePanel(target, (panel) => {
        if (!result.available) {
          return createLoadedPanel(panel, result, {
            message: result.error || `${result.display_name} is not available on this SBC.`,
            messageTone: 'error',
          });
        }

        const message = result.config_exists
          ? `Loaded active ${result.display_name} build config from ${result.config_path}`
          : `No existing .config was found. Defaults from ${result.checkout_path} are ready to edit.`;

        return createLoadedPanel(panel, result, {
          message,
          messageTone: 'info',
        });
      });
    } catch (error) {
      updatePanel(target, (panel) => ({
        ...panel,
        status: 'idle',
        loaded: true,
        message: error instanceof Error ? error.message : 'Failed to load the flash target configuration.',
        messageTone: 'error',
      }));
    }
  }

  async function previewConfig(
    target: FlashTargetKey,
    assignmentValues: Record<string, string>,
    knownFields: Record<string, NativeFlashField>,
    checkoutPath: string,
  ) {
    updatePanel(target, (panel) => ({
      ...panel,
      status: 'previewing',
    }));

    try {
      const result = await api.previewNativeFlashConfig(
        target,
        buildAssignments(assignmentValues, knownFields),
        checkoutPath.trim() || undefined,
      );
      updatePanel(target, (panel) => mergePreviewPanel(panel, result));
    } catch (error) {
      updatePanel(target, (panel) => ({
        ...panel,
        status: 'idle',
        message: error instanceof Error ? error.message : 'Failed to refresh the menuconfig preview.',
        messageTone: 'error',
      }));
    }
  }

  async function persistConfig(target: FlashTargetKey, showSuccessMessage: boolean): Promise<boolean> {
    const panel = panels[target];
    if (!panel.flashState?.available) {
      updatePanel(target, (current) => ({
        ...current,
        message: `${target === 'klipper' ? 'Klipper' : 'Katapult'} is not available on this SBC.`,
        messageTone: 'error',
      }));
      return false;
    }

    updatePanel(target, (current) => ({
      ...current,
      status: 'saving',
      message: `Saving ${current.flashState?.display_name || 'flash target'} build configuration...`,
      messageTone: 'info',
    }));

    try {
      const result = await api.updateNativeFlashConfig(
        target,
        buildAssignments(panel.assignmentValues, panel.knownFields),
        panel.checkoutPath.trim() || undefined,
      );

      updatePanel(target, (current) => {
        if (!result.available) {
          return createLoadedPanel(current, result, {
            message: result.error || `${result.display_name} is not available on this SBC.`,
            messageTone: 'error',
            keepCommandResult: true,
          });
        }
        return createLoadedPanel(current, result, {
          message: result.error
            ? result.error
            : showSuccessMessage
              ? `Saved ${result.display_name} build configuration to ${result.config_path}`
              : current.message,
          messageTone: result.error ? 'error' : showSuccessMessage ? 'success' : current.messageTone,
          keepCommandResult: true,
        });
      });

      return result.available && !result.error;
    } catch (error) {
      updatePanel(target, (current) => ({
        ...current,
        status: 'idle',
        message: error instanceof Error ? error.message : 'Failed to save the build configuration.',
        messageTone: 'error',
      }));
      return false;
    }
  }

  async function handleBuild(target: FlashTargetKey) {
    const panel = panels[target];
    if (!panel.flashState?.available) {
      updatePanel(target, (current) => ({
        ...current,
        message: `${target === 'klipper' ? 'Klipper' : 'Katapult'} is not available on this SBC.`,
        messageTone: 'error',
      }));
      return;
    }

    if (panel.isDirty) {
      const saved = await persistConfig(target, false);
      if (!saved) {
        return;
      }
    }

    updatePanel(target, (current) => ({
      ...current,
      status: 'building',
      message: `Running make olddefconfig and make in ${current.flashState?.display_name || 'the active checkout'}...`,
      messageTone: 'info',
    }));

    try {
      const result = await api.buildNativeFlashTarget(target, panel.checkoutPath.trim() || undefined);
      updatePanel(target, (current) => ({
        ...current,
        status: 'idle',
        checkoutPath: result.checkout_path || current.checkoutPath,
        commandResult: result,
        flashState: current.flashState
          ? {
              ...current.flashState,
              checkout_path: result.checkout_path || current.flashState.checkout_path,
              out_path: result.out_path || current.flashState.out_path,
              artifacts: result.artifacts,
              primary_artifact: result.primary_artifact,
            }
          : current.flashState,
        message: result.success
          ? result.primary_artifact
            ? `Built ${result.primary_artifact.name} in ${result.out_path}`
            : `Build completed in ${result.out_path}`
          : result.error || `${result.display_name} build failed.`,
        messageTone: result.success ? 'success' : 'error',
      }));
    } catch (error) {
      updatePanel(target, (current) => ({
        ...current,
        status: 'idle',
        message: error instanceof Error ? error.message : 'Failed to build the selected target.',
        messageTone: 'error',
      }));
    }
  }

  async function handleFlash(target: FlashTargetKey) {
    const panel = panels[target];
    if (!panel.flashState?.available) {
      updatePanel(target, (current) => ({
        ...current,
        message: `${target === 'klipper' ? 'Klipper' : 'Katapult'} is not available on this SBC.`,
        messageTone: 'error',
      }));
      return;
    }
    if (!panel.flashState.flash_supported) {
      updatePanel(target, (current) => ({
        ...current,
        message: current.flashState?.flash_reason || 'Flashing is not supported for the current target.',
        messageTone: 'error',
      }));
      return;
    }

    if (panel.isDirty) {
      const saved = await persistConfig(target, false);
      if (!saved) {
        return;
      }
    }

    updatePanel(target, (current) => ({
      ...current,
      status: 'flashing',
      message: `Running make flash in ${current.flashState?.display_name || 'the active checkout'}...`,
      messageTone: 'info',
    }));

    try {
      const result = await api.flashNativeFlashTarget(
        target,
        panel.checkoutPath.trim() || undefined,
        panel.flashDevice.trim() || undefined,
      );
      updatePanel(target, (current) => ({
        ...current,
        status: 'idle',
        checkoutPath: result.checkout_path || current.checkoutPath,
        commandResult: result,
        flashState: current.flashState
          ? {
              ...current.flashState,
              checkout_path: result.checkout_path || current.flashState.checkout_path,
              out_path: result.out_path || current.flashState.out_path,
              artifacts: result.artifacts,
              primary_artifact: result.primary_artifact,
            }
          : current.flashState,
        message: result.success
          ? `Flash completed${result.flash_device ? ` using ${result.flash_device}` : ''}.`
          : result.error || `${result.display_name} flash failed.`,
        messageTone: result.success ? 'success' : 'error',
      }));
    } catch (error) {
      updatePanel(target, (current) => ({
        ...current,
        status: 'idle',
        message: error instanceof Error ? error.message : 'Failed to flash the selected target.',
        messageTone: 'error',
      }));
    }
  }

  async function handleDownload(target: FlashTargetKey, artifact: NativeFlashArtifact) {
    const panel = panels[target];
    try {
      updatePanel(target, (current) => ({
        ...current,
        message: `Downloading ${artifact.name}...`,
        messageTone: 'info',
      }));
      const blob = await api.downloadNativeFlashArtifact(target, artifact.name, panel.checkoutPath.trim() || undefined);
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = artifact.name;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);
      updatePanel(target, (current) => ({
        ...current,
        message: `Downloaded ${artifact.name}`,
        messageTone: 'success',
      }));
    } catch (error) {
      updatePanel(target, (current) => ({
        ...current,
        message: error instanceof Error ? error.message : 'Failed to download the artifact.',
        messageTone: 'error',
      }));
    }
  }

  function handleFieldChange(target: FlashTargetKey, fieldId: string, value: string, previewImmediately: boolean) {
    const panel = panels[target];
    const nextFields = applyFieldValue(panel.fields, fieldId, value);
    const changedField = nextFields.find((field) => field.id === fieldId);
    const nextKnownFields = { ...panel.knownFields };
    if (changedField) {
      nextKnownFields[fieldId] = cloneField(changedField);
    }
    const nextAssignments = {
      ...panel.assignmentValues,
      [fieldId]: value,
    };

    updatePanel(target, (current) => ({
      ...current,
      fields: nextFields,
      knownFields: nextKnownFields,
      assignmentValues: nextAssignments,
      isDirty: true,
    }));

    if (previewImmediately) {
      void previewConfig(target, nextAssignments, nextKnownFields, panel.checkoutPath);
    }
  }

  useEffect(() => {
    const panel = panels[activeTarget];
    if (!panel.loaded && panel.status === 'idle') {
      void loadState(activeTarget);
    }
  }, [activeTarget, panels]);

  const panel = panels[activeTarget];
  const fieldGroups = groupedFields(panel.fields);
  const artifacts = panel.commandResult?.artifacts || panel.flashState?.artifacts || [];
  const primaryArtifact = panel.commandResult?.primary_artifact || panel.flashState?.primary_artifact || null;
  const actionBusy = panel.status !== 'idle';
  const buildLabel = panel.status === 'building' ? `Build${buildDots}` : 'Build';
  const flashLabel = panel.status === 'flashing' ? `Flash${flashDots}` : 'Flash';
  const loadLabel = panel.status === 'loading' ? 'Loading...' : 'Load';
  const saveLabel = panel.status === 'saving' ? 'Saving...' : 'Save .config';
  const flashDeviceCandidates = panel.flashState?.flash_device_candidates || [];
  const flashDeviceListId = `flash-device-options-${activeTarget}`;
  const showFlashDevice = Boolean(
    panel.flashState?.flash_supported
      && (
        panel.flashState.flash_device_required
        || panel.flashState.flash_device_placeholder
        || panel.flashState.default_flash_device
        || flashDeviceCandidates.length > 0
      ),
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="flex max-h-[92vh] w-[1180px] max-w-[96vw] flex-col overflow-hidden rounded-2xl border border-[var(--color-bg-tertiary)] bg-[var(--color-bg-secondary)] shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between border-b border-[var(--color-bg-tertiary)] px-4 py-4">
          <div>
            <h2 className="text-base font-semibold text-[var(--color-text-primary)]">Flash</h2>
            <p className="mt-0.5 text-xs text-[var(--color-text-secondary)]">
              Preview menuconfig changes live, save the active .config, build firmware locally, and run make flash when the target supports it.
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded p-1 text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)]"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <div className="border-b border-[var(--color-bg-tertiary)] px-4 pt-4">
          <div className="flex gap-2">
            {TARGETS.map((target) => {
              const targetPanel = panels[target];
              const selected = activeTarget === target;
              const label = target === 'klipper' ? 'Klipper' : 'Katapult';
              return (
                <button
                  key={target}
                  type="button"
                  onClick={() => setActiveTarget(target)}
                  className={`rounded-t-xl border px-4 py-2 text-sm font-medium transition-colors ${
                    selected
                      ? 'border-[var(--color-bg-tertiary)] border-b-[var(--color-bg-secondary)] bg-[var(--color-bg-secondary)] text-[var(--color-text-primary)]'
                      : 'border-transparent bg-[var(--color-bg-primary)]/60 text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'
                  }`}
                >
                  <span>{label}</span>
                  {targetPanel.isDirty && <span className="ml-2 text-[11px] text-amber-300">unsaved</span>}
                </button>
              );
            })}
          </div>
        </div>

        <div className="space-y-3 border-b border-[var(--color-bg-tertiary)] px-4 py-4">
          <div className="flex flex-col gap-3 xl:flex-row xl:items-end">
            <div className="min-w-0 flex-1">
              <label className="mb-1 block text-xs font-medium text-[var(--color-text-secondary)]">
                {activeTarget === 'klipper' ? 'Klipper Checkout' : 'Katapult Checkout'}
              </label>
              <input
                type="text"
                value={panel.checkoutPath}
                onChange={(event) => updatePanel(activeTarget, (current) => ({ ...current, checkoutPath: event.target.value }))}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    void loadState(activeTarget, panel.checkoutPath);
                  }
                }}
                placeholder={activeTarget === 'klipper'
                  ? 'Auto-detect ~/klipper or enter another checkout path'
                  : 'Auto-detect ~/katapult or enter another checkout path'}
                className="w-full rounded-md border border-[var(--color-bg-tertiary)] bg-[var(--color-bg-primary)] px-3 py-2 text-xs font-mono text-[var(--color-text-primary)]"
              />
            </div>

            {showFlashDevice && (
              <div className="min-w-0 xl:w-[320px]">
                <label className="mb-1 block text-xs font-medium text-[var(--color-text-secondary)]">
                  Flash Device{panel.flashState?.flash_device_required ? ' *' : ''}
                </label>
                <input
                  type="text"
                  value={panel.flashDevice}
                  list={flashDeviceCandidates.length > 0 ? flashDeviceListId : undefined}
                  onChange={(event) => updatePanel(activeTarget, (current) => ({ ...current, flashDevice: event.target.value }))}
                  placeholder={panel.flashState?.flash_device_placeholder || 'Optional flash device override'}
                  className="w-full rounded-md border border-[var(--color-bg-tertiary)] bg-[var(--color-bg-primary)] px-3 py-2 text-xs font-mono text-[var(--color-text-primary)]"
                />
                {flashDeviceCandidates.length > 0 && (
                  <>
                    <datalist id={flashDeviceListId}>
                      {flashDeviceCandidates.map((candidate) => (
                        <option
                          key={`${candidate.value}:${candidate.label}`}
                          value={candidate.value}
                          label={candidate.label}
                        />
                      ))}
                    </datalist>
                    <div className="mt-2 space-y-2">
                      <p className="text-[11px] text-[var(--color-text-secondary)]">
                        Detected candidates from USB and serial probing.
                      </p>
                      <div className="flex flex-wrap gap-2">
                        {flashDeviceCandidates.map((candidate) => {
                          const selected = panel.flashDevice === candidate.value;
                          return (
                            <button
                              key={`${candidate.value}:${candidate.label}`}
                              type="button"
                              title={candidate.label}
                              onClick={() => updatePanel(activeTarget, (current) => ({ ...current, flashDevice: candidate.value }))}
                              className={`max-w-full rounded-lg border px-3 py-2 text-left transition-colors ${
                                selected
                                  ? 'border-[var(--color-accent)] bg-[var(--color-accent)]/10 text-[var(--color-text-primary)]'
                                  : 'border-[var(--color-bg-tertiary)] bg-[var(--color-bg-primary)]/70 text-[var(--color-text-secondary)] hover:border-[var(--color-accent)] hover:text-[var(--color-text-primary)]'
                              }`}
                            >
                              <p className="truncate text-[11px] font-semibold text-inherit">{candidate.value}</p>
                              {candidate.label !== candidate.value && (
                                <p className="mt-1 line-clamp-2 text-[10px] text-inherit/80">{candidate.label}</p>
                              )}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  </>
                )}
              </div>
            )}

            <div className="flex shrink-0 flex-wrap gap-2">
              <button
                onClick={() => void loadState(activeTarget, panel.checkoutPath)}
                disabled={actionBusy}
                className="rounded-md bg-[var(--color-bg-tertiary)] px-4 py-2 text-xs font-medium text-[var(--color-text-primary)] transition-colors hover:bg-[var(--color-bg-primary)] disabled:opacity-50"
              >
                {loadLabel}
              </button>
              <button
                onClick={() => void persistConfig(activeTarget, true)}
                disabled={actionBusy || !panel.flashState?.available || !panel.isDirty}
                className="rounded-md bg-[var(--color-bg-tertiary)] px-4 py-2 text-xs font-medium text-[var(--color-text-primary)] transition-colors hover:bg-[var(--color-accent)] hover:text-[var(--color-bg-primary)] disabled:opacity-50"
              >
                {saveLabel}
              </button>
              <button
                onClick={() => void handleBuild(activeTarget)}
                disabled={actionBusy || !panel.flashState?.available}
                className="rounded-md bg-amber-500 px-4 py-2 text-xs font-semibold text-black transition-colors hover:bg-amber-400 disabled:opacity-50"
              >
                {buildLabel}
              </button>
              <button
                onClick={() => void handleFlash(activeTarget)}
                disabled={actionBusy || !panel.flashState?.available || !panel.flashState?.flash_supported}
                className="rounded-md bg-emerald-500 px-4 py-2 text-xs font-semibold text-black transition-colors hover:bg-emerald-400 disabled:opacity-50"
              >
                {flashLabel}
              </button>
            </div>
          </div>

          <div className="rounded-xl border border-[var(--color-bg-tertiary)] bg-[var(--color-bg-primary)]/60 px-3 py-3">
            <p className="text-xs leading-5 text-[var(--color-text-secondary)]">
              Changes update the visible menuconfig fields immediately. Save writes the active .config file. Build runs make olddefconfig followed by make. Flash runs make flash with NOSUDO=1 and uses the flash device field when the selected target requires one.
            </p>
          </div>
        </div>

        <div className="flex min-h-0 flex-1 flex-col xl:flex-row">
          <div className="flex min-h-0 flex-col border-b border-[var(--color-bg-tertiary)] xl:w-[60%] xl:border-b-0 xl:border-r">
            <div className="flex-1 space-y-4 overflow-y-auto p-4">
              {panel.flashState && !panel.flashState.available && (
                <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-4">
                  <p className="text-sm text-red-300">
                    {panel.flashState.error || `${panel.flashState.display_name} was not detected on this SBC.`}
                  </p>
                </div>
              )}

              {panel.flashState?.available && !panel.flashState.config_exists && (
                <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4">
                  <p className="text-sm text-amber-100">
                    No existing .config file was found. Saving or building will generate one from the selected options.
                  </p>
                </div>
              )}

              {panel.flashState?.available && fieldGroups.size === 0 && (
                <div className="rounded-xl border border-[var(--color-bg-tertiary)] p-4 text-sm text-[var(--color-text-secondary)]">
                  No visible menuconfig options are available for the current selection.
                </div>
              )}

              {Array.from(fieldGroups.entries()).map(([groupName, groupFields]) => (
                <section key={groupName} className="overflow-hidden rounded-xl border border-[var(--color-bg-tertiary)]">
                  <div className="border-b border-[var(--color-bg-tertiary)] bg-[var(--color-bg-primary)]/70 px-4 py-3">
                    <h3 className="text-sm font-semibold text-[var(--color-text-primary)]">{groupName}</h3>
                  </div>
                  <div className="divide-y divide-[var(--color-bg-tertiary)]">
                    {groupFields.map((field) => (
                      <div key={field.id} className="space-y-2 px-4 py-3">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <p className="text-sm font-medium text-[var(--color-text-primary)]">{field.prompt}</p>
                              <HelpPopover text={field.help} />
                            </div>
                            {field.symbol && (
                              <p className="mt-1 text-[10px] font-mono text-[var(--color-text-secondary)]">{field.symbol}</p>
                            )}
                          </div>

                          {field.kind === 'bool' ? (
                            <label className="inline-flex shrink-0 cursor-pointer items-center gap-2 text-xs text-[var(--color-text-secondary)]">
                              <input
                                type="checkbox"
                                checked={field.value === 'y'}
                                onChange={(event) => handleFieldChange(activeTarget, field.id, event.target.checked ? 'y' : 'n', true)}
                                className="rounded"
                              />
                              {field.value === 'y' ? 'Enabled' : 'Disabled'}
                            </label>
                          ) : field.kind === 'choice' ? (
                            <select
                              value={field.value}
                              onChange={(event) => handleFieldChange(activeTarget, field.id, event.target.value, true)}
                              className="w-64 shrink-0 rounded-md border border-[var(--color-bg-tertiary)] bg-[var(--color-bg-primary)] px-2 py-1.5 text-xs text-[var(--color-text-primary)]"
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
                              onChange={(event) => handleFieldChange(activeTarget, field.id, event.target.value, true)}
                              className="w-28 shrink-0 rounded-md border border-[var(--color-bg-tertiary)] bg-[var(--color-bg-primary)] px-2 py-1.5 text-xs text-[var(--color-text-primary)]"
                            >
                              {(field.assignable.length > 0 ? field.assignable : ['n', 'm', 'y']).map((value) => (
                                <option key={value} value={value}>
                                  {value}
                                </option>
                              ))}
                            </select>
                          ) : (
                            <input
                              type="text"
                              value={field.value}
                              onChange={(event) => handleFieldChange(activeTarget, field.id, event.target.value, false)}
                              onBlur={() => void previewConfig(activeTarget, panel.assignmentValues, panel.knownFields, panel.checkoutPath)}
                              onKeyDown={(event) => {
                                if (event.key === 'Enter') {
                                  event.currentTarget.blur();
                                }
                              }}
                              className="w-64 shrink-0 rounded-md border border-[var(--color-bg-tertiary)] bg-[var(--color-bg-primary)] px-2 py-1.5 text-xs font-mono text-[var(--color-text-primary)]"
                            />
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          </div>

          <div className="flex min-h-0 flex-1 flex-col">
            <div className="grid gap-3 border-b border-[var(--color-bg-tertiary)] px-4 py-4 md:grid-cols-2">
              <div className="rounded-xl border border-[var(--color-bg-tertiary)] bg-[var(--color-bg-primary)]/60 p-3">
                <p className="mb-1 text-[11px] uppercase tracking-[0.12em] text-[var(--color-text-secondary)]">Config File</p>
                <p className="break-all text-xs font-mono text-[var(--color-text-primary)]">
                  {panel.flashState?.config_path || 'Unavailable'}
                </p>
              </div>
              <div className="rounded-xl border border-[var(--color-bg-tertiary)] bg-[var(--color-bg-primary)]/60 p-3">
                <p className="mb-1 text-[11px] uppercase tracking-[0.12em] text-[var(--color-text-secondary)]">Output Directory</p>
                <p className="break-all text-xs font-mono text-[var(--color-text-primary)]">
                  {panel.commandResult?.out_path || panel.flashState?.out_path || 'Unavailable'}
                </p>
              </div>
              <div className="rounded-xl border border-[var(--color-bg-tertiary)] bg-[var(--color-bg-primary)]/60 p-3 md:col-span-2">
                <p className="mb-1 text-[11px] uppercase tracking-[0.12em] text-[var(--color-text-secondary)]">Flash Support</p>
                <p className="text-xs leading-5 text-[var(--color-text-primary)]">
                  {panel.flashState?.flash_supported
                    ? panel.flashState.flash_help || 'make flash is available for the current target.'
                    : panel.flashState?.flash_reason || 'Load a target to see its flashing capabilities.'}
                </p>
              </div>
            </div>

            <div className="flex-1 space-y-4 overflow-y-auto p-4">
              <section className="overflow-hidden rounded-xl border border-[var(--color-bg-tertiary)]">
                <div className="border-b border-[var(--color-bg-tertiary)] bg-[var(--color-bg-primary)]/70 px-4 py-3">
                  <h3 className="text-sm font-semibold text-[var(--color-text-primary)]">Artifacts</h3>
                  <p className="mt-1 text-xs text-[var(--color-text-secondary)]">
                    Generated files stay on the SBC under the active out directory and can also be downloaded directly from here.
                  </p>
                </div>
                <div className="space-y-2 p-4">
                  {artifacts.length === 0 && (
                    <p className="text-sm text-[var(--color-text-secondary)]">No artifacts found yet.</p>
                  )}
                  {artifacts.map((artifact) => (
                    <div
                      key={artifact.name}
                      className="flex items-center justify-between gap-3 rounded-xl border border-[var(--color-bg-tertiary)] bg-[var(--color-bg-primary)]/50 px-3 py-2"
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="truncate text-sm font-medium text-[var(--color-text-primary)]">{artifact.name}</p>
                          {primaryArtifact?.name === artifact.name && (
                            <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-emerald-300">
                              primary
                            </span>
                          )}
                        </div>
                        <p className="mt-1 text-[11px] text-[var(--color-text-secondary)]">
                          {formatBytes(artifact.size)} • {formatModified(artifact.modified)}
                        </p>
                      </div>
                      <button
                        onClick={() => void handleDownload(activeTarget, artifact)}
                        className="rounded-md bg-[var(--color-bg-tertiary)] px-3 py-1.5 text-xs font-medium text-[var(--color-text-primary)] transition-colors hover:bg-[var(--color-accent)] hover:text-[var(--color-bg-primary)]"
                      >
                        Download
                      </button>
                    </div>
                  ))}
                </div>
              </section>

              <section className="flex min-h-[320px] flex-col overflow-hidden rounded-xl border border-[var(--color-bg-tertiary)]">
                <div className="border-b border-[var(--color-bg-tertiary)] bg-[var(--color-bg-primary)]/70 px-4 py-3">
                  <h3 className="text-sm font-semibold text-[var(--color-text-primary)]">Command Log</h3>
                  <p className="mt-1 text-xs text-[var(--color-text-secondary)]">
                    The latest output from the most recent build or flash command.
                  </p>
                </div>
                <div className="flex-1 overflow-auto bg-black/30 p-4">
                  <pre className="whitespace-pre-wrap break-words text-[11px] leading-5 text-[var(--color-text-primary)]">
                    {panel.commandResult?.log || 'No build or flash command has been run in this session yet.'}
                  </pre>
                </div>
              </section>
            </div>
          </div>
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-[var(--color-bg-tertiary)] px-4 py-3">
          <p
            className={`text-xs ${
              panel.messageTone === 'error'
                ? 'text-red-400'
                : panel.messageTone === 'success'
                  ? 'text-green-400'
                  : 'text-[var(--color-text-secondary)]'
            }`}
          >
            {panel.message}
          </p>
          <button
            onClick={onClose}
            className="rounded-md bg-[var(--color-bg-tertiary)] px-4 py-1.5 text-xs font-medium text-[var(--color-text-primary)] transition-colors hover:bg-[var(--color-bg-primary)]"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}