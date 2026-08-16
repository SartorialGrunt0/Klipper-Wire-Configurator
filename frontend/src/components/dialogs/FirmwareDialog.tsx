import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import * as api from '../../services/api';
import type {
  FlashTargetKey,
  NativeFlashArtifact,
  NativeFlashCommandResult,
  NativeFlashDeviceCandidate,
  NativeFlashField,
  NativeFlashMethodCandidate,
  NativeFlashProfile,
  NativeFlashProfileAssignment,
  NativeFlashProfileSummary,
  NativeFlashState,
} from '../../services/api';
import {
  CAN_UUID_PATTERN,
  USB_ID_PATTERN,
  applyFieldValue,
  buildAssignments,
  buildPanelAssignments,
  cloneField,
  cloneFields,
  fieldAssignments,
  fieldRecord,
  flashMethodRecord,
  formatBytes,
  formatModified,
  groupedFields,
  inferFlashMethodForDevice,
  isBusyStatus,
  mergeDeviceCandidates,
  normalizeProfileAssignments,
  PreviewEpoch,
  resolveFlashDevice,
  resolveFlashMethod,
  resolveMethodDefaultDevice,
} from '../../utils/flashPanel';

interface FirmwareDialogProps {
  onClose: () => void;
}

type FlashDeviceCandidate = NativeFlashDeviceCandidate;

interface SavedFlashTargetProfile {
  name: string;
  checkoutPath: string;
  flashDevice: string;
  flashMethod: string;
  assignments: NativeFlashProfileAssignment[];
}

interface FlashProfileDialogState {
  mode: 'load' | 'save';
  target: FlashTargetKey;
  profiles: NativeFlashProfileSummary[];
  name: string;
  error: string;
  loading: boolean;
  saving: boolean;
  deletingName: string | null;
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
  flashMethod: string;
  stickyAssignments: NativeFlashProfileAssignment[];
  flashState: NativeFlashState | null;
  fields: NativeFlashField[];
  knownFields: Record<string, NativeFlashField>;
  assignmentValues: Record<string, string>;
  isDirty: boolean;
  commandResult: NativeFlashCommandResult | null;
  scannedDeviceCandidates: NativeFlashDeviceCandidate[];
  devicesScanning: boolean;
}

const TARGETS: FlashTargetKey[] = ['klipper', 'katapult'];
const CHECKOUT_PATHS_STORAGE_KEY = 'klipper-wire-firmware-checkout-paths';

function loadPersistedCheckoutPaths(): Record<FlashTargetKey, string> {
  try {
    const raw = localStorage.getItem(CHECKOUT_PATHS_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Record<FlashTargetKey, string>>;
      return {
        klipper: typeof parsed.klipper === 'string' ? parsed.klipper : '',
        katapult: typeof parsed.katapult === 'string' ? parsed.katapult : '',
      };
    }
  } catch { /* ignore */ }
  return { klipper: '', katapult: '' };
}

function savePersistedCheckoutPaths(paths: Record<FlashTargetKey, string>): void {
  try {
    localStorage.setItem(CHECKOUT_PATHS_STORAGE_KEY, JSON.stringify(paths));
  } catch { /* ignore */ }
}

const FLASH_WORKFLOW_HELP = 'Changes update the visible menuconfig fields immediately. Use the settings gear to override the Klipper and Katapult checkout paths and refresh detected flash devices. Save writes the active .config file and then lets you store the current flash setup under a unique host-side profile name. Load opens the active config or any saved host-side flash profile for the current target. Flash auto-matches the selected device to a supported method when possible, while still letting you override the method manually.';
const ARTIFACTS_HELP = 'Generated files stay on the SBC under the active out directory. You can download them directly here or delete stale artifacts you no longer need.';
const COMMAND_LOG_HELP = 'The latest output from the most recent build or flash command.';
const HELP_POPOVER_WIDTH = 288;
const HELP_POPOVER_MARGIN = 12;
const HELP_POPOVER_OFFSET = 8;
const PREVIEW_DEBOUNCE_MS = 180;

interface HelpPopoverPosition {
  top: number;
  left: number;
}

function createEmptyPanelState(target: FlashTargetKey, checkoutPath = ''): FlashPanelState {
  const displayName = target === 'klipper' ? 'Klipper' : 'Katapult';
  return {
    status: 'idle',
    message: `Load the active ${displayName} build configuration from this SBC.`,
    messageTone: 'info',
    loaded: false,
    checkoutPath,
    flashDevice: '',
    flashMethod: '',
    stickyAssignments: [],
    flashState: null,
    fields: [],
    knownFields: {},
    assignmentValues: {},
    isDirty: false,
    commandResult: null,
    scannedDeviceCandidates: [],
    devicesScanning: false,
  };
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
  const flashMethod = resolveFlashMethod(previous, result, true);
  return {
    ...previous,
    status: 'idle',
    message: options.message,
    messageTone: options.messageTone,
    loaded: true,
    checkoutPath: result.checkout_path || previous.checkoutPath,
    flashMethod,
    flashDevice: resolveFlashDevice(previous, result, flashMethod, true),
    stickyAssignments: [],
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
    flashMethod: resolveFlashMethod(previous, result, false),
    flashDevice: resolveFlashDevice(previous, result, resolveFlashMethod(previous, result, false), false),
    flashState: result,
    fields,
    knownFields: nextKnownFields,
    assignmentValues: nextAssignments,
    isDirty: true,
    message: result.error || previous.message,
    messageTone: result.error ? 'error' : previous.messageTone,
  };
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

/** Per-session cache of lazy-loaded full field help, keyed by `${target}:${fieldId}`. */
const fieldHelpCache = new Map<string, string>();

function HelpPopover({
  text,
  lazyFetch,
}: {
  text: string;
  lazyFetch?: () => Promise<string>;
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<HelpPopoverPosition | null>(null);
  const [fullText, setFullText] = useState<string | null>(null);
  const [loadingHelp, setLoadingHelp] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);

  // When the payload help was truncated ("…"), fetch the full text lazily the
  // first time the popover opens. Falls back to the truncated text on error.
  useEffect(() => {
    if (!open || !lazyFetch || !text.endsWith('…') || fullText !== null || loadingHelp) {
      return undefined;
    }
    let cancelled = false;
    setLoadingHelp(true);
    lazyFetch()
      .then((fetched) => {
        if (!cancelled) {
          setFullText(fetched || text);
        }
      })
      .catch(() => { /* keep the truncated text */ })
      .finally(() => {
        if (!cancelled) {
          setLoadingHelp(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open, lazyFetch, text, fullText, loadingHelp]);

  function updatePosition() {
    const trigger = triggerRef.current;
    if (!open || !trigger) {
      return;
    }

    const rect = trigger.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const popoverWidth = Math.min(
      popoverRef.current?.offsetWidth || HELP_POPOVER_WIDTH,
      viewportWidth - (HELP_POPOVER_MARGIN * 2),
    );
    const popoverHeight = popoverRef.current?.offsetHeight || 120;
    const left = Math.max(
      HELP_POPOVER_MARGIN,
      Math.min(rect.right - popoverWidth, viewportWidth - popoverWidth - HELP_POPOVER_MARGIN),
    );
    const fitsBelow = rect.bottom + HELP_POPOVER_OFFSET + popoverHeight <= viewportHeight - HELP_POPOVER_MARGIN;
    const top = fitsBelow
      ? rect.bottom + HELP_POPOVER_OFFSET
      : Math.max(HELP_POPOVER_MARGIN, rect.top - popoverHeight - HELP_POPOVER_OFFSET);

    setPosition({ top, left });
  }

  useLayoutEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }
    updatePosition();
  }, [open, fullText, loadingHelp]);

  useEffect(() => {
    if (!open) {
      return undefined;
    }

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) {
        setOpen(false);
        return;
      }
      if (triggerRef.current?.contains(target) || popoverRef.current?.contains(target)) {
        return;
      }
      setOpen(false);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    };

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('scroll', updatePosition, true);
    window.addEventListener('resize', updatePosition);

    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('scroll', updatePosition, true);
      window.removeEventListener('resize', updatePosition);
    };
  }, [open]);

  if (!text) {
    return null;
  }

  return (
    <div className="shrink-0">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex h-5 w-5 items-center justify-center rounded-full border border-[var(--color-bg-tertiary)] text-[10px] font-semibold text-[var(--color-text-secondary)] hover:border-[var(--color-accent)] hover:text-[var(--color-text-primary)] transition-colors"
        aria-label="Show option help"
        aria-expanded={open}
      >
        i
      </button>
      {open && createPortal(
        <div
          ref={popoverRef}
          className="fixed rounded-xl border border-[var(--color-bg-tertiary)] bg-[var(--color-bg-secondary)] p-3 shadow-2xl"
          style={{
            top: position?.top ?? 0,
            left: position?.left ?? HELP_POPOVER_MARGIN,
            width: `min(18rem, calc(100vw - ${HELP_POPOVER_MARGIN * 2}px))`,
            visibility: position ? 'visible' : 'hidden',
            zIndex: 80,
          }}
        >
          <p className="text-xs leading-5 whitespace-pre-wrap text-[var(--color-text-secondary)]">
            {loadingHelp && fullText === null ? 'Loading help…' : (fullText ?? text)}
          </p>
        </div>,
        document.body,
      )}
    </div>
  );
}

function FlashDeviceField({
  value,
  onChange,
  placeholder,
  candidates,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  candidates: FlashDeviceCandidate[];
}) {
  const [open, setOpen] = useState(false);
  const fieldRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) {
      return undefined;
    }

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && fieldRef.current?.contains(target)) {
        return;
      }
      setOpen(false);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    };

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  return (
    <div ref={fieldRef} className="relative">
      <input
        type="text"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="w-full rounded-md border border-[var(--color-bg-tertiary)] bg-[var(--color-bg-primary)] px-3 py-2 pr-12 text-xs font-mono text-[var(--color-text-primary)]"
      />
      <button
        type="button"
        onClick={() => {
          if (candidates.length > 0) {
            setOpen((current) => !current);
          }
        }}
        disabled={candidates.length === 0}
        title={candidates.length > 0 ? 'Select a detected flash device' : 'No detected flash devices are available yet'}
        className="absolute inset-y-[1px] right-[1px] flex w-10 items-center justify-center rounded-r-md border-l border-[var(--color-bg-tertiary)] bg-[var(--color-bg-primary)] text-[var(--color-text-secondary)] transition-colors hover:text-[var(--color-text-primary)] disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:text-[var(--color-text-secondary)]"
        aria-label="Select detected flash device"
        aria-expanded={open}
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 16 16"
          fill="none"
          className={`transition-transform ${open ? 'rotate-180' : ''}`}
        >
          <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && candidates.length > 0 && (
        <div className="absolute right-0 top-[calc(100%+0.5rem)] z-30 max-h-64 w-full overflow-auto rounded-md border border-[var(--color-bg-tertiary)] bg-[var(--color-bg-secondary)] shadow-xl">
          {candidates.map((candidate) => (
            <button
              key={`${candidate.value}:${candidate.label}`}
              type="button"
              onClick={() => {
                onChange(candidate.value);
                setOpen(false);
              }}
              className={`block w-full px-3 py-2 text-left transition-colors hover:bg-[var(--color-bg-primary)] ${value === candidate.value ? 'bg-[var(--color-bg-primary)]/70' : ''}`}
            >
              <p className="truncate text-xs font-mono text-[var(--color-text-primary)]">{candidate.value}</p>
              {candidate.label !== candidate.value && (
                <p className="mt-1 text-[10px] text-[var(--color-text-secondary)]">{candidate.label}</p>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function FirmwareDialog({ onClose }: FirmwareDialogProps) {
  const [activeTarget, setActiveTarget] = useState<FlashTargetKey>('klipper');
  const [panels, setPanels] = useState<Record<FlashTargetKey, FlashPanelState>>(() => {
    const persistedPaths = loadPersistedCheckoutPaths();
    return {
      klipper: createEmptyPanelState('klipper', persistedPaths.klipper),
      katapult: createEmptyPanelState('katapult', persistedPaths.katapult),
    };
  });
  const [profileDialog, setProfileDialog] = useState<FlashProfileDialogState | null>(null);
  const [showTargetSettings, setShowTargetSettings] = useState(false);
  const panelsRef = useRef(panels);
  const previewTimeoutsRef = useRef<Partial<Record<FlashTargetKey, number>>>({});
  const previewRequestIdsRef = useRef<Record<FlashTargetKey, number>>({
    klipper: 0,
    katapult: 0,
  });
  const previewEpochsRef = useRef<Record<FlashTargetKey, PreviewEpoch>>({
    klipper: new PreviewEpoch(),
    katapult: new PreviewEpoch(),
  });

  const buildDots = useAnimatedDots(panels[activeTarget].status === 'building');
  const flashDots = useAnimatedDots(panels[activeTarget].status === 'flashing');

  useEffect(() => {
    panelsRef.current = panels;
  }, [panels]);

  function updatePanel(target: FlashTargetKey, updater: (panel: FlashPanelState) => FlashPanelState) {
    setPanels((previous) => ({
      ...previous,
      [target]: updater(previous[target]),
    }));
  }

  function setPanelMessage(target: FlashTargetKey, message: string, messageTone: MessageTone) {
    updatePanel(target, (panel) => ({
      ...panel,
      message,
      messageTone,
    }));
  }

  function handleCheckoutPathChange(target: FlashTargetKey, checkoutPath: string) {
    updatePanel(target, (panel) => ({
      ...panel,
      checkoutPath,
    }));
  }

  async function applyCheckoutSettings() {
    TARGETS.forEach((target) => beginTargetMutation(target));
    const requestedPaths: Record<FlashTargetKey, string> = {
      klipper: panels.klipper.checkoutPath.trim(),
      katapult: panels.katapult.checkoutPath.trim(),
    };
    savePersistedCheckoutPaths(requestedPaths);
    setShowTargetSettings(false);
    await Promise.all(TARGETS.map((target) => loadState(target, requestedPaths[target] || undefined)));
    // Kick off a fresh device scan now that checkout paths may have changed.
    void Promise.all(TARGETS.map((target) => scanDevices(target, true)));
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

  async function scanDevices(target: FlashTargetKey, forceRefresh = false) {
    const checkoutPath = panelsRef.current[target].checkoutPath.trim() || undefined;
    updatePanel(target, (panel) => ({ ...panel, devicesScanning: true }));
    try {
      const result = await api.scanNativeFlashDevices(target, checkoutPath, forceRefresh);
      updatePanel(target, (panel) => ({
        ...panel,
        devicesScanning: false,
        scannedDeviceCandidates: result.candidates,
      }));
    } catch {
      updatePanel(target, (panel) => ({ ...panel, devicesScanning: false }));
    }
  }

  async function previewConfig(
    target: FlashTargetKey,
    assignmentValues: Record<string, string>,
    knownFields: Record<string, NativeFlashField>,
    stickyAssignments: NativeFlashProfileAssignment[],
    checkoutPath: string,
  ) {
    const requestId = previewRequestIdsRef.current[target] + 1;
    previewRequestIdsRef.current[target] = requestId;
    const capturedEpoch = previewEpochsRef.current[target].current;
    updatePanel(target, (panel) => ({
      ...panel,
      status: 'previewing',
    }));

    try {
      const result = await api.previewNativeFlashConfig(
        target,
        buildPanelAssignments(assignmentValues, knownFields, stickyAssignments),
        checkoutPath.trim() || undefined,
      );
      if (
        previewRequestIdsRef.current[target] !== requestId ||
        previewEpochsRef.current[target].isStale(capturedEpoch)
      ) {
        return;
      }
      updatePanel(target, (panel) => mergePreviewPanel(panel, result));
    } catch (error) {
      if (
        previewRequestIdsRef.current[target] !== requestId ||
        previewEpochsRef.current[target].isStale(capturedEpoch)
      ) {
        return;
      }
      updatePanel(target, (panel) => ({
        ...panel,
        status: 'idle',
        message: error instanceof Error ? error.message : 'Failed to refresh the menuconfig preview.',
        messageTone: 'error',
      }));
    }
  }

  function clearScheduledPreview(target: FlashTargetKey) {
    const timeoutId = previewTimeoutsRef.current[target];
    if (timeoutId !== undefined) {
      window.clearTimeout(timeoutId);
      delete previewTimeoutsRef.current[target];
    }
  }

  /** Invalidate in-flight previews for a target before a mutation starts. */
  function beginTargetMutation(target: FlashTargetKey) {
    clearScheduledPreview(target);
    previewEpochsRef.current[target].beginMutation();
  }

  function schedulePreview(
    target: FlashTargetKey,
    assignmentValues: Record<string, string>,
    knownFields: Record<string, NativeFlashField>,
    stickyAssignments: NativeFlashProfileAssignment[],
    checkoutPath: string,
    delay = PREVIEW_DEBOUNCE_MS,
  ) {
    clearScheduledPreview(target);
    previewTimeoutsRef.current[target] = window.setTimeout(() => {
      delete previewTimeoutsRef.current[target];
      void previewConfig(target, assignmentValues, knownFields, stickyAssignments, checkoutPath);
    }, delay);
  }

  async function fetchFieldHelp(target: FlashTargetKey, fieldId: string): Promise<string> {
    const cacheKey = `${target}:${fieldId}`;
    const cached = fieldHelpCache.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }
    try {
      const result = await api.getNativeFlashFieldHelp(
        target,
        fieldId,
        panels[target]?.checkoutPath.trim() || undefined,
      );
      if (result.help) {
        fieldHelpCache.set(cacheKey, result.help);
      }
      return result.help;
    } catch {
      return '';
    }
  }

  async function persistConfig(target: FlashTargetKey, showSuccessMessage: boolean): Promise<boolean> {
    beginTargetMutation(target);
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
        buildPanelAssignments(panel.assignmentValues, panel.knownFields, panel.stickyAssignments),
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
    beginTargetMutation(target);
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
    beginTargetMutation(target);
    const panel = panels[target];
    const selectedMethod = panel.flashMethod || panel.flashState?.default_flash_method || '';
    const selectedMethodState = flashMethodRecord(panel.flashState, selectedMethod);
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
    if (!selectedMethodState) {
      updatePanel(target, (current) => ({
        ...current,
        message: 'Select a supported flash method before flashing.',
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
      message: `Running ${selectedMethodState.label} in ${current.flashState?.display_name || 'the active checkout'}...`,
      messageTone: 'info',
    }));

    try {
      const result = await api.flashNativeFlashTarget(
        target,
        panel.checkoutPath.trim() || undefined,
        panel.flashDevice.trim() || undefined,
        selectedMethod,
      );
      updatePanel(target, (current) => ({
        ...current,
        status: 'idle',
        checkoutPath: result.checkout_path || current.checkoutPath,
        flashMethod: result.flash_method || current.flashMethod,
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
          ? `${flashMethodRecord(current.flashState, result.flash_method || selectedMethod)?.label || 'Flash'} completed${result.flash_device ? ` using ${result.flash_device}` : ''}.`
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

  async function handleDeleteArtifact(target: FlashTargetKey, artifact: NativeFlashArtifact) {
    const panel = panels[target];
    if (!window.confirm(`Delete ${artifact.name} from ${panel.flashState?.out_path || panel.commandResult?.out_path || 'the output directory'}?`)) {
      return;
    }

    try {
      updatePanel(target, (current) => ({
        ...current,
        message: `Deleting ${artifact.name}...`,
        messageTone: 'info',
      }));
      const result = await api.deleteNativeFlashArtifact(target, artifact.name, panel.checkoutPath.trim() || undefined);
      updatePanel(target, (current) => ({
        ...current,
        commandResult: current.commandResult
          ? {
              ...current.commandResult,
              checkout_path: result.checkout_path,
              out_path: result.out_path,
              artifacts: result.artifacts,
              primary_artifact: result.primary_artifact,
            }
          : current.commandResult,
        flashState: current.flashState
          ? {
              ...current.flashState,
              checkout_path: result.checkout_path,
              out_path: result.out_path,
              artifacts: result.artifacts,
              primary_artifact: result.primary_artifact,
            }
          : current.flashState,
        message: `Deleted ${artifact.name}`,
        messageTone: 'success',
      }));
    } catch (error) {
      updatePanel(target, (current) => ({
        ...current,
        message: error instanceof Error ? error.message : 'Failed to delete the artifact.',
        messageTone: 'error',
      }));
    }
  }

  function handleFlashDeviceChange(target: FlashTargetKey, value: string) {
    updatePanel(target, (current) => {
      const inferredMethod = inferFlashMethodForDevice(value, current.flashState);
      const fallbackMethod = !value.trim()
        ? current.flashState?.default_flash_method || current.flashMethod
        : current.flashMethod;
      return {
        ...current,
        flashDevice: value,
        flashMethod: inferredMethod || fallbackMethod,
      };
    });
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
      schedulePreview(target, nextAssignments, nextKnownFields, panel.stickyAssignments, panel.checkoutPath);
    }
  }

  useEffect(() => {
    for (const target of TARGETS) {
      const panel = panels[target];
      if (!panel.loaded && panel.status === 'idle') {
        // loadState sets loaded=true; when it completes the panel transitions
        // from idle+!loaded → idle+loaded, which prevents re-entry here.
        // After the state loads we kick off a non-blocking device scan.
        void loadState(target).then(() => {
          void scanDevices(target);
        });
      }
    }
  }, [activeTarget, panels]);

  useEffect(() => () => {
    for (const target of TARGETS) {
      clearScheduledPreview(target);
    }
  }, []);

  function handleFieldBlur(target: FlashTargetKey) {
    const panel = panelsRef.current[target];
    clearScheduledPreview(target);
    void previewConfig(
      target,
      panel.assignmentValues,
      panel.knownFields,
      panel.stickyAssignments,
      panel.checkoutPath,
    );
  }

  async function applySavedTargetProfile(target: FlashTargetKey, savedProfile: SavedFlashTargetProfile, sourceLabel: string) {
    const requestedPath = savedProfile.checkoutPath.trim();
    const normalizedAssignments = normalizeProfileAssignments(savedProfile.assignments);
    updatePanel(target, (current) => ({
      ...current,
      status: 'loading',
      checkoutPath: requestedPath || current.checkoutPath,
      message: `Loading saved ${target === 'klipper' ? 'Klipper' : 'Katapult'} flash profile from ${sourceLabel}...`,
      messageTone: 'info',
    }));

    try {
      const baseState = await api.getNativeFlashState(target, requestedPath || undefined);
      if (!baseState.available) {
        updatePanel(target, (current) => createLoadedPanel(current, baseState, {
          message: baseState.error || `${baseState.display_name} is not available on this SBC.`,
          messageTone: 'error',
        }));
        return;
      }

      let resultState = baseState;
      if (normalizedAssignments.length > 0) {
        resultState = await api.previewNativeFlashConfig(
          target,
          normalizedAssignments,
          requestedPath || undefined,
        );
      }

      updatePanel(target, (current) => {
        const inferredMethod = inferFlashMethodForDevice(savedProfile.flashDevice, resultState);
        const seededPanel: FlashPanelState = {
          ...current,
          flashMethod: inferredMethod || savedProfile.flashMethod || current.flashMethod,
          flashDevice: savedProfile.flashDevice || current.flashDevice,
          stickyAssignments: normalizedAssignments,
        };
        const loadedPanel = createLoadedPanel(seededPanel, resultState, {
          message: resultState.error
            ? resultState.error
            : `Loaded ${resultState.display_name} flash profile from ${sourceLabel}`,
          messageTone: resultState.error ? 'error' : 'success',
        });
        const preferredMethod = inferredMethod
          || (savedProfile.flashMethod && flashMethodRecord(resultState, savedProfile.flashMethod)
            ? savedProfile.flashMethod
            : loadedPanel.flashMethod);
        const preferredDevice = savedProfile.flashDevice || resolveMethodDefaultDevice(resultState, preferredMethod);
        return {
          ...loadedPanel,
          flashMethod: preferredMethod,
          flashDevice: preferredDevice || loadedPanel.flashDevice,
          stickyAssignments: normalizedAssignments,
          isDirty: true,
        };
      });
    } catch (error) {
      updatePanel(target, (current) => ({
        ...current,
        status: 'idle',
        message: error instanceof Error ? error.message : 'Failed to load the selected flash profile.',
        messageTone: 'error',
      }));
    }
  }

  function closeProfileDialog() {
    setProfileDialog(null);
  }

  async function openLoadDialog(target: FlashTargetKey) {
    setProfileDialog({
      mode: 'load',
      target,
      profiles: [],
      name: '',
      error: '',
      loading: true,
      saving: false,
      deletingName: null,
    });

    try {
      const profiles = await api.listNativeFlashProfiles(target);
      setProfileDialog((current) => current && current.mode === 'load' && current.target === target
        ? { ...current, profiles, loading: false }
        : current);
    } catch (error) {
      setProfileDialog((current) => current && current.mode === 'load' && current.target === target
        ? {
            ...current,
            loading: false,
            error: error instanceof Error ? error.message : 'Failed to load saved flash profiles.',
          }
        : current);
    }
  }

  async function handleSaveAction(target: FlashTargetKey) {
    const saved = await persistConfig(target, true);
    if (!saved) {
      return;
    }

    try {
      const profiles = await api.listNativeFlashProfiles(target);
      setProfileDialog({
        mode: 'save',
        target,
        profiles,
        name: '',
        error: '',
        loading: false,
        saving: false,
        deletingName: null,
      });
    } catch (error) {
      setProfileDialog({
        mode: 'save',
        target,
        profiles: [],
        name: '',
        error: error instanceof Error ? error.message : 'Failed to load saved flash profiles.',
        loading: false,
        saving: false,
        deletingName: null,
      });
    }
  }

  async function handleSaveNamedProfile() {
    if (!profileDialog || profileDialog.mode !== 'save') {
      return;
    }

    const name = profileDialog.name.trim();
    if (!name) {
      setProfileDialog((current) => current ? { ...current, error: 'Enter a unique profile name.' } : current);
      return;
    }

    const target = profileDialog.target;
    const panel = panels[target];
    setProfileDialog((current) => current ? { ...current, saving: true, error: '' } : current);

    try {
      await api.saveNativeFlashProfile(target, {
        name,
        checkoutPath: panel.checkoutPath.trim() || undefined,
        flashDevice: panel.flashDevice.trim() || undefined,
        flashMethod: panel.flashMethod || panel.flashState?.default_flash_method || undefined,
        assignments: buildPanelAssignments(panel.assignmentValues, panel.knownFields, panel.stickyAssignments),
      });
      setPanelMessage(target, `Saved flash profile "${name}" on the host.`, 'success');
      setProfileDialog(null);
    } catch (error) {
      setProfileDialog((current) => current ? {
        ...current,
        saving: false,
        error: error instanceof Error ? error.message : 'Failed to save the flash profile.',
      } : current);
    }
  }

  async function handleLoadSavedProfile(name: string) {
    if (!profileDialog) {
      return;
    }

    const target = profileDialog.target;
    setProfileDialog((current) => current ? { ...current, loading: true, error: '' } : current);
    try {
      const loadedProfile = await api.loadNativeFlashProfile(target, name);
      const savedProfile: SavedFlashTargetProfile = {
        name: loadedProfile.name,
        checkoutPath: loadedProfile.checkout_path,
        flashDevice: loadedProfile.flash_device,
        flashMethod: loadedProfile.flash_method,
        assignments: loadedProfile.assignments,
      };
      await applySavedTargetProfile(target, savedProfile, loadedProfile.name);
      setActiveTarget(target);
      setProfileDialog(null);
    } catch (error) {
      setProfileDialog((current) => current ? {
        ...current,
        loading: false,
        error: error instanceof Error ? error.message : 'Failed to load the selected flash profile.',
      } : current);
    }
  }

  async function handleLoadActiveConfig(target: FlashTargetKey) {
    setProfileDialog((current) => current ? { ...current, loading: true, error: '' } : current);
    await loadState(target, panels[target].checkoutPath);
    setActiveTarget(target);
    setProfileDialog(null);
  }

  async function handleDeleteSavedProfile(name: string) {
    if (!profileDialog) {
      return;
    }
    if (!window.confirm(`Delete flash profile "${name}" from the host?`)) {
      return;
    }

    const target = profileDialog.target;
    setProfileDialog((current) => current ? { ...current, deletingName: name, error: '' } : current);
    try {
      await api.deleteNativeFlashProfile(target, name);
      const profiles = await api.listNativeFlashProfiles(target);
      setProfileDialog((current) => current ? {
        ...current,
        profiles,
        deletingName: null,
      } : current);
      setPanelMessage(target, `Deleted flash profile "${name}".`, 'success');
    } catch (error) {
      setProfileDialog((current) => current ? {
        ...current,
        deletingName: null,
        error: error instanceof Error ? error.message : 'Failed to delete the flash profile.',
      } : current);
    }
  }

  const visibleTargets = TARGETS.filter((target) => target === 'klipper' || panels[target].flashState?.available);

  useEffect(() => {
    if (visibleTargets.length > 0 && !visibleTargets.includes(activeTarget)) {
      setActiveTarget(visibleTargets[0]);
    }
  }, [activeTarget, visibleTargets]);

  const panel = panels[activeTarget];
  const fieldGroups = groupedFields(panel.fields);
  const artifacts = panel.commandResult?.artifacts || panel.flashState?.artifacts || [];
  const primaryArtifact = panel.commandResult?.primary_artifact || panel.flashState?.primary_artifact || null;
  const anyPanelBusy = TARGETS.some((target) => panels[target].status !== 'idle');
  // Preview is a read-only refresh: it must not gate Save/Load/Method/Device.
  const actionBusy = isBusyStatus(panel.status);
  const previewPending = panel.status === 'previewing';
  const buildLabel = panel.status === 'building' ? `Build${buildDots}` : 'Build';
  const flashLabel = panel.status === 'flashing' ? `Flash${flashDots}` : 'Flash';
  const saveLabel = panel.status === 'saving' ? 'Saving...' : 'Save';
  const flashMethodCandidates = panel.flashState?.flash_method_candidates || [];
  const selectedFlashMethod = panel.flashMethod || panel.flashState?.default_flash_method || '';
  const selectedFlashMethodState = flashMethodRecord(panel.flashState, selectedFlashMethod);
  const trimmedFlashDevice = panel.flashDevice.trim();
  const flashDeviceCandidates = mergeDeviceCandidates(
    panel.flashState?.flash_device_candidates || [],
    panel.scannedDeviceCandidates,
  );
  const profileDialogPanel = profileDialog ? panels[profileDialog.target] : null;
  const showFlashDevice = Boolean(
    selectedFlashMethodState
      && (
        selectedFlashMethodState.device_required
        || selectedFlashMethodState.device_placeholder
        || selectedFlashMethodState.default_device
        || flashDeviceCandidates.length > 0
      ),
  );
  const flashDeviceRequired = Boolean(selectedFlashMethodState?.device_required);
  const flashButtonDisabled = Boolean(
    actionBusy
      || !panel.flashState?.available
      || !panel.flashState?.flash_supported
      || !selectedFlashMethodState
      || (flashDeviceRequired && !trimmedFlashDevice),
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="flex max-h-[92vh] w-[1180px] max-w-[96vw] flex-col overflow-hidden rounded-2xl border border-[var(--color-bg-tertiary)] bg-[var(--color-bg-secondary)] shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between border-b border-[var(--color-bg-tertiary)] px-4 py-4">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-base font-semibold text-[var(--color-text-primary)]">Flash</h2>
              <HelpPopover text={FLASH_WORKFLOW_HELP} />
            </div>
            <p className="mt-0.5 text-xs text-[var(--color-text-secondary)]">
              Preview menuconfig changes live, save the active .config, build firmware locally, auto-match the flash method to the selected device, and manage saved flash configs on the host.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setShowTargetSettings((current) => !current)}
              title="Flash checkout settings"
              className={`rounded p-1 transition-colors ${
                showTargetSettings
                  ? 'bg-[var(--color-accent)] text-[var(--color-bg-primary)]'
                  : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-primary)]'
              }`}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.5" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            <button
              onClick={onClose}
              className="rounded p-1 text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)]"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </button>
          </div>
        </div>

        {showTargetSettings && (
          <div className="border-b border-[var(--color-bg-tertiary)] bg-[var(--color-bg-primary)]/70 px-4 py-4">
            <div className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="text-xs font-semibold text-[var(--color-text-primary)]">Checkout Paths</p>
                  <p className="mt-0.5 text-[11px] text-[var(--color-text-secondary)]">
                    Leave a path blank to auto-detect the checkout. Applying paths reloads both targets and refreshes detected flash devices.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => void applyCheckoutSettings()}
                  disabled={anyPanelBusy}
                  className="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-xs font-semibold text-[var(--color-bg-primary)] transition-colors hover:opacity-90 disabled:opacity-50"
                >
                  Apply Paths
                </button>
              </div>

              <div className="grid gap-3 xl:grid-cols-2">
                <div>
                  <label className="mb-1 block text-xs font-medium text-[var(--color-text-secondary)]">Klipper Checkout</label>
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      value={panels.klipper.checkoutPath}
                      onChange={(event) => handleCheckoutPathChange('klipper', event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          void applyCheckoutSettings();
                        }
                      }}
                      placeholder="Auto-detect ~/klipper or enter another checkout path"
                      className="w-full rounded-md border border-[var(--color-bg-tertiary)] bg-[var(--color-bg-secondary)] px-3 py-2 text-xs font-mono text-[var(--color-text-primary)]"
                    />
                    <button
                      type="button"
                      onClick={() => handleCheckoutPathChange('klipper', '')}
                      className="rounded-md bg-[var(--color-bg-tertiary)] px-3 py-2 text-[11px] font-medium text-[var(--color-text-primary)] transition-colors hover:bg-[var(--color-bg-secondary)]"
                    >
                      Auto
                    </button>
                  </div>
                </div>

                <div>
                  <label className="mb-1 block text-xs font-medium text-[var(--color-text-secondary)]">Katapult Checkout</label>
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      value={panels.katapult.checkoutPath}
                      onChange={(event) => handleCheckoutPathChange('katapult', event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          void applyCheckoutSettings();
                        }
                      }}
                      placeholder="Auto-detect ~/katapult or enter another checkout path"
                      className="w-full rounded-md border border-[var(--color-bg-tertiary)] bg-[var(--color-bg-secondary)] px-3 py-2 text-xs font-mono text-[var(--color-text-primary)]"
                    />
                    <button
                      type="button"
                      onClick={() => handleCheckoutPathChange('katapult', '')}
                      className="rounded-md bg-[var(--color-bg-tertiary)] px-3 py-2 text-[11px] font-medium text-[var(--color-text-primary)] transition-colors hover:bg-[var(--color-bg-secondary)]"
                    >
                      Auto
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        <div className="border-b border-[var(--color-bg-tertiary)] px-4 pt-4">
          <div className="flex gap-2">
            {visibleTargets.map((target) => {
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

        <div className="border-b border-[var(--color-bg-tertiary)] px-4 py-3">
          <div className="flex flex-wrap items-center gap-3 xl:flex-nowrap">
            {showFlashDevice && (
              <div className="flex min-w-0 flex-1 items-center gap-2">
                <span className="shrink-0 text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--color-text-secondary)]">
                  Device{flashDeviceRequired ? ' *' : ''}
                </span>
                <div className="min-w-[18rem] flex-1">
                  <FlashDeviceField
                    value={panel.flashDevice}
                    onChange={(value) => handleFlashDeviceChange(activeTarget, value)}
                    placeholder={selectedFlashMethodState?.device_placeholder || 'Optional flash device override'}
                    candidates={flashDeviceCandidates}
                  />
                </div>
                <button
                  type="button"
                  onClick={() => void scanDevices(activeTarget, true)}
                  disabled={actionBusy || panel.devicesScanning}
                  title="Refresh detected flash devices (USB DFU, serial, CAN UUIDs)"
                  className="shrink-0 rounded-md border border-[var(--color-bg-tertiary)] bg-[var(--color-bg-primary)] p-2 text-[var(--color-text-secondary)] transition-colors hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-50"
                  aria-label="Refresh detected flash devices"
                >
                  <svg
                    width="13"
                    height="13"
                    viewBox="0 0 16 16"
                    fill="none"
                    className={panel.devicesScanning ? 'animate-spin' : ''}
                  >
                    <path
                      d="M13.5 8A5.5 5.5 0 1 1 8 2.5a5.48 5.48 0 0 1 3.889 1.611"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                    />
                    <path d="M12 1v3h-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
              </div>
            )}

            <div className="flex shrink-0 items-center gap-2">
              <span className="shrink-0 text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--color-text-secondary)]">
                Method
              </span>
              <div className="w-[190px]">
                <select
                  value={selectedFlashMethod}
                  onChange={(event) => {
                    const nextMethod = event.target.value;
                    updatePanel(activeTarget, (current) => {
                      const currentMethod = current.flashMethod || current.flashState?.default_flash_method || '';
                      const currentMethodState = flashMethodRecord(current.flashState, currentMethod);
                      const nextMethodState = flashMethodRecord(current.flashState, nextMethod);
                      const currentDefaultDevice = currentMethodState?.default_device || '';
                      const nextDefaultDevice = nextMethodState?.default_device || '';
                      const nextFlashDevice = !current.flashDevice || current.flashDevice === currentDefaultDevice
                        ? nextDefaultDevice
                        : current.flashDevice;
                      return {
                        ...current,
                        flashMethod: nextMethod,
                        flashDevice: nextFlashDevice,
                      };
                    });
                  }}
                  disabled={actionBusy || flashMethodCandidates.length === 0}
                  className="w-full rounded-md border border-[var(--color-bg-tertiary)] bg-[var(--color-bg-primary)] px-3 py-2 text-xs text-[var(--color-text-primary)] disabled:opacity-50"
                >
                  {flashMethodCandidates.length === 0 ? (
                    <option value="">No supported flash method</option>
                  ) : (
                    flashMethodCandidates.map((candidate) => (
                      <option key={candidate.value} value={candidate.value}>
                        {candidate.label}
                      </option>
                    ))
                  )}
                </select>
              </div>
              {selectedFlashMethodState && <HelpPopover text={selectedFlashMethodState.description} />}
            </div>

            <div className="ml-auto flex shrink-0 flex-wrap items-center gap-2">
            <button
                onClick={() => void openLoadDialog(activeTarget)}
                disabled={actionBusy}
                className="rounded-md bg-[var(--color-bg-tertiary)] px-4 py-2 text-xs font-medium text-[var(--color-text-primary)] transition-colors hover:bg-[var(--color-bg-primary)] disabled:opacity-50"
              >
                Load
              </button>
              <button
                onClick={() => void handleSaveAction(activeTarget)}
                disabled={actionBusy || !panel.flashState?.available}
                className="rounded-md bg-[var(--color-bg-tertiary)] px-4 py-2 text-xs font-medium text-[var(--color-text-primary)] transition-colors hover:bg-[var(--color-accent)] hover:text-[var(--color-bg-primary)] disabled:opacity-50"
              >
                {saveLabel}
              </button>
              <button
                onClick={() => void handleBuild(activeTarget)}
                disabled={actionBusy || !panel.flashState?.available}
                className="inline-flex min-w-[5.75rem] justify-center rounded-md bg-amber-500 px-4 py-2 text-xs font-semibold text-black transition-colors hover:bg-amber-400 disabled:opacity-50"
              >
                {buildLabel}
              </button>
              <button
                onClick={() => void handleFlash(activeTarget)}
                disabled={flashButtonDisabled}
                className="inline-flex min-w-[5.75rem] justify-center rounded-md bg-emerald-500 px-4 py-2 text-xs font-semibold text-black transition-colors hover:bg-emerald-400 disabled:bg-[var(--color-bg-tertiary)] disabled:text-[var(--color-text-secondary)] disabled:hover:bg-[var(--color-bg-tertiary)]"
              >
                {flashLabel}
              </button>
            </div>
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

              {previewPending && (
                <p className="flex items-center gap-1.5 text-[11px] text-[var(--color-text-secondary)]">
                  <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--color-accent)]" />
                  Updating preview…
                </p>
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
                              <HelpPopover text={field.help} lazyFetch={() => fetchFieldHelp(activeTarget, field.id)} />
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
                              onBlur={() => handleFieldBlur(activeTarget)}
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
                  {selectedFlashMethodState
                    ? selectedFlashMethodState.help
                    : panel.flashState?.flash_supported
                      ? panel.flashState.flash_help || 'A supported flash method is available for the current target.'
                    : panel.flashState?.flash_reason || 'Load a target to see its flashing capabilities.'}
                </p>
              </div>
            </div>

            <div className="flex-1 space-y-4 overflow-y-auto p-4">
              <section className="overflow-hidden rounded-xl border border-[var(--color-bg-tertiary)]">
                <div className="border-b border-[var(--color-bg-tertiary)] bg-[var(--color-bg-primary)]/70 px-4 py-3">
                  <div className="flex items-center gap-2">
                    <h3 className="text-sm font-semibold text-[var(--color-text-primary)]">Artifacts</h3>
                    <HelpPopover text={ARTIFACTS_HELP} />
                  </div>
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
                      <div className="flex shrink-0 items-center gap-2">
                        <button
                          onClick={() => void handleDeleteArtifact(activeTarget, artifact)}
                          className="rounded-md bg-red-500/15 px-3 py-1.5 text-xs font-medium text-red-200 transition-colors hover:bg-red-500/25"
                        >
                          Delete
                        </button>
                        <button
                          onClick={() => void handleDownload(activeTarget, artifact)}
                          className="rounded-md bg-[var(--color-bg-tertiary)] px-3 py-1.5 text-xs font-medium text-[var(--color-text-primary)] transition-colors hover:bg-[var(--color-accent)] hover:text-[var(--color-bg-primary)]"
                        >
                          Download
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </section>

              <section className="flex min-h-[320px] flex-col overflow-hidden rounded-xl border border-[var(--color-bg-tertiary)]">
                <div className="border-b border-[var(--color-bg-tertiary)] bg-[var(--color-bg-primary)]/70 px-4 py-3">
                  <div className="flex items-center gap-2">
                    <h3 className="text-sm font-semibold text-[var(--color-text-primary)]">Command Log</h3>
                    <HelpPopover text={COMMAND_LOG_HELP} />
                  </div>
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
      {profileDialog && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60" onClick={closeProfileDialog}>
          <div
            className="flex max-h-[80vh] w-[760px] max-w-[92vw] flex-col overflow-hidden rounded-2xl border border-[var(--color-bg-tertiary)] bg-[var(--color-bg-secondary)] shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-start justify-between border-b border-[var(--color-bg-tertiary)] px-4 py-4">
              <div>
                <h3 className="text-base font-semibold text-[var(--color-text-primary)]">
                  {profileDialog.mode === 'load'
                    ? `Load ${profileDialog.target === 'klipper' ? 'Klipper' : 'Katapult'} Flash Config`
                    : `Save ${profileDialog.target === 'klipper' ? 'Klipper' : 'Katapult'} Flash Config`}
                </h3>
                <p className="mt-1 text-xs text-[var(--color-text-secondary)]">
                  {profileDialog.mode === 'load'
                    ? 'Load the active checkout config or a saved flash profile from the host, and remove old saved profiles here.'
                    : 'The active .config has been saved. Give this flash configuration a unique name to store it on the host for later reuse.'}
                </p>
              </div>
              <button
                type="button"
                onClick={closeProfileDialog}
                className="rounded p-1 text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)]"
              >
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                  <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
              </button>
            </div>

            <div className="flex-1 space-y-4 overflow-y-auto p-4">
              {profileDialog.error && (
                <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-200">
                  {profileDialog.error}
                </div>
              )}

              {profileDialog.mode === 'load' ? (
                <>
                  <section className="overflow-hidden rounded-xl border border-[var(--color-bg-tertiary)]">
                    <div className="border-b border-[var(--color-bg-tertiary)] bg-[var(--color-bg-primary)]/70 px-4 py-3">
                      <h4 className="text-sm font-semibold text-[var(--color-text-primary)]">Active Config</h4>
                    </div>
                    <div className="p-4">
                      <div className="flex flex-col gap-3 rounded-xl border border-[var(--color-bg-tertiary)] bg-[var(--color-bg-primary)]/50 px-4 py-3 md:flex-row md:items-center md:justify-between">
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-[var(--color-text-primary)]">Current checkout state</p>
                          <p className="mt-1 break-all text-xs font-mono text-[var(--color-text-secondary)]">
                            {profileDialogPanel?.flashState?.config_path || profileDialogPanel?.checkoutPath || 'Auto-detect the active checkout'}
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={() => void handleLoadActiveConfig(profileDialog.target)}
                          disabled={profileDialog.loading}
                          className="rounded-md bg-[var(--color-bg-tertiary)] px-4 py-2 text-xs font-medium text-[var(--color-text-primary)] transition-colors hover:bg-[var(--color-accent)] hover:text-[var(--color-bg-primary)] disabled:opacity-50"
                        >
                          {profileDialog.loading ? 'Loading...' : 'Load Active Config'}
                        </button>
                      </div>
                    </div>
                  </section>

                  <section className="overflow-hidden rounded-xl border border-[var(--color-bg-tertiary)]">
                    <div className="border-b border-[var(--color-bg-tertiary)] bg-[var(--color-bg-primary)]/70 px-4 py-3">
                      <h4 className="text-sm font-semibold text-[var(--color-text-primary)]">Saved Profiles</h4>
                    </div>
                    <div className="space-y-3 p-4">
                      {profileDialog.loading && profileDialog.profiles.length === 0 && (
                        <p className="text-sm text-[var(--color-text-secondary)]">Loading saved profiles...</p>
                      )}
                      {!profileDialog.loading && profileDialog.profiles.length === 0 && (
                        <p className="text-sm text-[var(--color-text-secondary)]">No saved profiles exist for this target yet.</p>
                      )}
                      {profileDialog.profiles.map((profile) => (
                        <div
                          key={profile.name}
                          className="flex flex-col gap-3 rounded-xl border border-[var(--color-bg-tertiary)] bg-[var(--color-bg-primary)]/50 px-4 py-3 md:flex-row md:items-center md:justify-between"
                        >
                          <div className="min-w-0">
                            <p className="text-sm font-medium text-[var(--color-text-primary)]">{profile.name}</p>
                            <p className="mt-1 text-[11px] text-[var(--color-text-secondary)]">
                              {profile.assignment_count} assignment{profile.assignment_count === 1 ? '' : 's'} • saved {formatModified(profile.modified)}
                            </p>
                            <p className="mt-1 break-all text-[11px] font-mono text-[var(--color-text-secondary)]">
                              {profile.checkout_path || 'Auto-detected checkout'}
                            </p>
                          </div>
                          <div className="flex shrink-0 items-center gap-2">
                            <button
                              type="button"
                              onClick={() => void handleDeleteSavedProfile(profile.name)}
                              disabled={profileDialog.deletingName === profile.name || profileDialog.loading}
                              className="rounded-md bg-red-500/15 px-3 py-2 text-xs font-medium text-red-200 transition-colors hover:bg-red-500/25 disabled:opacity-50"
                            >
                              {profileDialog.deletingName === profile.name ? 'Deleting...' : 'Delete'}
                            </button>
                            <button
                              type="button"
                              onClick={() => void handleLoadSavedProfile(profile.name)}
                              disabled={profileDialog.loading}
                              className="rounded-md bg-[var(--color-bg-tertiary)] px-4 py-2 text-xs font-medium text-[var(--color-text-primary)] transition-colors hover:bg-[var(--color-accent)] hover:text-[var(--color-bg-primary)] disabled:opacity-50"
                            >
                              {profileDialog.loading ? 'Loading...' : 'Load'}
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </section>
                </>
              ) : (
                <section className="space-y-4 rounded-xl border border-[var(--color-bg-tertiary)] p-4">
                  <div className="rounded-xl border border-[var(--color-bg-tertiary)] bg-[var(--color-bg-primary)]/50 p-3">
                    <p className="text-sm font-medium text-[var(--color-text-primary)]">Active config saved</p>
                    <p className="mt-1 break-all text-xs font-mono text-[var(--color-text-secondary)]">
                      {profileDialogPanel?.flashState?.config_path || profileDialogPanel?.checkoutPath || 'Active checkout'}
                    </p>
                  </div>

                  <div>
                    <label className="mb-1 block text-xs font-medium text-[var(--color-text-secondary)]">Profile Name</label>
                    <input
                      type="text"
                      value={profileDialog.name}
                      onChange={(event) => setProfileDialog((current) => current ? { ...current, name: event.target.value, error: '' } : current)}
                      placeholder="Enter a unique profile name"
                      className="w-full rounded-md border border-[var(--color-bg-tertiary)] bg-[var(--color-bg-primary)] px-3 py-2 text-sm text-[var(--color-text-primary)]"
                    />
                  </div>

                  <div>
                    <p className="mb-2 text-xs font-medium text-[var(--color-text-secondary)]">Existing Saved Profiles</p>
                    {profileDialog.loading ? (
                      <p className="text-sm text-[var(--color-text-secondary)]">Loading existing profile names...</p>
                    ) : profileDialog.profiles.length === 0 ? (
                      <p className="text-sm text-[var(--color-text-secondary)]">No saved profiles exist for this target yet.</p>
                    ) : (
                      <div className="flex flex-wrap gap-2">
                        {profileDialog.profiles.map((profile) => (
                          <span
                            key={profile.name}
                            className="rounded-full border border-[var(--color-bg-tertiary)] bg-[var(--color-bg-primary)]/50 px-3 py-1 text-xs text-[var(--color-text-secondary)]"
                          >
                            {profile.name}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </section>
              )}
            </div>

            <div className="flex items-center justify-end gap-2 border-t border-[var(--color-bg-tertiary)] px-4 py-3">
              <button
                type="button"
                onClick={closeProfileDialog}
                className="rounded-md bg-[var(--color-bg-tertiary)] px-4 py-2 text-xs font-medium text-[var(--color-text-primary)] transition-colors hover:bg-[var(--color-bg-primary)]"
              >
                Close
              </button>
              {profileDialog.mode === 'save' && (
                <button
                  type="button"
                  onClick={() => void handleSaveNamedProfile()}
                  disabled={profileDialog.saving || profileDialog.loading}
                  className="rounded-md bg-[var(--color-accent)] px-4 py-2 text-xs font-semibold text-[var(--color-bg-primary)] transition-colors hover:opacity-90 disabled:opacity-50"
                >
                  {profileDialog.saving ? 'Saving...' : 'Save Named Profile'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
