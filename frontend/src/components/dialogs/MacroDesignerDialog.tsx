import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useConfigStore } from '../../stores/configStore';
import { useGraphStore } from '../../stores/graphStore';
import { createDefaultDraft, useMacroDesignerStore } from '../../stores/macroDesignerStore';
import * as api from '../../services/api';
import type { ConfigFile } from '../../types/config';
import type {
  MacroDraft,
  MachineProfile,
  MacroRuntimeState,
  MacroSourceItem,
  SimulationStep,
  SimulationTickResult,
} from '../../types/macroDesigner';
import {
  areEquivalentMacroItems,
  buildConfigMacroItemKey,
  createGcodeMacroSection,
  createMachineProfile,
  deriveAvailableBuiltInMacros,
  deriveCurrentMacroItems,
  findMatchingTargetMacroSection,
  findPathZoneHit,
  findZoneHit,
  fuzzyFilterItems,
  getSectionParamValue,
  isMacroItemUnchangedInSection,
  isPointInMoveBounds,
  normalizeMacroGcodeForConfig,
  normalizePlainText,
  parseMacroGcodeFromEditorView,
  sanitizeMacroName,
  serializeMacroVariables,
} from '../../utils/macroDesigner';
import {
  buildSimulationSteps,
  computeTrapezoidalProfile,
  createInitialRuntimeState,
  executeSimulationStep,
  parseParams,
  trapezoidalPositionAtTime,
} from '../../utils/gcodeSimulator';
import { logMacroDesignerEvent } from '../../utils/macroDesignerLog';
import type { TrapezoidalProfile } from '../../utils/gcodeSimulator';

interface MacroDesignerDialogProps {
  onClose: () => void;
}

interface ToolheadPosition {
  x: number;
  y: number;
  z: number;
}

interface MovementTrace {
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
}

interface MoveAnimationState {
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  fromZ: number;
  toZ: number;
  profile: TrapezoidalProfile;
  startTime: number;
  onComplete: () => void;
}

interface ContextMenuState {
  x: number;
  y: number;
  itemKey: string;
  itemSource: string;
  draftId: string | null;
}

interface CanvasContextMenuState {
  x: number;
  y: number;
  target: 'dock' | 'zone';
  zoneId?: string;
}

interface ExactPositionDialogState {
  target: 'dock' | 'zone';
  zoneId?: string;
  x: string;
  y: string;
  width: string;
  height: string;
}

interface DragState {
  type: 'toolhead' | 'dock' | 'zone' | 'zone-resize';
  zoneId?: string;
  fixedCornerX?: number;
  fixedCornerY?: number;
  offsetX: number;
  offsetY: number;
}

interface SimulationLogEntry {
  id: string;
  raw: string;
  sourceName: string;
  lineNumber: number;
  timelineStepIndex: number;
  summary: string;
  warnings: string[];
}

interface SupportedGcodeCommand {
  command: string;
  format: string;
  description: string;
}

interface SimulationTimelineState {
  states: MacroRuntimeState[];
  logs: SimulationLogEntry[];
  lastTraceByStep: Array<MovementTrace | null>;
  zIndicatorByStep: Array<'up' | 'down' | null>;
}

const AXIS_LABELS: Record<number, { tl: string; tr: string; bl: string; br: string }> = {
  0:   { tl: '+Y', tr: '+X', bl: '-X', br: '-Y' },
  90:  { tl: '+X', tr: '-Y', bl: '+Y', br: '-X' },
  180: { tl: '-Y', tr: '-X', bl: '+X', br: '+Y' },
  270: { tl: '-X', tr: '+Y', bl: '-Y', br: '+X' },
};

const SUPPORTED_GCODE_COMMANDS: SupportedGcodeCommand[] = [
  { command: 'G0/G1', format: 'G1 Xnnn Ynnn Znnn Ennn Fnnn', description: 'Linear move / extrusion move.' },
  { command: 'G28', format: 'G28 [X] [Y] [Z]', description: 'Home all axes or selected axes.' },
  { command: 'G90', format: 'G90', description: 'Use absolute positioning.' },
  { command: 'G91', format: 'G91', description: 'Use relative positioning.' },
  { command: 'M82', format: 'M82', description: 'Use absolute extrusion mode.' },
  { command: 'M83', format: 'M83', description: 'Use relative extrusion mode.' },
  { command: 'G92', format: 'G92 Xnnn Ynnn Znnn Ennn', description: 'Set current coordinates/extruder position.' },
  { command: 'M104', format: 'M104 Snnn', description: 'Set nozzle temperature (no wait).' },
  { command: 'M109', format: 'M109 Snnn', description: 'Set nozzle temperature and wait.' },
  { command: 'M140', format: 'M140 Snnn', description: 'Set bed temperature (no wait).' },
  { command: 'M190', format: 'M190 Snnn', description: 'Set bed temperature and wait.' },
  { command: 'M106', format: 'M106 S0-255', description: 'Set fan speed.' },
  { command: 'M107', format: 'M107', description: 'Turn fan off.' },
  { command: 'M84', format: 'M84', description: 'Disable steppers.' },
  { command: 'G4', format: 'G4 Pms', description: 'Dwell for a period.' },
  { command: 'RESPOND', format: 'RESPOND MSG="text"', description: 'Print message in terminal.' },
  { command: 'SET_LED', format: 'SET_LED LED=name RED=r GREEN=g BLUE=b', description: 'Set LED color.' },
  { command: 'SET_FAN_SPEED', format: 'SET_FAN_SPEED FAN=name SPEED=0..1', description: 'Set named fan speed.' },
  { command: 'SET_GCODE_OFFSET', format: 'SET_GCODE_OFFSET X= Y= Z=', description: 'Adjust gcode offset.' },
  { command: 'BED_MESH_CALIBRATE', format: 'BED_MESH_CALIBRATE [PROFILE=name] [METHOD=automatic|manual|scan|rapid_scan]', description: 'Probe and activate a bed mesh using configured or overridden mesh bounds.' },
  { command: 'BED_MESH_PROFILE', format: 'BED_MESH_PROFILE LOAD=name|SAVE=name|REMOVE=name', description: 'Load, save, or remove a saved bed mesh profile.' },
  { command: 'BED_MESH_OUTPUT', format: 'BED_MESH_OUTPUT PGP=0|1', description: 'Print the current mesh and optionally the generated probe points.' },
  { command: 'BED_MESH_MAP', format: 'BED_MESH_MAP', description: 'Serialize the current mesh in JSON form.' },
  { command: 'BED_MESH_CLEAR', format: 'BED_MESH_CLEAR', description: 'Clear the active bed mesh and remove z adjustment.' },
  { command: 'BED_MESH_OFFSET', format: 'BED_MESH_OFFSET X= Y= ZFADE=', description: 'Apply mesh lookup offsets for tool changes and fade compensation.' },
  { command: 'SAVE_GCODE_STATE', format: 'SAVE_GCODE_STATE NAME=name', description: 'Save current gcode state.' },
  { command: 'RESTORE_GCODE_STATE', format: 'RESTORE_GCODE_STATE NAME=name', description: 'Restore saved gcode state.' },
  { command: 'TURN_OFF_HEATERS', format: 'TURN_OFF_HEATERS', description: 'Disable all heaters.' },
  { command: 'FIRMWARE_RESTART', format: 'FIRMWARE_RESTART', description: 'Restart firmware.' },
  { command: 'RESTART', format: 'RESTART', description: 'Restart host and firmware.' },
];

const PLAYBACK_ITEM_KEY = 'playback:loaded';

function createStandaloneDraftItem(draft: MacroDraft): MacroSourceItem {
  return {
    key: `draft:${draft.id}`,
    source: 'draft',
    title: draft.title,
    renameExisting: draft.renameExisting,
    description: draft.description,
    variables: draft.variables,
    gcode: draft.gcode,
    draftId: draft.id,
    isDraft: true,
  };
}

function getMacroItemBadges(item: MacroSourceItem): string[] {
  const badges: string[] = [];
  if (item.isDraft || item.source === 'draft') {
    badges.push('Draft');
  }
  if (item.source === 'config') {
    if (item.sourceFile && typeof item.sourceLine === 'number' && item.sourceLine > 0) {
      badges.push(`${item.sourceFile}:${item.sourceLine}`);
    } else if (item.sourceFile) {
      badges.push(item.sourceFile);
    } else {
      badges.push('Config');
    }
  }
  return badges;
}

function formatNumber(value: number): string {
  if (value == null || !Number.isFinite(value)) return '0';
  return Number.isInteger(value) ? `${value}` : value.toFixed(2);
}

function formatCoordinate(value: number): string {
  if (value == null || !Number.isFinite(value)) return '0.00';
  const normalized = Math.abs(value) < 0.005 ? 0 : value;
  return normalized.toFixed(2);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function rotatePoint(x: number, y: number, profile: MachineProfile, rotation: 0 | 90 | 180 | 270) {
  const dx = x - profile.centerX;
  const dy = y - profile.centerY;
  switch (rotation) {
    case 90:
      return { x: profile.centerX - dy, y: profile.centerY + dx };
    case 180:
      return { x: profile.centerX - dx, y: profile.centerY - dy };
    case 270:
      return { x: profile.centerX + dy, y: profile.centerY - dx };
    default:
      return { x, y };
  }
}

function unrotatePoint(x: number, y: number, profile: MachineProfile, rotation: 0 | 90 | 180 | 270) {
  const reverse = rotation === 90 ? 270 : rotation === 270 ? 90 : rotation;
  return rotatePoint(x, y, profile, reverse);
}

function getRotatedBounds(
  rMinX: number, rMaxX: number, rMinY: number, rMaxY: number,
  profile: MachineProfile, rotation: 0 | 90 | 180 | 270,
) {
  const corners = [
    rotatePoint(rMinX, rMinY, profile, rotation),
    rotatePoint(rMaxX, rMinY, profile, rotation),
    rotatePoint(rMaxX, rMaxY, profile, rotation),
    rotatePoint(rMinX, rMaxY, profile, rotation),
  ];
  return {
    minX: Math.min(...corners.map(c => c.x)),
    maxX: Math.max(...corners.map(c => c.x)),
    minY: Math.min(...corners.map(c => c.y)),
    maxY: Math.max(...corners.map(c => c.y)),
  };
}

function clientToMachine(
  event: { clientX: number; clientY: number },
  svgEl: SVGSVGElement,
  profile: MachineProfile,
  rotation: 0 | 90 | 180 | 270,
  viewMaxY: number,
): { x: number; y: number } {
  const pt = svgEl.createSVGPoint();
  pt.x = event.clientX;
  pt.y = event.clientY;
  const ctm = svgEl.getScreenCTM();
  if (!ctm) return { x: 0, y: 0 };
  const svgPt = pt.matrixTransform(ctm.inverse());
  const rotatedX = svgPt.x;
  const rotatedY = viewMaxY - svgPt.y;
  return unrotatePoint(rotatedX, rotatedY, profile, rotation);
}

function getStepSource(step: SimulationStep): { raw: string; sourceName: string; lineNumber: number } {
  if (step.kind === 'command') {
    return {
      raw: step.command.raw,
      sourceName: step.command.sourceName,
      lineNumber: step.command.lineNumber,
    };
  }
  return {
    raw: step.raw,
    sourceName: step.sourceName,
    lineNumber: step.lineNumber,
  };
}

function createSimulationLogEntry(
  step: SimulationStep,
  currentStepIndex: number,
  result: SimulationTickResult,
): SimulationLogEntry | null {
  if (step.kind === 'move' && /^(travel to|sample retract|sample return)/i.test(step.raw)) {
    return null;
  }
  const source = getStepSource(step);
  return {
    id: `${currentStepIndex}-${source.sourceName}-${source.lineNumber}`,
    raw: source.raw,
    sourceName: source.sourceName,
    lineNumber: source.lineNumber,
    timelineStepIndex: currentStepIndex + 1,
    summary: result.eventSummary,
    warnings: result.warnings,
  };
}

export default function MacroDesignerDialog({ onClose }: MacroDesignerDialogProps) {
  const configFiles = useConfigStore((state) => state.configFiles);
  const activeFile = useConfigStore((state) => state.activeFile);
  const originalTexts = useConfigStore((state) => state.originalTexts);
  const upsertSection = useConfigStore((state) => state.upsertSection);
  const drafts = useMacroDesignerStore((state) => state.drafts);
  const rotation = useMacroDesignerStore((state) => state.rotation);
  const noGoZones = useMacroDesignerStore((state) => state.noGoZones);
  const dockPosition = useMacroDesignerStore((state) => state.dockPosition);
  const createDraft = useMacroDesignerStore((state) => state.createDraft);
  const upsertDraftForSourceKey = useMacroDesignerStore((state) => state.upsertDraftForSourceKey);
  const updateDraft = useMacroDesignerStore((state) => state.updateDraft);
  const duplicateDraft = useMacroDesignerStore((state) => state.duplicateDraft);
  const deleteDraft = useMacroDesignerStore((state) => state.deleteDraft);
  const setRotation = useMacroDesignerStore((state) => state.setRotation);
  const addNoGoZone = useMacroDesignerStore((state) => state.addNoGoZone);
  const updateNoGoZone = useMacroDesignerStore((state) => state.updateNoGoZone);
  const deleteNoGoZone = useMacroDesignerStore((state) => state.deleteNoGoZone);
  const setDockPosition = useMacroDesignerStore((state) => state.setDockPosition);

  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [playbackItem, setPlaybackItem] = useState<MacroSourceItem | null>(null);
  const [search, setSearch] = useState('');
  const [showBuiltIns, setShowBuiltIns] = useState(true);
  const [showExitDialog, setShowExitDialog] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [savedConfigFiles, setSavedConfigFiles] = useState<Record<string, ConfigFile>>({});
  const [targetFile, setTargetFile] = useState(() => (configFiles['printer.cfg'] ? 'printer.cfg' : activeFile));
  const [exitTargetOverrides, setExitTargetOverrides] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [runtime, setRuntime] = useState<MacroRuntimeState | null>(null);
  const [stepIndex, setStepIndex] = useState(0);
  const [planWarnings, setPlanWarnings] = useState<string[]>([]);
  const [simulationParamsInput, setSimulationParamsInput] = useState('');
  const [isRunning, setIsRunning] = useState(false);
  const [moveFeedRate, setMoveFeedRate] = useState('');
  const [nozzleTarget, setNozzleTarget] = useState('200');
  const [bedTarget, setBedTarget] = useState('60');
  const [fanPercent, setFanPercent] = useState('100');
  const [ledName, setLedName] = useState('status_led');
  const [ledColor, setLedColor] = useState('#00ffaa');
  const [terminalMessage, setTerminalMessage] = useState('Macro designer');
  const [extrudeDistance, setExtrudeDistance] = useState('1.0');
  const [extrudeFeedRate, setExtrudeFeedRate] = useState('600');
  const [commandSearch, setCommandSearch] = useState('');
  const [showCommandPicker, setShowCommandPicker] = useState(false);
  const [moveMode, setMoveMode] = useState<'absolute' | 'relative'>('absolute');
  const runtimeMoveMode: 'absolute' | 'relative' = runtime?.absoluteMoves === false ? 'relative' : 'absolute';
  const activeMoveMode: 'absolute' | 'relative' = editMode ? moveMode : runtimeMoveMode;
  const [zMoveIndicator, setZMoveIndicator] = useState<'up' | 'down' | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [canvasContextMenu, setCanvasContextMenu] = useState<CanvasContextMenuState | null>(null);
  const [dragState, setDragState] = useState<DragState | null>(null);
  const [toolheadDragPos, setToolheadDragPos] = useState<ToolheadPosition | null>(null);
  const [lastMovementTrace, setLastMovementTrace] = useState<MovementTrace | null>(null);
  const [simulationZIndicator, setSimulationZIndicator] = useState<'up' | 'down' | null>(null);
  const [isAnimating, setIsAnimating] = useState(false);
  const [editDraft, setEditDraft] = useState<MacroSourceItem | null>(null);
  const [runtimeHistory, setRuntimeHistory] = useState<MacroRuntimeState[]>([]);
  const [simulationLog, setSimulationLog] = useState<SimulationLogEntry[]>([]);
  const [selectedLogWarning, setSelectedLogWarning] = useState<string | null>(null);
  const [goToX, setGoToX] = useState('');
  const [goToY, setGoToY] = useState('');
  const [goToZ, setGoToZ] = useState('');
  const [selectedZoneId, setSelectedZoneId] = useState<string | null>(null);
  const [isDockSelected, setIsDockSelected] = useState(false);
  const [exactPositionDialog, setExactPositionDialog] = useState<ExactPositionDialogState | null>(null);
  const playbackFileInputRef = useRef<HTMLInputElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const executionOutputRef = useRef<HTMLDivElement>(null);
  const toolheadPositionRef = useRef<ToolheadPosition | null>(null);
  const zWheelStartRef = useRef<ToolheadPosition | null>(null);
  const zWheelTimeoutRef = useRef<number | null>(null);
  const moveAnimationRef = useRef<MoveAnimationState | null>(null);
  const animFrameRef = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    const loadSavedConfigs = async () => {
      const entries = Object.entries(originalTexts);
      if (entries.length === 0) {
        setSavedConfigFiles(configFiles);
        return;
      }
      try {
        const results = await Promise.all(entries.map(async ([filename, text]) => {
          const parsed = await api.parseConfigText(text, filename);
          return [filename, parsed.config] as const;
        }));
        if (!cancelled) {
          setSavedConfigFiles(Object.fromEntries(results));
        }
      } catch {
        if (!cancelled) {
          setSavedConfigFiles(configFiles);
        }
      }
    };
    void loadSavedConfigs();
    return () => {
      cancelled = true;
    };
  }, [configFiles, originalTexts]);

  const baseConfigMacroItems = useMemo(() => deriveCurrentMacroItems(configFiles), [configFiles]);
  const standaloneDraftItems = useMemo<MacroSourceItem[]>(
    () => drafts.filter((draft) => !draft.sourceKey).map((draft) => createStandaloneDraftItem(draft)),
    [drafts],
  );
  const draftOverlaysBySourceKey = useMemo(
    () => drafts.reduce<Map<string, MacroDraft>>((map, draft) => {
      if (draft.sourceKey) {
        map.set(draft.sourceKey, draft);
      }
      return map;
    }, new Map()),
    [drafts],
  );
  const configMacroItems = useMemo(
    () => baseConfigMacroItems.map((item) => {
      const draft = draftOverlaysBySourceKey.get(item.key);
      if (!draft) return item;
      return {
        ...item,
        title: draft.title,
        renameExisting: draft.renameExisting,
        description: draft.description,
        variables: draft.variables,
        gcode: draft.gcode,
        draftId: draft.id,
        isDraft: true,
      } satisfies MacroSourceItem;
    }),
    [baseConfigMacroItems, draftOverlaysBySourceKey],
  );
  const builtInItems = useMemo(() => deriveAvailableBuiltInMacros(savedConfigFiles), [savedConfigFiles]);

  useEffect(() => {
    if (!selectedKey) {
      const firstDraft = standaloneDraftItems[0];
      const firstConfigMacro = configMacroItems[0];
      const first = firstDraft ? firstDraft.key : firstConfigMacro?.key || null;
      setSelectedKey(first);
    }
  }, [configMacroItems, selectedKey, standaloneDraftItems]);

  useEffect(() => {
    if (!editMode) {
      setMoveMode(runtimeMoveMode);
    }
  }, [editMode, runtimeMoveMode]);

  const visibleDraftItems = useMemo(() => fuzzyFilterItems(standaloneDraftItems, search), [search, standaloneDraftItems]);
  const visibleConfigItems = useMemo(() => fuzzyFilterItems(configMacroItems, search), [configMacroItems, search]);
  const visibleBuiltIns = useMemo(() => fuzzyFilterItems(builtInItems, search), [builtInItems, search]);
  const visibleSupportedCommands = useMemo(
    () => fuzzyFilterItems(
      SUPPORTED_GCODE_COMMANDS.map((item) => ({ ...item, title: item.command, gcode: item.format })),
      commandSearch,
    ),
    [commandSearch],
  );
  const allMacroItems = useMemo(
    () => (playbackItem
      ? [playbackItem, ...standaloneDraftItems, ...configMacroItems, ...builtInItems]
      : [...standaloneDraftItems, ...configMacroItems, ...builtInItems]),
    [builtInItems, configMacroItems, playbackItem, standaloneDraftItems],
  );

  const selectedItem = useMemo(() => {
    if (!selectedKey) return null;
    return allMacroItems.find((item) => item.key === selectedKey) || null;
  }, [allMacroItems, selectedKey]);

  const baseSelectedConfigItem = useMemo(
    () => (selectedKey ? baseConfigMacroItems.find((item) => item.key === selectedKey) || null : null),
    [baseConfigMacroItems, selectedKey],
  );

  const displayedItem = editMode && editDraft ? editDraft : selectedItem;

  const machineProfile = useMemo(() => createMachineProfile(configFiles, noGoZones, dockPosition), [configFiles, dockPosition, noGoZones]);

  const selectedZone = useMemo(
    () => (selectedZoneId ? noGoZones.find((zone) => zone.id === selectedZoneId) || null : null),
    [noGoZones, selectedZoneId],
  );

  const viewBounds = useMemo(() => {
    const padding = 5;
    const rb = getRotatedBounds(
      machineProfile.moveMinX, machineProfile.moveMaxX,
      machineProfile.moveMinY, machineProfile.moveMaxY,
      machineProfile, rotation,
    );
    return {
      svgX: rb.minX - padding,
      svgY: -padding,
      svgW: rb.maxX - rb.minX + 2 * padding,
      svgH: rb.maxY - rb.minY + 2 * padding,
      viewMaxY: rb.maxY,
      padding,
    };
  }, [machineProfile, rotation]);

  const toSvg = useCallback((mx: number, my: number) => {
    const r = rotatePoint(mx, my, machineProfile, rotation);
    return { x: r.x, y: viewBounds.viewMaxY - r.y };
  }, [machineProfile, rotation, viewBounds.viewMaxY]);

  const simulationRootParams = useMemo(() => parseParams(simulationParamsInput.trim().split(/\s+/)), [simulationParamsInput]);

  const simulationPlan = useMemo(() => {
    if (!selectedItem) {
      return { steps: [], warnings: [] };
    }
    return buildSimulationSteps(selectedItem, allMacroItems, machineProfile, configFiles, {
      params: simulationRootParams,
      rawparams: simulationParamsInput.trim(),
    });
  }, [allMacroItems, configFiles, machineProfile, selectedItem, simulationRootParams, simulationParamsInput]);

  const simulationTimeline = useMemo<SimulationTimelineState>(() => {
    if (!selectedItem) {
      return {
        states: [],
        logs: [],
        lastTraceByStep: [null],
        zIndicatorByStep: [null],
      };
    }

    const initialRuntime = createInitialRuntimeState(machineProfile, selectedItem.title);
    const states: MacroRuntimeState[] = [initialRuntime];
    const logs: SimulationLogEntry[] = [];
    const lastTraceByStep: Array<MovementTrace | null> = [null];
    const zIndicatorByStep: Array<'up' | 'down' | null> = [null];
    let currentRuntime = initialRuntime;
    let lastTrace: MovementTrace | null = null;

    simulationPlan.steps.forEach((step, index) => {
      const result = executeSimulationStep(currentRuntime, step, machineProfile, configFiles);
      const xyMoved = Math.abs(result.nextState.x - currentRuntime.x) > 1e-6 || Math.abs(result.nextState.y - currentRuntime.y) > 1e-6;
      const zDelta = result.nextState.z - currentRuntime.z;
      const zIndicator: 'up' | 'down' | null = zDelta > 1e-6 ? 'up' : zDelta < -1e-6 ? 'down' : null;

      if (xyMoved) {
        lastTrace = {
          fromX: currentRuntime.x,
          fromY: currentRuntime.y,
          toX: result.nextState.x,
          toY: result.nextState.y,
        };
      }

      const logEntry = createSimulationLogEntry(step, index, result);
      if (logEntry) {
        logs.push(logEntry);
      }
      currentRuntime = result.nextState;
      states.push(currentRuntime);
      lastTraceByStep.push(lastTrace);
      zIndicatorByStep.push(zIndicator);
    });

    return {
      states,
      logs,
      lastTraceByStep,
      zIndicatorByStep,
    };
  }, [machineProfile, selectedItem, simulationPlan.steps]);

  const cancelAnimation = useCallback((skipCompletion = false) => {
    if (animFrameRef.current !== null) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = null;
    }
    const anim = moveAnimationRef.current;
    if (anim) {
      moveAnimationRef.current = null;
      setIsAnimating(false);
      if (!skipCompletion) {
        anim.onComplete();
      }
    }
  }, []);

  const syncSimulationPosition = useCallback((requestedStepIndex: number) => {
    cancelAnimation(true);
    setIsRunning(false);
    setToolheadDragPos(null);
    setSelectedLogWarning(null);

    if (!selectedItem || simulationTimeline.states.length === 0) {
      setRuntime(null);
      setRuntimeHistory([]);
      setSimulationLog([]);
      setLastMovementTrace(null);
      setSimulationZIndicator(null);
      setStepIndex(0);
      return;
    }

    const boundedStepIndex = Math.max(0, Math.min(simulationPlan.steps.length, Math.round(requestedStepIndex)));
    setRuntime(simulationTimeline.states[boundedStepIndex] || simulationTimeline.states[0] || null);
    setRuntimeHistory(simulationTimeline.states.slice(0, boundedStepIndex));
    setSimulationLog(simulationTimeline.logs.slice(0, boundedStepIndex));
    setLastMovementTrace(simulationTimeline.lastTraceByStep[boundedStepIndex] || null);
    setSimulationZIndicator(simulationTimeline.zIndicatorByStep[boundedStepIndex] || null);
    setStepIndex(boundedStepIndex);
  }, [cancelAnimation, selectedItem, simulationPlan.steps.length, simulationTimeline]);

  useEffect(() => {
    cancelAnimation(true);
    setPlanWarnings(simulationPlan.warnings);
    setRuntime(selectedItem ? (simulationTimeline.states[0] || createInitialRuntimeState(machineProfile, selectedItem.title)) : null);
    setRuntimeHistory([]);
    setSimulationLog([]);
    setLastMovementTrace(null);
    setSimulationZIndicator(null);
    setSelectedLogWarning(null);
    setStepIndex(0);
    setIsRunning(false);
  }, [cancelAnimation, machineProfile, selectedItem, simulationPlan.warnings, simulationTimeline.states]);

  useEffect(() => {
    setToolheadDragPos(null);
    setEditMode(false);
    setEditDraft(null);
  }, [selectedKey]);

  useEffect(() => {
    if (editMode && selectedItem && !editDraft) {
      setEditDraft({ ...selectedItem });
    }
  }, [editDraft, editMode, selectedItem]);

  useEffect(() => {
    toolheadPositionRef.current = toolheadDragPos || (runtime ? { x: runtime.x, y: runtime.y, z: runtime.z } : null);
  }, [runtime, toolheadDragPos]);

  useEffect(() => {
    if (!selectedZoneId || noGoZones.some((zone) => zone.id === selectedZoneId)) return;
    setSelectedZoneId(noGoZones[0]?.id || null);
  }, [noGoZones, selectedZoneId]);

  useEffect(() => {
    const output = executionOutputRef.current;
    if (!output) return;
    output.scrollTop = output.scrollHeight;
  }, [simulationLog]);

  useEffect(() => {
    if (selectedZoneId) {
      setIsDockSelected(false);
    }
  }, [selectedZoneId]);

  useEffect(() => {
    if (!exactPositionDialog) {
      return;
    }
    if (exactPositionDialog.target === 'dock' && !dockPosition) {
      setExactPositionDialog(null);
      return;
    }
    if (exactPositionDialog.target === 'zone' && !noGoZones.some((zone) => zone.id === exactPositionDialog.zoneId)) {
      setExactPositionDialog(null);
    }
  }, [dockPosition, exactPositionDialog, noGoZones]);

  useEffect(() => () => {
    if (zWheelTimeoutRef.current !== null) {
      window.clearTimeout(zWheelTimeoutRef.current);
    }
    if (animFrameRef.current !== null) {
      cancelAnimationFrame(animFrameRef.current);
    }
  }, []);

  const animateTick = useCallback(() => {
    const anim = moveAnimationRef.current;
    if (!anim) return;
    const elapsed = (performance.now() - anim.startTime) / 1000;
    if (elapsed >= anim.profile.totalTime) {
      moveAnimationRef.current = null;
      animFrameRef.current = null;
      setIsAnimating(false);
      anim.onComplete();
      return;
    }
    const distanceCovered = trapezoidalPositionAtTime(anim.profile, elapsed);
    const fraction = anim.profile.totalDist > 0 ? distanceCovered / anim.profile.totalDist : 1;
    const x = anim.fromX + (anim.toX - anim.fromX) * fraction;
    const y = anim.fromY + (anim.toY - anim.fromY) * fraction;
    const z = anim.fromZ + (anim.toZ - anim.fromZ) * fraction;
    setToolheadDragPos({ x, y, z });
    animFrameRef.current = requestAnimationFrame(animateTick);
  }, []);

  const executeStepWithAnimation = useCallback((currentRuntime: MacroRuntimeState, currentStepIndex: number) => {
    const step = simulationPlan.steps[currentStepIndex];
    if (!step) {
      setIsRunning(false);
      return;
    }
    const result = executeSimulationStep(currentRuntime, step, machineProfile, configFiles);
    const xyMoved = Math.abs(result.nextState.x - currentRuntime.x) > 1e-6 || Math.abs(result.nextState.y - currentRuntime.y) > 1e-6;
    const zDelta = result.nextState.z - currentRuntime.z;
    const zIndicator: 'up' | 'down' | null = zDelta > 1e-6 ? 'up' : zDelta < -1e-6 ? 'down' : null;
    const logEntry = createSimulationLogEntry(step, currentStepIndex, result);
    const trace: MovementTrace | null = xyMoved ? {
      fromX: currentRuntime.x,
      fromY: currentRuntime.y,
      toX: result.nextState.x,
      toY: result.nextState.y,
    } : null;

    const applyFinalState = () => {
      setRuntimeHistory((prev) => [...prev, currentRuntime]);
      setRuntime(result.nextState);
      if (logEntry) {
        setSimulationLog((prev) => [...prev, logEntry]);
      }
      if (trace) setLastMovementTrace(trace);
      setSimulationZIndicator(zIndicator);
      setStepIndex(currentStepIndex + 1);
      setToolheadDragPos(null);
    };

    const distance = Math.sqrt(
      (result.nextState.x - currentRuntime.x) ** 2
      + (result.nextState.y - currentRuntime.y) ** 2
      + (result.nextState.z - currentRuntime.z) ** 2,
    );

    if (xyMoved && distance > 0.5) {
      const profile = computeTrapezoidalProfile(
        distance,
        result.nextState.feedRate,
        machineProfile.maxVelocity,
        machineProfile.maxAccel,
      );
      if (profile.totalTime > 0.016) {
        if (trace) setLastMovementTrace(trace);
        setSimulationZIndicator(zIndicator);
        setIsAnimating(true);
        moveAnimationRef.current = {
          fromX: currentRuntime.x,
          fromY: currentRuntime.y,
          toX: result.nextState.x,
          toY: result.nextState.y,
          fromZ: currentRuntime.z,
          toZ: result.nextState.z,
          profile,
          startTime: performance.now(),
          onComplete: applyFinalState,
        };
        animFrameRef.current = requestAnimationFrame(animateTick);
        return;
      }
    }
    applyFinalState();
  }, [animateTick, machineProfile, simulationPlan.steps]);

  // Auto-play: chain steps via animation-aware effect
  useEffect(() => {
    if (!isRunning || !runtime || isAnimating) return;
    if (stepIndex >= simulationPlan.steps.length) {
      setIsRunning(false);
      return;
    }
    const id = window.setTimeout(() => {
      executeStepWithAnimation(runtime, stepIndex);
    }, 50);
    return () => window.clearTimeout(id);
  }, [isRunning, runtime, stepIndex, isAnimating, executeStepWithAnimation, simulationPlan.steps.length]);

  useEffect(() => {
    if (selectedItem?.source === 'config' && selectedItem.sourceFile && configFiles[selectedItem.sourceFile]) {
      setTargetFile(selectedItem.sourceFile);
      return;
    }
    if (Object.keys(configFiles).length > 0) {
      setTargetFile((current) => {
        if (configFiles[current]) return current;
        if (configFiles['printer.cfg']) return 'printer.cfg';
        return activeFile;
      });
    }
  }, [activeFile, configFiles, selectedItem]);

  // Dismiss context menu on click anywhere
  useEffect(() => {
    if (!contextMenu) return;
    const handler = () => setContextMenu(null);
    window.addEventListener('click', handler);
    return () => window.removeEventListener('click', handler);
  }, [contextMenu]);

  useEffect(() => {
    if (!canvasContextMenu) return;
    const handler = () => setCanvasContextMenu(null);
    window.addEventListener('click', handler);
    return () => window.removeEventListener('click', handler);
  }, [canvasContextMenu]);

  const selectedDraftId = selectedItem?.draftId || (selectedItem?.source === 'draft' ? selectedItem.key.replace(/^draft:/, '') : null);

  const pendingExitItems = useMemo(() => {
    const itemsByDraftId = new Map<string, MacroSourceItem>();
    for (const item of standaloneDraftItems) {
      if (item.draftId) {
        itemsByDraftId.set(item.draftId, item);
      }
    }
    for (const item of configMacroItems) {
      if (item.draftId) {
        itemsByDraftId.set(item.draftId, item);
      }
    }
    return drafts
      .map((draft) => itemsByDraftId.get(draft.id) || null)
      .filter((item): item is MacroSourceItem => item !== null);
  }, [configMacroItems, drafts, standaloneDraftItems]);

  const getDefaultTargetFile = useCallback((item: MacroSourceItem) => {
    if (item.sourceFile && configFiles[item.sourceFile]) {
      return item.sourceFile;
    }
    if (targetFile && configFiles[targetFile]) {
      return targetFile;
    }
    if (configFiles['printer.cfg']) {
      return 'printer.cfg';
    }
    if (activeFile && configFiles[activeFile]) {
      return activeFile;
    }
    return Object.keys(configFiles)[0] || '';
  }, [activeFile, configFiles, targetFile]);

  const getMacroActionState = useCallback((item: MacroSourceItem | null, destinationFile: string) => {
    if (!item || !destinationFile || !configFiles[destinationFile]) {
      return { disabled: true, label: 'Add to configuration' };
    }
    if (item.source === 'playback') {
      return { disabled: true, label: 'Playback only' };
    }
    if (item.source === 'builtin') {
      return { disabled: true, label: 'Add to configuration' };
    }

    const existingTargetSection = findMatchingTargetMacroSection(configFiles, item, destinationFile);
    if (!existingTargetSection) {
      return { disabled: false, label: 'Add to configuration' };
    }
    if (isMacroItemUnchangedInSection(item, existingTargetSection)) {
      return { disabled: true, label: 'Already applied' };
    }
    return { disabled: false, label: 'Apply Changes' };
  }, [configFiles]);

  const getExitTargetFile = useCallback((item: MacroSourceItem) => {
    const override = exitTargetOverrides[item.key];
    if (override && configFiles[override]) {
      return override;
    }
    return getDefaultTargetFile(item);
  }, [configFiles, exitTargetOverrides, getDefaultTargetFile]);

  const addToConfigurationState = useMemo(
    () => getMacroActionState(selectedItem, targetFile),
    [getMacroActionState, selectedItem, targetFile],
  );

  const persistCurrentEditDraft = useCallback(() => {
    if (!editDraft || !selectedItem || !selectedKey) {
      return false;
    }

    if (selectedItem.source === 'draft' && selectedDraftId) {
      updateDraft(selectedDraftId, {
        title: editDraft.title,
        renameExisting: editDraft.renameExisting,
        description: editDraft.description,
        variables: editDraft.variables,
        gcode: editDraft.gcode,
      });
    } else if (selectedItem.source === 'config') {
      if (baseSelectedConfigItem && areEquivalentMacroItems(editDraft, baseSelectedConfigItem)) {
        if (selectedDraftId) {
          deleteDraft(selectedDraftId);
        }
      } else {
        upsertDraftForSourceKey(selectedKey, {
          title: editDraft.title,
          renameExisting: editDraft.renameExisting,
          description: editDraft.description,
          variables: editDraft.variables,
          gcode: editDraft.gcode,
        });
      }
    } else {
      const draft = createDraft(editDraft.title, {
        title: editDraft.title,
        renameExisting: editDraft.renameExisting,
        description: editDraft.description,
        variables: editDraft.variables,
        gcode: editDraft.gcode,
      });
      setSelectedKey(`draft:${draft.id}`);
    }

    setEditMode(false);
    setEditDraft(null);
    setMessage(null);
    return true;
  }, [
    baseSelectedConfigItem,
    createDraft,
    deleteDraft,
    editDraft,
    selectedDraftId,
    selectedItem,
    selectedKey,
    updateDraft,
    upsertDraftForSourceKey,
  ]);

  const applyMacroItemToConfiguration = useCallback((item: MacroSourceItem, destinationFile: string) => {
    if (!destinationFile || !configFiles[destinationFile]) {
      return false;
    }

    const existingTargetSection = findMatchingTargetMacroSection(configFiles, item, destinationFile);
    const macroSection = createGcodeMacroSection(item, existingTargetSection);
    if (existingTargetSection && isMacroItemUnchangedInSection(item, existingTargetSection)) {
      return false;
    }

    const existingGcode = getSectionParamValue(existingTargetSection || undefined, 'gcode');
    const existingRename = getSectionParamValue(existingTargetSection || undefined, 'rename_existing');
    const existingDescription = getSectionParamValue(existingTargetSection || undefined, 'description');
    const existingVariables = existingTargetSection ? serializeMacroVariables(existingTargetSection) : '';
    const selectedGcode = normalizeMacroGcodeForConfig(item.gcode);
    const sameHeader = existingTargetSection?.full_header === macroSection.full_header;
    const structuralChanged = normalizePlainText(existingRename) !== normalizePlainText(item.renameExisting)
      || normalizePlainText(existingDescription) !== normalizePlainText(item.description)
      || normalizePlainText(existingVariables) !== normalizePlainText(item.variables);

    if (existingTargetSection && sameHeader) {
      if (structuralChanged || existingGcode !== selectedGcode) {
        upsertSection(
          destinationFile,
          macroSection,
          existingTargetSection.full_header,
          existingTargetSection.line_number,
        );
      }
    } else {
      upsertSection(
        destinationFile,
        macroSection,
        existingTargetSection?.full_header,
        existingTargetSection?.line_number,
      );
    }

    logMacroDesignerEvent({
      event: 'apply',
      title: item.title,
      destinationFile,
      action: existingTargetSection ? (sameHeader ? 'update' : 'rename') : 'add',
      structuralChanged: Boolean(existingTargetSection) && structuralChanged,
      gcodeChanged: Boolean(existingTargetSection) && existingGcode !== selectedGcode,
      headerComments: macroSection.header_comments.length,
      trailingComments: macroSection.trailing_comments?.length ?? 0,
      targetLine: macroSection.line_number,
      source: item.source,
    });

    const graphStore = useGraphStore.getState();
    const alreadyInGraph = graphStore.nodes.some((node) => {
      const data = node.data as Record<string, unknown>;
      if (data.sectionHeader === macroSection.full_header && data.configFile === destinationFile) {
        return true;
      }
      const children = data.children as Array<{ sectionHeader?: string; configFile?: string }> | undefined;
      return !!children?.some((child) => child.sectionHeader === macroSection.full_header && child.configFile === destinationFile);
    });
    if (!alreadyInGraph) {
      const basename = (value: string) => value.replace(/^.*[\\/]/, '');
      const hardwareNodes = graphStore.nodes.filter((node) => node.type === 'hardware');
      const nonSbcHardwareNodes = hardwareNodes.filter(
        (node) => (node.data as Record<string, unknown>).hardwareType !== 'sbc',
      );
      const findHardwareForFile = (filename: string) => nonSbcHardwareNodes.find((node) => {
        const nodeFile = (node.data as Record<string, unknown>).configFile as string | undefined;
        return !!nodeFile && (nodeFile === filename || basename(nodeFile) === basename(filename));
      });
      const findIncludingFile = (filename: string): string | null => {
        const targetBase = basename(filename);
        for (const [candidateFile, config] of Object.entries(configFiles)) {
          if (config.includes.some((includePath) => includePath === filename || basename(includePath) === targetBase)) {
            return candidateFile;
          }
        }
        return null;
      };

      let ownerFile: string | null = destinationFile;
      const visitedFiles = new Set<string>();
      let parent = ownerFile ? findHardwareForFile(ownerFile) : undefined;

      while (!parent && ownerFile && !visitedFiles.has(ownerFile)) {
        visitedFiles.add(ownerFile);
        ownerFile = findIncludingFile(ownerFile);
        parent = ownerFile ? findHardwareForFile(ownerFile) : undefined;
      }

      parent = parent
        || nonSbcHardwareNodes.find((node) => !!(node.data as Record<string, unknown>).isPrimary)
        || nonSbcHardwareNodes[0]
        || hardwareNodes[0];
      if (parent) {
        graphStore.addFeatureNode(parent.id, 'gcode_macro', macroSection.section_name, macroSection.full_header, destinationFile);
        const parentData = parent.data as Record<string, unknown>;
        if (parentData.collapsed) {
          graphStore.toggleHardwareCollapse(parent.id);
        }
        graphStore.reflowParentChildren(parent.id);
      }
    }

    const nextKey = buildConfigMacroItemKey(destinationFile, macroSection.full_header, macroSection.line_number);
    if (selectedKey === item.key || item.source === 'draft') {
      setSelectedKey(nextKey);
      setTargetFile(destinationFile);
    }
    if (item.draftId) {
      deleteDraft(item.draftId);
    }
    setMessage(existingTargetSection
      ? `Applied changes to ${macroSection.section_name} in ${destinationFile}.`
      : `Macro ${macroSection.section_name} added to ${destinationFile}.`);
    return true;
  }, [configFiles, deleteDraft, selectedKey, upsertSection]);

  useEffect(() => {
    if (!showExitDialog || pendingExitItems.length > 0) {
      return;
    }
    setShowExitDialog(false);
    onClose();
  }, [onClose, pendingExitItems.length, showExitDialog]);

  const updateEditedItem = (updates: Partial<MacroSourceItem>) => {
    if (!editMode) return;
    setEditDraft((current) => (current ? { ...current, ...updates } : current));
  };

  const handleSaveEdit = () => {
    persistCurrentEditDraft();
  };

  const handleCancelEdit = () => {
    setEditMode(false);
    setEditDraft(null);
    setMessage(null);
  };

  const handleToggleEdit = () => {
    if (!selectedItem) return;
    if (selectedItem.source === 'playback') {
      setMessage('Loaded G-code files are playback-only. Copy them to a draft if you want to edit them.');
      return;
    }
    if (editMode) {
      handleSaveEdit();
      return;
    }
    setMoveMode(runtimeMoveMode);
    setEditDraft({ ...selectedItem });
    setEditMode(true);
    setMessage(null);
  };

  const handleCloseRequest = useCallback(() => {
    if (editMode) {
      persistCurrentEditDraft();
    }

    if (useMacroDesignerStore.getState().drafts.length > 0) {
      setShowExitDialog(true);
      return;
    }

    onClose();
  }, [editMode, onClose, persistCurrentEditDraft]);

  const handleSetMoveMode = (nextMode: 'absolute' | 'relative') => {
    if (!editMode || !displayedItem) {
      return;
    }
    appendGcode(nextMode === 'absolute' ? 'G90' : 'G91');
    setMoveMode(nextMode);
  };

  const appendGcodeLines = (lines: string[]) => {
    if (!editMode || !editDraft) return;
    const prefix = editDraft.gcode.replace(/\r\n?/g, '\n').replace(/\n+$/, '');
    const nextBlock = lines.filter(Boolean).join('\n');
    updateEditedItem({
      gcode: prefix ? `${prefix}\n${nextBlock}` : nextBlock,
    });
  };

  const appendGcode = (line: string) => {
    appendGcodeLines([line]);
  };

  const appendExtrusionCommand = (direction: 1 | -1) => {
    const distance = Number(extrudeDistance);
    const feed = Number(extrudeFeedRate);
    if (!Number.isFinite(distance) || distance <= 0) {
      setMessage(`${direction > 0 ? 'Extruder' : 'Retract'} distance must be greater than 0.`);
      return;
    }
    const signedDistance = direction > 0 ? distance : -distance;
    appendGcode(`G1 E${formatNumber(signedDistance)}${Number.isFinite(feed) && feed > 0 ? ` F${formatNumber(feed)}` : ''}`);
  };

  const getCurrentToolheadPosition = (): ToolheadPosition | null => toolheadPositionRef.current;

  const validateToolheadMove = (from: ToolheadPosition, to: ToolheadPosition): string | null => {
    if (!isPointInMoveBounds(machineProfile, to.x, to.y)) {
      return 'That move exceeds the configured moveable area.';
    }
    const endZone = findZoneHit(machineProfile, to.x, to.y);
    if (endZone) {
      return `That move enters no-go zone ${endZone.name}.`;
    }
    const pathZone = findPathZoneHit(machineProfile, from.x, from.y, to.x, to.y);
    if (pathZone) {
      return `That move passes through no-go zone ${pathZone.name}.`;
    }
    if (to.z < machineProfile.minZ || to.z > machineProfile.maxZ) {
      return 'That move exceeds the configured Z range.';
    }
    return null;
  };

  const buildMoveLines = (
    from: ToolheadPosition,
    to: ToolheadPosition,
    mode: 'absolute' | 'relative',
  ): string[] => {
    const feedRate = Number(moveFeedRate.trim());
    const feedSuffix = Number.isFinite(feedRate) && feedRate > 0 ? ` F${formatNumber(feedRate)}` : '';
    const isChanged = (left: number, right: number) => Math.abs(left - right) > 1e-6;
    if (mode === 'relative') {
      const deltas = [
        isChanged(from.x, to.x) ? `X${formatNumber(to.x - from.x)}` : null,
        isChanged(from.y, to.y) ? `Y${formatNumber(to.y - from.y)}` : null,
        isChanged(from.z, to.z) ? `Z${formatNumber(to.z - from.z)}` : null,
      ].filter(Boolean);
      if (!deltas.length) return [];
      return [`G0 ${deltas.join(' ')}${feedSuffix}`];
    }

    const axes = [
      isChanged(from.x, to.x) ? `X${formatNumber(to.x)}` : null,
      isChanged(from.y, to.y) ? `Y${formatNumber(to.y)}` : null,
      isChanged(from.z, to.z) ? `Z${formatNumber(to.z)}` : null,
    ].filter(Boolean);
    if (!axes.length) return [];
    return [`G0 ${axes.join(' ')}${feedSuffix}`];
  };

  const handleCreateDraft = () => {
    const draft = createDraft('NEW_MACRO', {
      title: 'NEW_MACRO',
      renameExisting: '',
      description: '',
      variables: '',
      gcode: '',
    });
    setSelectedKey(`draft:${draft.id}`);
    setEditMode(true);
    setEditDraft({
      key: `draft:${draft.id}`,
      source: 'draft',
      title: draft.title,
      renameExisting: draft.renameExisting,
      description: draft.description,
      variables: draft.variables,
      gcode: draft.gcode,
      draftId: draft.id,
      isDraft: true,
    });
  };

  const handleCopy = (itemKey?: string) => {
    const item = itemKey ? allMacroItems.find(i => i.key === itemKey) || selectedItem : selectedItem;
    if (!item) return;
    const draftId = item.source === 'draft' ? item.key.replace(/^draft:/, '') : null;
    if (item.source === 'draft' && draftId) {
      const duplicate = duplicateDraft(draftId);
      if (duplicate) {
        setSelectedKey(`draft:${duplicate.id}`);
        setEditMode(true);
      }
      return;
    }
    const draft = createDraft(`${sanitizeMacroName(item.title)}_COPY`, {
      renameExisting: item.renameExisting,
      description: item.description,
      variables: item.variables,
      gcode: item.gcode,
    });
    setSelectedKey(`draft:${draft.id}`);
    setEditMode(true);
  };

  const handleDelete = (draftId?: string) => {
    const id = draftId || selectedDraftId;
    if (!id) return;
    deleteDraft(id);
    if (selectedDraftId === id && selectedItem?.source === 'draft') {
      setSelectedKey(null);
    }
  };

  const handleRename = (itemKey?: string) => {
    const key = itemKey || selectedKey;
    if (!key) return;
    const item = allMacroItems.find((entry) => entry.key === key);
    if (item?.source === 'playback') {
      setMessage('Loaded G-code files are playback-only.');
      return;
    }
    setSelectedKey(key);
    setEditMode(true);
  };

  const handleLoadPlaybackClick = () => {
    playbackFileInputRef.current?.click();
  };

  const handleLoadPlaybackFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    try {
      const rawText = await file.text();
      const normalizedText = rawText.replace(/\r\n?/g, '\n').trim();
      if (!normalizedText) {
        setMessage(`${file.name} is empty.`);
        return;
      }

      setPlaybackItem({
        key: PLAYBACK_ITEM_KEY,
        source: 'playback',
        title: file.name.replace(/\.[^.]+$/, '') || file.name,
        renameExisting: '',
        description: `Loaded from ${file.name} for playback only.`,
        variables: '',
        gcode: normalizedText,
        readOnly: true,
      });
      setSelectedKey(PLAYBACK_ITEM_KEY);
      setEditMode(false);
      setEditDraft(null);
      setMessage(`Loaded ${file.name} for playback.`);
    } catch {
      setMessage(`Failed to read ${file.name}.`);
    } finally {
      event.target.value = '';
    }
  };

  const handleRemovePlayback = () => {
    setPlaybackItem(null);
    setSelectedKey((current) => (current === PLAYBACK_ITEM_KEY ? null : current));
    setEditMode(false);
    setEditDraft(null);
    setMessage('Playback file removed.');
  };

  const handleStep = () => {
    if (!runtime || isAnimating) return;
    setToolheadDragPos(null);
    const step = simulationPlan.steps[stepIndex];
    if (!step) return;
    executeStepWithAnimation(runtime, stepIndex);
  };

  const handleStepBack = () => {
    if (stepIndex === 0) return;
    syncSimulationPosition(stepIndex - 1);
  };

  const handleReset = () => {
    if (!selectedItem) return;
    syncSimulationPosition(0);
  };

  const handleTimelineScrub = (event: React.ChangeEvent<HTMLInputElement>) => {
    syncSimulationPosition(Number(event.target.value));
  };

  const handleGoTo = () => {
    const currentPosition = getCurrentToolheadPosition();
    if (!currentPosition) {
      setMessage('No toolhead position is available yet.');
      return;
    }

    const hasX = goToX.trim() !== '';
    const hasY = goToY.trim() !== '';
    const hasZ = goToZ.trim() !== '';
    if (!hasX && !hasY && !hasZ) {
      setMessage('Enter at least one axis value to move the toolhead.');
      return;
    }

    const rawX = hasX ? Number(goToX) : 0;
    const rawY = hasY ? Number(goToY) : 0;
    const rawZ = hasZ ? Number(goToZ) : 0;
    if ((hasX && !Number.isFinite(rawX)) || (hasY && !Number.isFinite(rawY)) || (hasZ && !Number.isFinite(rawZ))) {
      setMessage('Please enter valid X, Y, and Z coordinates.');
      return;
    }

    const x = hasX ? (activeMoveMode === 'relative' ? currentPosition.x + rawX : rawX) : currentPosition.x;
    const y = hasY ? (activeMoveMode === 'relative' ? currentPosition.y + rawY : rawY) : currentPosition.y;
    const z = hasZ ? (activeMoveMode === 'relative' ? currentPosition.z + rawZ : rawZ) : currentPosition.z;

    const cx = clamp(x, machineProfile.moveMinX, machineProfile.moveMaxX);
    const cy = clamp(y, machineProfile.moveMinY, machineProfile.moveMaxY);
    const cz = clamp(z, machineProfile.minZ, machineProfile.maxZ);
    const nextPosition = { x: cx, y: cy, z: cz };
    const moveValidation = validateToolheadMove(currentPosition, nextPosition);
    if (moveValidation) {
      setMessage(moveValidation);
      return;
    }

    const moveLines = buildMoveLines(currentPosition, nextPosition, activeMoveMode);
    if (!moveLines.length) {
      setMessage('The requested move does not change the toolhead position.');
      return;
    }
    appendGcodeLines(moveLines);
    setToolheadDragPos({ x: cx, y: cy, z: cz });
    setMessage(`Added move to X${formatNumber(cx)} Y${formatNumber(cy)} Z${formatNumber(cz)}.`);
  };

  const handleAxisJog = (axis: 'X' | 'Y' | 'Z', delta: number) => {
    const currentPosition = getCurrentToolheadPosition();
    if (!currentPosition) {
      setMessage('No toolhead position is available yet.');
      return;
    }

    const nextPosition = {
      x: axis === 'X' ? clamp(currentPosition.x + delta, machineProfile.moveMinX, machineProfile.moveMaxX) : currentPosition.x,
      y: axis === 'Y' ? clamp(currentPosition.y + delta, machineProfile.moveMinY, machineProfile.moveMaxY) : currentPosition.y,
      z: axis === 'Z' ? clamp(currentPosition.z + delta, machineProfile.minZ, machineProfile.maxZ) : currentPosition.z,
    };
    const moveValidation = validateToolheadMove(currentPosition, nextPosition);
    if (moveValidation) {
      setMessage(moveValidation);
      return;
    }

    const moveLines = buildMoveLines(currentPosition, nextPosition, activeMoveMode);
    if (!moveLines.length) return;
    appendGcodeLines(moveLines);
    setToolheadDragPos(nextPosition);
    setGoToX(formatNumber(nextPosition.x));
    setGoToY(formatNumber(nextPosition.y));
    setGoToZ(formatNumber(nextPosition.z));
    setMessage(`Added move to X${formatNumber(nextPosition.x)} Y${formatNumber(nextPosition.y)} Z${formatNumber(nextPosition.z)}.`);
  };

  const settleWheelZMove = () => {
    const start = zWheelStartRef.current;
    const current = toolheadPositionRef.current;
    if (!start || !current) return;
    const moveLines = buildMoveLines(start, current, activeMoveMode);
    if (moveLines.length) {
      appendGcodeLines(moveLines);
      setMessage(`Added move to X${formatNumber(current.x)} Y${formatNumber(current.y)} Z${formatNumber(current.z)}.`);
    }
    zWheelStartRef.current = null;
    zWheelTimeoutRef.current = null;
    window.setTimeout(() => setZMoveIndicator(null), 250);
  };

  const handleToolheadWheel = (event: React.WheelEvent<SVGGElement>) => {
    if (!editMode || !editDraft) return;
    event.preventDefault();
    event.stopPropagation();
    const currentPosition = toolheadPositionRef.current;
    if (!currentPosition) return;
    if (!zWheelStartRef.current) {
      zWheelStartRef.current = currentPosition;
    }
    const direction = event.deltaY < 0 ? 1 : -1;
    const nextZ = clamp(currentPosition.z + direction, machineProfile.minZ, machineProfile.maxZ);
    if (Math.abs(nextZ - currentPosition.z) < 1e-6) return;
    const nextPosition = { ...currentPosition, z: nextZ };
    setToolheadDragPos(nextPosition);
    setGoToZ(formatNumber(nextZ));
    setZMoveIndicator(direction > 0 ? 'up' : 'down');
    if (zWheelTimeoutRef.current !== null) {
      window.clearTimeout(zWheelTimeoutRef.current);
    }
    zWheelTimeoutRef.current = window.setTimeout(settleWheelZMove, 1800);
  };

  const handleAddToConfiguration = () => {
    if (!selectedItem || !targetFile) return;
    applyMacroItemToConfiguration(selectedItem, targetFile);
  };

  const handleContextMenu = (event: React.MouseEvent, item: MacroSourceItem) => {
    event.preventDefault();
    event.stopPropagation();
    const draftId = item.draftId || (item.source === 'draft' ? item.key.replace(/^draft:/, '') : null);
    setContextMenu({
      x: event.clientX,
      y: event.clientY,
      itemKey: item.key,
      itemSource: item.source,
      draftId,
    });
  };

  const handleCanvasContextMenu = (event: React.MouseEvent, target: 'dock' | 'zone', zoneId?: string) => {
    event.preventDefault();
    event.stopPropagation();
    if (target === 'zone' && zoneId) {
      setSelectedZoneId(zoneId);
      setIsDockSelected(false);
    }
    if (target === 'dock') {
      setIsDockSelected(true);
      setSelectedZoneId(null);
    }
    setCanvasContextMenu({
      x: event.clientX,
      y: event.clientY,
      target,
      zoneId,
    });
  };

  const handleDeleteSelectedCanvasItem = useCallback(() => {
    if (selectedZone) {
      deleteNoGoZone(selectedZone.id);
      setMessage(`Deleted ${selectedZone.name}.`);
      return true;
    }
    if (isDockSelected && dockPosition) {
      setDockPosition(null);
      setMessage('Dock deleted.');
      return true;
    }
    return false;
  }, [deleteNoGoZone, dockPosition, isDockSelected, selectedZone, setDockPosition]);

  const openExactPositionDialog = useCallback((target: 'dock' | 'zone', zoneId?: string) => {
    if (target === 'dock') {
      if (!dockPosition) return;
      setIsDockSelected(true);
      setSelectedZoneId(null);
      setExactPositionDialog({
        target: 'dock',
        x: formatNumber(dockPosition.x),
        y: formatNumber(dockPosition.y),
        width: '',
        height: '',
      });
      return;
    }

    const zone = zoneId ? noGoZones.find((item) => item.id === zoneId) : selectedZone;
    if (!zone) return;
    setSelectedZoneId(zone.id);
    setIsDockSelected(false);
    setExactPositionDialog({
      target: 'zone',
      zoneId: zone.id,
      x: formatNumber(zone.x),
      y: formatNumber(zone.y),
      width: formatNumber(zone.width),
      height: formatNumber(zone.height),
    });
  }, [dockPosition, noGoZones, selectedZone]);

  const handleApplyExactPosition = useCallback(() => {
    if (!exactPositionDialog) return;

    const x = Number(exactPositionDialog.x);
    const y = Number(exactPositionDialog.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      setMessage(`Enter valid numeric values for the ${exactPositionDialog.target === 'dock' ? 'dock' : 'no-go zone'}.`);
      return;
    }

    if (exactPositionDialog.target === 'dock') {
      const boundedDock = {
        x: clamp(x, machineProfile.moveMinX, machineProfile.moveMaxX),
        y: clamp(y, machineProfile.moveMinY, machineProfile.moveMaxY),
      };
      setDockPosition(boundedDock);
      setIsDockSelected(true);
      setSelectedZoneId(null);
      setExactPositionDialog(null);
      setMessage(`Updated dock to X${formatNumber(boundedDock.x)} Y${formatNumber(boundedDock.y)}.`);
      return;
    }

    const zone = noGoZones.find((item) => item.id === exactPositionDialog.zoneId);
    if (!zone) {
      setExactPositionDialog(null);
      return;
    }

    const width = Number(exactPositionDialog.width);
    const height = Number(exactPositionDialog.height);
    if (!Number.isFinite(width) || !Number.isFinite(height)) {
      setMessage('Enter valid numeric values for the no-go zone.');
      return;
    }
    if (width <= 0 || height <= 0) {
      setMessage('No-go zone width and height must be greater than 0.');
      return;
    }

    const boundedX = clamp(x, machineProfile.moveMinX, machineProfile.moveMaxX - width);
    const boundedY = clamp(y, machineProfile.moveMinY, machineProfile.moveMaxY - height);
    const boundedW = Math.min(width, machineProfile.moveMaxX - boundedX);
    const boundedH = Math.min(height, machineProfile.moveMaxY - boundedY);
    updateNoGoZone(zone.id, { x: boundedX, y: boundedY, width: boundedW, height: boundedH });
    setSelectedZoneId(zone.id);
    setIsDockSelected(false);
    setExactPositionDialog(null);
    setMessage(`Updated ${zone.name} to X${formatNumber(boundedX)} Y${formatNumber(boundedY)}.`);
  }, [exactPositionDialog, machineProfile, noGoZones, setDockPosition, updateNoGoZone]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Delete' && event.key !== 'Backspace') return;
      const target = event.target as HTMLElement | null;
      if (target && ['INPUT', 'TEXTAREA'].includes(target.tagName)) return;
      if (handleDeleteSelectedCanvasItem()) {
        event.preventDefault();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleDeleteSelectedCanvasItem]);

  // --- SVG drag handlers ---
  const handleSvgPointerDown = (event: React.PointerEvent<SVGSVGElement>) => {
    if (!svgRef.current) return;
    const target = event.target as SVGElement;
    const dragType = target.closest('[data-drag]')?.getAttribute('data-drag');

    if (dragType === 'toolhead' && editMode && selectedItem) {
      event.preventDefault();
      setSelectedZoneId(null);
      const machine = clientToMachine(event, svgRef.current, machineProfile, rotation, viewBounds.viewMaxY);
      setDragState({ type: 'toolhead', offsetX: 0, offsetY: 0 });
      setToolheadDragPos({ x: machine.x, y: machine.y, z: toolheadDragPos?.z ?? runtime?.z ?? Math.max(machineProfile.minZ, 0) });
      svgRef.current.setPointerCapture(event.pointerId);
      return;
    }

    if (dragType === 'dock') {
      event.preventDefault();
      setIsDockSelected(true);
      setSelectedZoneId(null);
      const machine = clientToMachine(event, svgRef.current, machineProfile, rotation, viewBounds.viewMaxY);
      setDragState({ type: 'dock', offsetX: (dockPosition?.x ?? 0) - machine.x, offsetY: (dockPosition?.y ?? 0) - machine.y });
      svgRef.current.setPointerCapture(event.pointerId);
      return;
    }

    const zoneResizeEl = target.closest('[data-zone-resize]');
    if (zoneResizeEl) {
      event.preventDefault();
      const zoneId = zoneResizeEl.getAttribute('data-zone-id')!;
      setSelectedZoneId(zoneId);
      const fixX = Number(zoneResizeEl.getAttribute('data-fix-x'));
      const fixY = Number(zoneResizeEl.getAttribute('data-fix-y'));
      setDragState({ type: 'zone-resize', zoneId, fixedCornerX: fixX, fixedCornerY: fixY, offsetX: 0, offsetY: 0 });
      svgRef.current.setPointerCapture(event.pointerId);
      return;
    }

    const zoneEl = target.closest('[data-zone-id]');
    if (zoneEl) {
      event.preventDefault();
      const zoneId = zoneEl.getAttribute('data-zone-id')!;
      setIsDockSelected(false);
      setSelectedZoneId(zoneId);
      const zone = noGoZones.find(z => z.id === zoneId);
      if (zone) {
        const machine = clientToMachine(event, svgRef.current, machineProfile, rotation, viewBounds.viewMaxY);
        setDragState({ type: 'zone', zoneId, offsetX: zone.x - machine.x, offsetY: zone.y - machine.y });
        svgRef.current.setPointerCapture(event.pointerId);
      }
      return;
    }

    // Click on the grid to add a move (only if in edit mode and not dragging)
    if (editMode && selectedItem) {
      setIsDockSelected(false);
      setSelectedZoneId(null);
      const machine = clientToMachine(event, svgRef.current, machineProfile, rotation, viewBounds.viewMaxY);
      const x = clamp(machine.x, machineProfile.moveMinX, machineProfile.moveMaxX);
      const y = clamp(machine.y, machineProfile.moveMinY, machineProfile.moveMaxY);
      const currentPosition = getCurrentToolheadPosition();
      if (!currentPosition) {
        setMessage('No toolhead position is available yet.');
        return;
      }
      const nextPosition = { x, y, z: toolheadDragPos?.z ?? runtime?.z ?? Math.max(machineProfile.minZ, 0) };
      const moveValidation = validateToolheadMove(currentPosition, nextPosition);
      if (moveValidation) {
        setMessage(moveValidation);
        return;
      }
      const moveLines = buildMoveLines(currentPosition, nextPosition, activeMoveMode);
      if (!moveLines.length) return;
      appendGcodeLines(moveLines);
      setToolheadDragPos(nextPosition);
      setMessage(`Added move to X${formatNumber(x)} Y${formatNumber(y)}.`);
    }
  };

  const handleSvgPointerMove = (event: React.PointerEvent<SVGSVGElement>) => {
    if (!dragState || !svgRef.current) return;
    const machine = clientToMachine(event, svgRef.current, machineProfile, rotation, viewBounds.viewMaxY);

    if (dragState.type === 'toolhead') {
      const x = clamp(machine.x, machineProfile.moveMinX, machineProfile.moveMaxX);
      const y = clamp(machine.y, machineProfile.moveMinY, machineProfile.moveMaxY);
      setToolheadDragPos({ x, y, z: toolheadDragPos?.z ?? runtime?.z ?? Math.max(machineProfile.minZ, 0) });
      return;
    }

    if (dragState.type === 'dock') {
      const x = clamp(machine.x + dragState.offsetX, machineProfile.moveMinX, machineProfile.moveMaxX);
      const y = clamp(machine.y + dragState.offsetY, machineProfile.moveMinY, machineProfile.moveMaxY);
      setDockPosition({ x, y });
      return;
    }

    if (dragState.type === 'zone' && dragState.zoneId) {
      const zone = noGoZones.find((z) => z.id === dragState.zoneId);
      if (!zone) return;
      const x = clamp(machine.x + dragState.offsetX, machineProfile.moveMinX, machineProfile.moveMaxX - zone.width);
      const y = clamp(machine.y + dragState.offsetY, machineProfile.moveMinY, machineProfile.moveMaxY - zone.height);
      updateNoGoZone(dragState.zoneId, { x, y });
      return;
    }

    if (dragState.type === 'zone-resize' && dragState.zoneId && dragState.fixedCornerX != null && dragState.fixedCornerY != null) {
      const fixX = dragState.fixedCornerX;
      const fixY = dragState.fixedCornerY;
      const rawX = Math.min(machine.x, fixX);
      const rawY = Math.min(machine.y, fixY);
      const rawW = Math.max(1, Math.abs(machine.x - fixX));
      const rawH = Math.max(1, Math.abs(machine.y - fixY));
      const newX = clamp(rawX, machineProfile.moveMinX, machineProfile.moveMaxX - rawW);
      const newY = clamp(rawY, machineProfile.moveMinY, machineProfile.moveMaxY - rawH);
      const newW = Math.min(rawW, machineProfile.moveMaxX - newX);
      const newH = Math.min(rawH, machineProfile.moveMaxY - newY);
      updateNoGoZone(dragState.zoneId, { x: newX, y: newY, width: newW, height: newH });
    }
  };

  const handleSvgPointerUp = (event: React.PointerEvent<SVGSVGElement>) => {
    if (!dragState) return;
    if (svgRef.current) {
      svgRef.current.releasePointerCapture(event.pointerId);
    }

    if (dragState.type === 'toolhead' && toolheadDragPos && selectedItem) {
      const currentPosition = runtime ? { x: runtime.x, y: runtime.y, z: runtime.z } : toolheadPositionRef.current;
      if (!currentPosition) {
        setDragState(null);
        return;
      }
      const x = clamp(toolheadDragPos.x, machineProfile.moveMinX, machineProfile.moveMaxX);
      const y = clamp(toolheadDragPos.y, machineProfile.moveMinY, machineProfile.moveMaxY);
      const nextPosition = { x, y, z: toolheadDragPos.z };
      const moveValidation = validateToolheadMove(currentPosition, nextPosition);
      if (moveValidation) {
        setMessage(moveValidation);
        setDragState(null);
        return;
      }
      const moveLines = buildMoveLines(currentPosition, nextPosition, activeMoveMode);
      if (moveLines.length) {
        appendGcodeLines(moveLines);
      }
      setToolheadDragPos(nextPosition);
      setMessage(`Added move to X${formatNumber(x)} Y${formatNumber(y)}.`);
    }

    setDragState(null);
  };

  // --- Computed SVG elements ---
  const currentRuntime = runtime || (selectedItem ? createInitialRuntimeState(machineProfile, selectedItem.title) : null);
  const simulationStepCount = simulationPlan.steps.length;
  const simulationCurrentStep = Math.min(stepIndex, simulationStepCount);
  const simulationLastLogEntry = simulationLog[simulationLog.length - 1] ?? null;
  const simulationTimelineLabel = stepIndex === 0
    ? 'At start'
    : stepIndex >= simulationStepCount
      ? 'At end'
      : `Next: ${getStepSource(simulationPlan.steps[stepIndex]).raw}`;
  const simulationOutputSummary = selectedLogWarning || (simulationLastLogEntry?.summary ?? 'Select a line to inspect warnings.');
  const simulationSelectedLineLabel = stepIndex > 0 && simulationLastLogEntry
    ? `L${simulationLastLogEntry.lineNumber}`
    : 'No line selected';

  // Toolhead position (use drag pos if dragging, otherwise runtime)
  const toolheadMachine = toolheadDragPos || (currentRuntime ? { x: currentRuntime.x, y: currentRuntime.y, z: currentRuntime.z } : null);
  const toolheadSvg = toolheadMachine ? toSvg(toolheadMachine.x, toolheadMachine.y) : null;
  const movementTraceSvg = lastMovementTrace
    ? {
      from: toSvg(lastMovementTrace.fromX, lastMovementTrace.fromY),
      to: toSvg(lastMovementTrace.toX, lastMovementTrace.toY),
    }
    : null;
  const movementDirection = lastMovementTrace
    ? {
      dx: lastMovementTrace.toX - lastMovementTrace.fromX,
      dy: lastMovementTrace.toY - lastMovementTrace.fromY,
    }
    : null;
  const probePoint = currentRuntime?.activeProbePoint ? toSvg(currentRuntime.activeProbePoint.x, currentRuntime.activeProbePoint.y) : null;
  const probeMarker = machineProfile.hasProbe && toolheadMachine
    ? toSvg(toolheadMachine.x + machineProfile.probeOffsetX, toolheadMachine.y + machineProfile.probeOffsetY)
    : null;

  // Build plate outline (inner area)
  const buildCorners = useMemo(() => {
    if (machineProfile.shape === 'round') return null;
    return [
      toSvg(machineProfile.minX, machineProfile.maxY),
      toSvg(machineProfile.maxX, machineProfile.maxY),
      toSvg(machineProfile.maxX, machineProfile.minY),
      toSvg(machineProfile.minX, machineProfile.minY),
    ];
  }, [machineProfile, toSvg]);

  // Moveable area outline (outer area)
  const moveCorners = useMemo(() => {
    if (machineProfile.shape === 'round') return null;
    return [
      toSvg(machineProfile.moveMinX, machineProfile.moveMaxY),
      toSvg(machineProfile.moveMaxX, machineProfile.moveMaxY),
      toSvg(machineProfile.moveMaxX, machineProfile.moveMinY),
      toSvg(machineProfile.moveMinX, machineProfile.moveMinY),
    ];
  }, [machineProfile, toSvg]);

  // Zone SVG elements
  const handleSize = Math.max(1, Math.min(viewBounds.svgW, viewBounds.svgH) * 0.008);
  const zoneSvg = noGoZones.map((zone) => {
    const topLeft = toSvg(zone.x, zone.y + zone.height);
    const bottomRight = toSvg(zone.x + zone.width, zone.y);
    const w = Math.abs(bottomRight.x - topLeft.x);
    const h = Math.abs(bottomRight.y - topLeft.y);
    const rx = Math.min(topLeft.x, bottomRight.x);
    const ry = Math.min(topLeft.y, bottomRight.y);
    const machineCorners = [
      { mx: zone.x, my: zone.y, fixMX: zone.x + zone.width, fixMY: zone.y + zone.height },
      { mx: zone.x + zone.width, my: zone.y, fixMX: zone.x, fixMY: zone.y + zone.height },
      { mx: zone.x, my: zone.y + zone.height, fixMX: zone.x + zone.width, fixMY: zone.y },
      { mx: zone.x + zone.width, my: zone.y + zone.height, fixMX: zone.x, fixMY: zone.y },
    ];
    return (
      <g key={zone.id}>
        <rect
          data-zone-id={zone.id}
          x={rx}
          y={ry}
          width={Math.max(1, w)}
          height={Math.max(1, h)}
          fill="rgba(248, 113, 113, 0.18)"
          stroke={selectedZoneId === zone.id ? 'rgba(248, 113, 113, 1)' : 'rgba(248, 113, 113, 0.9)'}
          strokeWidth={selectedZoneId === zone.id ? '0.9' : '0.5'}
          className="cursor-move"
          onContextMenu={(event) => handleCanvasContextMenu(event, 'zone', zone.id)}
        />
        {machineCorners.map((c, i) => {
          const svgPos = toSvg(c.mx, c.my);
          return (
            <rect
              key={`${zone.id}-h-${i}`}
              data-zone-resize="corner"
              data-zone-id={zone.id}
              data-fix-x={c.fixMX}
              data-fix-y={c.fixMY}
              x={svgPos.x - handleSize}
              y={svgPos.y - handleSize}
              width={handleSize * 2}
              height={handleSize * 2}
              fill="rgba(248, 113, 113, 0.95)"
              stroke="white"
              strokeWidth="0.2"
              className="cursor-nwse-resize"
            />
          );
        })}
      </g>
    );
  });

  // Dock dot
  const dockSvg = dockPosition ? (() => {
    const d = toSvg(dockPosition.x, dockPosition.y);
    const dotR = Math.max(1, Math.min(viewBounds.svgW, viewBounds.svgH) * 0.012);
    return (
      <g
        data-drag="dock"
        className="cursor-move"
        onContextMenu={(event) => handleCanvasContextMenu(event, 'dock')}
        onClick={() => { setIsDockSelected(true); setSelectedZoneId(null); }}
      >
        <circle
          cx={d.x}
          cy={d.y}
          r={dotR}
          fill="rgba(52,211,153,0.95)"
          stroke={isDockSelected ? 'rgba(250,204,21,0.95)' : 'white'}
          strokeWidth={isDockSelected ? '0.8' : '0.3'}
        />
        <text x={d.x + dotR + 1} y={d.y + 1} fill="rgba(52,211,153,0.95)" fontSize={Math.max(3, dotR * 1.2)}>
          Dock ({formatNumber(dockPosition.x)}, {formatNumber(dockPosition.y)})
        </text>
      </g>
    );
  })() : null;

  const labels = AXIS_LABELS[rotation] || AXIS_LABELS[0];
  const lblSize = Math.max(3, Math.min(viewBounds.svgW, viewBounds.svgH) * 0.025);
  const lblPad = 2;

  const viewBox = `${viewBounds.svgX} ${viewBounds.svgY} ${viewBounds.svgW} ${viewBounds.svgH}`;

  const toolheadSize = Math.max(2, Math.min(viewBounds.svgW, viewBounds.svgH) * 0.02);
  const directionArrowLength = Math.max(4, toolheadSize * 2.6);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55" onClick={handleCloseRequest}>
      <div className="h-[min(92vh,980px)] w-[min(98vw,1680px)] overflow-hidden rounded-2xl border border-[var(--color-bg-tertiary)] bg-[var(--color-bg-secondary)] shadow-2xl" onClick={(event) => event.stopPropagation()}>
        <input
          ref={playbackFileInputRef}
          type="file"
          accept=".gcode,.gc,.g,.ngc,.txt,text/plain"
          onChange={handleLoadPlaybackFile}
          className="hidden"
        />
        <div className="flex items-center justify-between border-b border-[var(--color-bg-tertiary)] px-5 py-4">
          <div>
            <h2 className="text-sm font-semibold text-[var(--color-text-primary)]">G-Code Macro Designer</h2>
            <p className="text-xs text-[var(--color-text-secondary)]">Design, simulate, and add macros to your Klipper configuration.</p>
          </div>
          <div className="flex items-center gap-2">
            <select value={targetFile} onChange={(event) => setTargetFile(event.target.value)} className="rounded-md border border-[var(--color-bg-tertiary)] bg-[var(--color-bg-primary)] px-3 py-1.5 text-xs text-[var(--color-text-primary)]">
              {Object.keys(configFiles).map((filename) => (
                <option key={filename} value={filename}>{filename}</option>
              ))}
            </select>
            <button onClick={handleAddToConfiguration} disabled={addToConfigurationState.disabled} className="rounded-md bg-green-600 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40">{addToConfigurationState.label}</button>
            <button onClick={handleCloseRequest} className="rounded-md border border-[var(--color-bg-tertiary)] px-3 py-1.5 text-xs text-[var(--color-text-primary)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]">Close</button>
          </div>
        </div>

        <div className="grid h-[calc(100%-69px)] grid-cols-[260px_minmax(0,1fr)_minmax(380px,30rem)]">
          {/* ==================== LEFT SIDEBAR ==================== */}
          <aside className="flex min-h-0 flex-col border-r border-[var(--color-bg-tertiary)] p-4">
            <div className="mb-3 flex items-center gap-2">
              <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search macros" className="w-full rounded-md border border-[var(--color-bg-tertiary)] bg-[var(--color-bg-primary)] px-3 py-2 text-xs text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none" />
            </div>
            <div className="mb-3 grid grid-cols-2 gap-2">
              <button onClick={handleCreateDraft} className="w-full rounded-md bg-[var(--color-accent)] px-3 py-2 text-xs font-semibold text-[var(--color-bg-primary)]">New</button>
              <button onClick={handleLoadPlaybackClick} className="w-full rounded-md border border-[var(--color-bg-tertiary)] px-3 py-2 text-xs font-semibold text-[var(--color-text-primary)] hover:border-[var(--color-accent)]">Load G-code</button>
            </div>

            <div className="flex-1 overflow-y-auto pr-1">
              {playbackItem && (
                <div className="pb-3">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--color-text-secondary)]">Playback file</p>
                    <button onClick={handleRemovePlayback} className="rounded-md border border-[var(--color-bg-tertiary)] px-2 py-1 text-[10px] text-[var(--color-text-primary)] hover:border-red-400/60 hover:text-red-300">Unload</button>
                  </div>
                  <button
                    onClick={() => setSelectedKey(playbackItem.key)}
                    onContextMenu={(event) => handleContextMenu(event, playbackItem)}
                    className={`w-full rounded-lg border px-3 py-2 text-left transition-colors ${selectedKey === playbackItem.key ? 'border-[var(--color-accent)] bg-[var(--color-bg-primary)]' : 'border-[var(--color-bg-tertiary)] hover:border-[var(--color-accent)]/60'}`}
                  >
                    <div className="truncate text-xs font-medium text-[var(--color-text-primary)]">{playbackItem.title}</div>
                    <p className="mt-1 text-[11px] text-[var(--color-text-secondary)]">Playback only</p>
                  </button>
                </div>
              )}
                  {visibleDraftItems.length > 0 && (
                    <div className="pb-3">
                      <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--color-text-secondary)]">Drafts</p>
                      <div className="space-y-1.5">
                        {visibleDraftItems.map((item) => {
                          const badges = getMacroItemBadges(item);
                          return (
                            <button
                              key={item.key}
                              onClick={() => setSelectedKey(item.key)}
                              onContextMenu={(event) => handleContextMenu(event, item)}
                              className={`w-full rounded-lg border px-3 py-2 text-left transition-colors ${selectedKey === item.key ? 'border-[var(--color-accent)] bg-[var(--color-bg-primary)]' : 'border-[var(--color-bg-tertiary)] hover:border-[var(--color-accent)]/60'}`}
                            >
                              <div className="min-w-0 space-y-1">
                                <div className="truncate text-xs font-medium text-[var(--color-text-primary)]">{item.title}</div>
                                <div className="flex flex-wrap gap-1">
                                  {badges.map((badge) => (
                                    <span key={`${item.key}-${badge}`} className="rounded-full border border-[var(--color-bg-tertiary)] px-2 py-0.5 text-[10px] text-[var(--color-text-secondary)]">{badge}</span>
                                  ))}
                                </div>
                              </div>
                              {item.description.trim() && (
                                <p className="mt-1 truncate text-[11px] text-[var(--color-text-secondary)]">{item.description}</p>
                              )}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  <div>
                    <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--color-text-secondary)]">{visibleDraftItems.length > 0 ? 'Configured macros' : 'Your macros'}</p>
                    <div className="space-y-1.5">
                      {visibleConfigItems.map((item) => {
                        const badges = getMacroItemBadges(item);
                        return (
                          <button
                            key={item.key}
                            onClick={() => setSelectedKey(item.key)}
                            onContextMenu={(event) => handleContextMenu(event, item)}
                            className={`w-full rounded-lg border px-3 py-2 text-left transition-colors ${selectedKey === item.key ? 'border-[var(--color-accent)] bg-[var(--color-bg-primary)]' : 'border-[var(--color-bg-tertiary)] hover:border-[var(--color-accent)]/60'}`}
                          >
                            <div className="min-w-0 space-y-1">
                              <div className="truncate text-xs font-medium text-[var(--color-text-primary)]">{item.title}</div>
                              <div className="flex flex-wrap gap-1">
                                {badges.map((badge) => (
                                  <span key={`${item.key}-${badge}`} className="rounded-full border border-[var(--color-bg-tertiary)] px-2 py-0.5 text-[10px] text-[var(--color-text-secondary)]">{badge}</span>
                                ))}
                              </div>
                            </div>
                            {item.description.trim() && (
                              <p className="mt-1 truncate text-[11px] text-[var(--color-text-secondary)]">{item.description}</p>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  </div>

              <div className="pt-3">
                <button onClick={() => setShowBuiltIns((current) => !current)} className="mb-2 flex w-full items-center justify-between rounded-lg border border-[var(--color-bg-tertiary)] px-3 py-2 text-left text-xs font-semibold text-[var(--color-text-primary)] hover:border-[var(--color-accent)]/60">
                  <span>Built-in features</span>
                  <span>{showBuiltIns ? 'Hide' : 'Show'}</span>
                </button>
                {showBuiltIns && (
                  <div className="space-y-1.5">
                    {visibleBuiltIns.map((item) => (
                      <button
                        key={item.key}
                        onClick={() => setSelectedKey(item.key)}
                        className={`w-full rounded-lg border px-3 py-2 text-left transition-colors ${selectedKey === item.key ? 'border-[var(--color-accent)] bg-[var(--color-bg-primary)]' : 'border-[var(--color-bg-tertiary)] hover:border-[var(--color-accent)]/60'}`}
                      >
                        <div className="text-xs font-medium text-[var(--color-text-primary)]">{item.title}</div>
                        <div className="mt-1 text-[11px] text-[var(--color-text-secondary)]">{item.gcode}</div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </aside>

          {/* ==================== CENTER: BUILD VOLUME ==================== */}
          <main className="flex min-h-0 min-w-0 flex-col bg-[linear-gradient(180deg,rgba(15,23,42,0.96),rgba(15,23,42,0.82))]">
            <div className="flex flex-shrink-0 items-center justify-between border-b border-[var(--color-bg-tertiary)] px-4 py-2">
              <div>
                <div className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--color-text-secondary)]">Build volume <span className="ml-2 font-normal normal-case tracking-normal opacity-70">Grid: 1mm</span></div>
                <div className="mt-0.5 text-sm text-[var(--color-text-primary)]">
                  {machineProfile.shape === 'round'
                    ? `Round ${formatNumber(machineProfile.radius || 0)}mm radius`
                    : `${formatNumber(machineProfile.maxX - machineProfile.minX)} × ${formatNumber(machineProfile.maxY - machineProfile.minY)}mm`
                  }
                  {(machineProfile.moveMinX < machineProfile.minX || machineProfile.moveMinY < machineProfile.minY) && (
                    <span className="ml-2 text-xs text-[var(--color-text-secondary)]">
                      (travel: {formatNumber(machineProfile.moveMaxX - machineProfile.moveMinX)} × {formatNumber(machineProfile.moveMaxY - machineProfile.moveMinY)}mm)
                    </span>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2 text-xs">
                <button onClick={() => {
                  const zone = addNoGoZone({ x: machineProfile.centerX - 10, y: machineProfile.centerY - 10, width: 20, height: 20 });
                  setSelectedZoneId(zone.id);
                  setIsDockSelected(false);
                }} className="rounded-md border border-[var(--color-bg-tertiary)] px-3 py-1.5 text-[var(--color-text-primary)] hover:border-[var(--color-accent)]">Add no-go zone</button>
                <button disabled={dockPosition !== null} onClick={() => {
                  setDockPosition({ x: machineProfile.centerX, y: machineProfile.centerY });
                  setIsDockSelected(true);
                  setSelectedZoneId(null);
                }} className="rounded-md border border-[var(--color-bg-tertiary)] px-3 py-1.5 text-[var(--color-text-primary)] hover:border-[var(--color-accent)] disabled:opacity-40">Add dock</button>
                <button onClick={() => setRotation(rotation === 270 ? 0 : (rotation + 90) as 0 | 90 | 180 | 270)} className="rounded-md border border-[var(--color-bg-tertiary)] px-3 py-1.5 text-[var(--color-text-primary)] hover:border-[var(--color-accent)]">Rotate 90°</button>
              </div>
            </div>

            <div className="flex min-h-0 flex-1 flex-col">
              <div className="mx-4 mt-3 flex flex-shrink-0 gap-3">
                <div className="flex-1 rounded-lg border border-[var(--color-bg-tertiary)] bg-[rgba(15,23,42,0.72)] px-3 py-2 text-[10px] text-[var(--color-text-secondary)]">
                  <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.16em]">Legend</div>
                  <div className="flex flex-wrap gap-x-4 gap-y-1">
                    <div className="flex items-center gap-1"><span className="inline-block h-2 w-3 border border-sky-400 bg-sky-400/15" /> Build plate</div>
                    <div className="flex items-center gap-1"><span className="inline-block h-2 w-3 border border-gray-400 border-dashed bg-gray-400/10" /> Travel area</div>
                    <div className="flex items-center gap-1"><span className="inline-block h-2 w-3 border border-red-400 bg-red-400/20" /> No-go zone</div>
                    <div className="flex items-center gap-1"><span className="inline-block h-2 w-2 bg-sky-400" /> Toolhead</div>
                    {machineProfile.hasProbe && <div className="flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-full bg-orange-400" /> Probe</div>}
                    <div className="flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-full bg-emerald-400" /> Dock</div>
                  </div>
                </div>
                <div className="min-w-[360px] basis-[24rem] flex-shrink-0 rounded-lg border border-[var(--color-bg-tertiary)] bg-[rgba(15,23,42,0.72)] px-3 py-2 text-[10px] text-[var(--color-text-secondary)]">
                  <div className="mb-1 flex items-center justify-between gap-3">
                    <div className="text-[10px] font-semibold uppercase tracking-[0.16em]">Machine state</div>
                    <div className="inline-flex overflow-hidden rounded-md border border-[var(--color-bg-tertiary)]">
                      <button
                        type="button"
                        disabled={!editMode || !displayedItem}
                        onClick={() => handleSetMoveMode('absolute')}
                        className={`px-2.5 py-0.5 text-[10px] font-semibold transition-colors disabled:opacity-60 ${activeMoveMode === 'absolute' ? 'bg-[var(--color-accent)] text-[var(--color-bg-primary)]' : 'text-[var(--color-text-primary)]'}`}
                      >
                        Absolute
                      </button>
                      <button
                        type="button"
                        disabled={!editMode || !displayedItem}
                        onClick={() => handleSetMoveMode('relative')}
                        className={`border-l border-[var(--color-bg-tertiary)] px-2.5 py-0.5 text-[10px] font-semibold transition-colors disabled:opacity-60 ${activeMoveMode === 'relative' ? 'bg-[var(--color-accent)] text-[var(--color-bg-primary)]' : 'text-[var(--color-text-primary)]'}`}
                      >
                        Relative
                      </button>
                    </div>
                  </div>
                  <div className="grid grid-cols-[minmax(13rem,1.25fr)_minmax(0,1fr)] gap-x-5 gap-y-1 font-mono tabular-nums text-[var(--color-text-primary)]">
                    <div className="grid grid-cols-3 gap-x-3 whitespace-nowrap">
                      <span className="inline-flex min-w-[4.9rem] gap-1"><span className="text-[var(--color-text-secondary)]">X:</span><span>{formatCoordinate(toolheadMachine?.x ?? 0)}</span></span>
                      <span className="inline-flex min-w-[4.9rem] gap-1"><span className="text-[var(--color-text-secondary)]">Y:</span><span>{formatCoordinate(toolheadMachine?.y ?? 0)}</span></span>
                      <span className="inline-flex min-w-[4.9rem] gap-1"><span className="text-[var(--color-text-secondary)]">Z:</span><span>{formatCoordinate(toolheadMachine?.z ?? currentRuntime?.z ?? 0)}</span></span>
                    </div>
                    <div>Bed: {formatNumber(currentRuntime?.bed.current ?? 0)} / {formatNumber(currentRuntime?.bed.target ?? 0)} C</div>
                    <div>Nozzle: {formatNumber(currentRuntime?.nozzle.current ?? 0)} / {formatNumber(currentRuntime?.nozzle.target ?? 0)} C</div>
                    <div>Fan: {((currentRuntime?.fanSpeed ?? 0) * 100).toFixed(0)}%</div>
                    <div>Velocity: {formatNumber((currentRuntime?.feedRate ?? 0) / 60)} mm/s</div>
                    <div>Accel: {formatNumber(machineProfile.maxAccel)} mm/s²</div>
                    <div className="col-span-2">Homed axes: {(currentRuntime?.homedAxes.length ? currentRuntime.homedAxes.join(', ') : 'none')}</div>
                  </div>
                  {editMode && selectedItem && (
                    <div className="mt-1 space-y-1.5">
                      <div className="flex items-center gap-1.5">
                        <input value={goToX} onChange={(e) => setGoToX(e.target.value)} placeholder="X" className="w-14 rounded border border-[var(--color-bg-tertiary)] bg-[var(--color-bg-primary)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-primary)]" />
                        <input value={goToY} onChange={(e) => setGoToY(e.target.value)} placeholder="Y" className="w-14 rounded border border-[var(--color-bg-tertiary)] bg-[var(--color-bg-primary)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-primary)]" />
                        <input value={goToZ} onChange={(e) => setGoToZ(e.target.value)} placeholder="Z" className="w-14 rounded border border-[var(--color-bg-tertiary)] bg-[var(--color-bg-primary)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-primary)]" />
                        <button onClick={handleGoTo} className="rounded bg-[var(--color-accent)] px-2 py-0.5 text-[10px] font-semibold text-[var(--color-bg-primary)]">Move</button>
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* SVG Grid */}
              <div className="relative m-4 mt-2 min-h-0 flex-1 overflow-hidden border border-[var(--color-bg-tertiary)] bg-[linear-gradient(180deg,rgba(15,23,42,0.9),rgba(30,41,59,0.95))]">
                <svg
                  ref={svgRef}
                  viewBox={viewBox}
                  preserveAspectRatio="xMidYMid meet"
                  className="h-full w-full select-none"
                  onPointerDown={handleSvgPointerDown}
                  onPointerMove={handleSvgPointerMove}
                  onPointerUp={handleSvgPointerUp}
                >
                  <defs>
                    <pattern id="grid-1mm" width="1" height="1" patternUnits="userSpaceOnUse">
                      <path d="M 1 0 L 0 0 0 1" fill="none" stroke="rgba(148,163,184,0.07)" strokeWidth="0.15" />
                    </pattern>
                    <pattern id="grid-10mm" width="10" height="10" patternUnits="userSpaceOnUse">
                      <path d="M 10 0 L 0 0 0 10" fill="none" stroke="rgba(148,163,184,0.2)" strokeWidth="0.25" />
                    </pattern>
                    <marker id="toolhead-dir-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="4.8" markerHeight="4.8" orient="auto">
                      <path d="M 0 0 L 8 4 L 0 8 z" fill="rgba(34,197,94,0.95)" />
                    </marker>
                  </defs>

                  {/* Grid patterns */}
                  <rect x={viewBounds.svgX} y={viewBounds.svgY} width={viewBounds.svgW} height={viewBounds.svgH} fill="url(#grid-1mm)" />
                  <rect x={viewBounds.svgX} y={viewBounds.svgY} width={viewBounds.svgW} height={viewBounds.svgH} fill="url(#grid-10mm)" />

                  {/* Moveable area (outer) */}
                  {machineProfile.shape === 'round' && machineProfile.radius !== null ? (
                    (() => {
                      const center = toSvg(machineProfile.centerX, machineProfile.centerY);
                      return (
                        <circle cx={center.x} cy={center.y} r={machineProfile.radius} fill="rgba(56,189,248,0.03)" stroke="rgba(100,160,200,0.4)" strokeWidth="0.5" strokeDasharray="2 1" />
                      );
                    })()
                  ) : moveCorners && (
                    <polygon
                      points={moveCorners.map(c => `${c.x},${c.y}`).join(' ')}
                      fill="rgba(100,160,200,0.04)"
                      stroke="rgba(100,160,200,0.4)"
                      strokeWidth="0.5"
                      strokeDasharray="2 1"
                    />
                  )}

                  {/* Build plate (inner) */}
                  {machineProfile.shape === 'round' && machineProfile.radius !== null ? (
                    (() => {
                      const center = toSvg(machineProfile.centerX, machineProfile.centerY);
                      return (
                        <circle cx={center.x} cy={center.y} r={machineProfile.radius} fill="rgba(56,189,248,0.06)" stroke="rgba(56,189,248,0.75)" strokeWidth="0.5" />
                      );
                    })()
                  ) : buildCorners && (
                    <polygon
                      points={buildCorners.map(c => `${c.x},${c.y}`).join(' ')}
                      fill="rgba(56,189,248,0.06)"
                      stroke="rgba(56,189,248,0.75)"
                      strokeWidth="0.5"
                    />
                  )}

                  {/* No-go zones */}
                  {zoneSvg}

                  {/* Last XY movement trace */}
                  {movementTraceSvg && (
                    <line
                      x1={movementTraceSvg.from.x}
                      y1={movementTraceSvg.from.y}
                      x2={movementTraceSvg.to.x}
                      y2={movementTraceSvg.to.y}
                      stroke="rgba(34,197,94,0.95)"
                      strokeWidth="0.7"
                      strokeDasharray="2 1"
                    />
                  )}

                  {/* Dock dot */}
                  {dockSvg}

                  {/* Active probe point */}
                  {probePoint && (
                    <g>
                      <circle cx={probePoint.x} cy={probePoint.y} r={Math.max(1, toolheadSize * 0.4)} fill="rgba(251,191,36,0.95)" />
                      <text x={probePoint.x + toolheadSize * 0.6} y={probePoint.y - toolheadSize * 0.6} fill="rgba(251,191,36,0.95)" fontSize={lblSize * 0.8}>Probe point</text>
                    </g>
                  )}

                  {/* Toolhead */}
                  {toolheadSvg && (
                    <g data-drag="toolhead" className={editMode ? 'cursor-move' : ''} onWheel={handleToolheadWheel}>
                      <rect
                        x={toolheadSvg.x - toolheadSize}
                        y={toolheadSvg.y - toolheadSize}
                        width={toolheadSize * 2}
                        height={toolheadSize * 2}
                        fill="rgba(56,189,248,0.92)"
                        stroke="white"
                        strokeWidth="0.3"
                      />
                    </g>
                  )}

                  {/* Probe offset marker */}
                  {probeMarker && (
                    <circle
                      cx={probeMarker.x}
                      cy={probeMarker.y}
                      r={Math.max(1, toolheadSize * 0.38)}
                      fill="rgba(251,146,60,0.98)"
                      stroke="rgba(255,255,255,0.9)"
                      strokeWidth="0.2"
                    />
                  )}

                  {/* Toolhead overlays (top layer): XY direction arrows + Z movement indicator */}
                  {toolheadSvg && movementDirection && (
                    <g pointerEvents="none">
                      {Math.abs(movementDirection.dx) > 1e-6 && (
                        <line
                          x1={toolheadSvg.x}
                          y1={toolheadSvg.y}
                          x2={toolheadSvg.x + (movementDirection.dx > 0 ? directionArrowLength : -directionArrowLength)}
                          y2={toolheadSvg.y}
                          stroke="rgba(34,197,94,0.95)"
                          strokeWidth="0.8"
                          markerEnd="url(#toolhead-dir-arrow)"
                        />
                      )}
                      {Math.abs(movementDirection.dy) > 1e-6 && (
                        <line
                          x1={toolheadSvg.x}
                          y1={toolheadSvg.y}
                          x2={toolheadSvg.x}
                          y2={toolheadSvg.y + (movementDirection.dy > 0 ? -directionArrowLength : directionArrowLength)}
                          stroke="rgba(34,197,94,0.95)"
                          strokeWidth="0.8"
                          markerEnd="url(#toolhead-dir-arrow)"
                        />
                      )}
                    </g>
                  )}
                  {toolheadSvg && (zMoveIndicator === 'up' || simulationZIndicator === 'up') && (
                    <circle cx={toolheadSvg.x} cy={toolheadSvg.y} r={toolheadSize * 0.4} fill="white" pointerEvents="none" />
                  )}
                  {toolheadSvg && (zMoveIndicator === 'down' || simulationZIndicator === 'down') && (
                    <path
                      d={`M ${toolheadSvg.x - toolheadSize * 0.4} ${toolheadSvg.y - toolheadSize * 0.4} L ${toolheadSvg.x + toolheadSize * 0.4} ${toolheadSvg.y + toolheadSize * 0.4} M ${toolheadSvg.x + toolheadSize * 0.4} ${toolheadSvg.y - toolheadSize * 0.4} L ${toolheadSvg.x - toolheadSize * 0.4} ${toolheadSvg.y + toolheadSize * 0.4}`}
                      stroke="white"
                      strokeWidth="0.3"
                      strokeLinecap="round"
                      pointerEvents="none"
                    />
                  )}

                  {/* Axis labels */}
                  <text x={viewBounds.svgX + lblPad} y={viewBounds.svgY + lblSize + lblPad} fill="rgba(241,245,249,0.7)" fontSize={lblSize}>{labels.tl}</text>
                  <text x={viewBounds.svgX + viewBounds.svgW - lblPad} y={viewBounds.svgY + lblSize + lblPad} fill="rgba(241,245,249,0.7)" fontSize={lblSize} textAnchor="end">{labels.tr}</text>
                  <text x={viewBounds.svgX + lblPad} y={viewBounds.svgY + viewBounds.svgH - lblPad} fill="rgba(241,245,249,0.7)" fontSize={lblSize}>{labels.bl}</text>
                  <text x={viewBounds.svgX + viewBounds.svgW - lblPad} y={viewBounds.svgY + viewBounds.svgH - lblPad} fill="rgba(241,245,249,0.7)" fontSize={lblSize} textAnchor="end">{labels.br}</text>
                </svg>

              </div>

              {/* Simulation */}
              <div className="grid flex-shrink-0 gap-3 border-t border-[var(--color-bg-tertiary)] px-4 py-3 xl:items-start xl:grid-cols-[minmax(0,1.2fr)_minmax(18rem,1fr)]">
                <div className="min-w-0 self-start rounded-lg border border-[var(--color-bg-tertiary)] bg-[var(--color-bg-primary)] p-3">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--color-text-secondary)]">Simulation</div>
                      <div className="mt-1 text-[11px] text-[var(--color-text-secondary)]">Step {simulationCurrentStep} / {simulationStepCount}</div>
                    </div>
                    <span className="rounded-full border border-[var(--color-bg-tertiary)] px-2 py-1 text-[10px] text-[var(--color-text-secondary)]">
                      {simulationCurrentStep === 0 ? 'Idle' : simulationCurrentStep >= simulationStepCount ? 'Complete' : 'Running'}
                    </span>
                  </div>
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <button onClick={() => { if (isRunning) { setIsRunning(false); cancelAnimation(); } else { setIsRunning(true); setToolheadDragPos(null); } }} disabled={!simulationStepCount || stepIndex >= simulationStepCount} className="flex h-8 w-8 items-center justify-center rounded-md border border-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] disabled:opacity-40" title={isRunning ? 'Pause' : 'Play'}>
                      {isRunning ? (
                        <svg viewBox="0 0 16 16" className="h-4 w-4 fill-current"><rect x="3" y="2.5" width="3.5" height="11" rx="0.8" /><rect x="9.5" y="2.5" width="3.5" height="11" rx="0.8" /></svg>
                      ) : (
                        <svg viewBox="0 0 16 16" className="h-4 w-4 fill-current"><path d="M4 2.5 L13 8 L4 13.5 Z" /></svg>
                      )}
                    </button>
                    <button onClick={handleStepBack} disabled={!runtimeHistory.length} className="flex h-8 w-8 items-center justify-center rounded-md border border-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] disabled:opacity-40" title="Step back">
                      <svg viewBox="0 0 16 16" className="h-4 w-4 fill-current"><path d="M10.5 2.5 L4.5 8 L10.5 13.5 Z" /><rect x="11.5" y="2.5" width="1.5" height="11" rx="0.5" /></svg>
                    </button>
                    <button onClick={handleStep} disabled={isAnimating || !simulationStepCount || stepIndex >= simulationStepCount} className="flex h-8 w-8 items-center justify-center rounded-md border border-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] disabled:opacity-40" title="Step forward">
                      <svg viewBox="0 0 16 16" className="h-4 w-4 fill-current"><path d="M5.5 2.5 L11.5 8 L5.5 13.5 Z" /><rect x="3" y="2.5" width="1.5" height="11" rx="0.5" /></svg>
                    </button>
                    <button onClick={handleReset} disabled={!selectedItem} className="flex h-8 w-8 items-center justify-center rounded-md border border-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] disabled:opacity-40" title="Reset">
                      <svg viewBox="0 0 16 16" className="h-4 w-4 fill-current"><path d="M8 3 A5 5 0 1 1 3.4 6 H1.8 L4.4 3.4 L7 6 H5.2 A3.5 3.5 0 1 0 8 4.5 Z" /></svg>
                    </button>
                    <div className="ml-auto flex min-w-0 flex-wrap justify-end gap-x-3 gap-y-1 text-[10px] text-[var(--color-text-secondary)]">
                      <span>Max {formatNumber(machineProfile.maxVelocity)} mm/s</span>
                      <span>Accel {formatNumber(machineProfile.maxAccel)} mm/s²</span>
                    </div>
                  </div>
                  <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-[var(--color-bg-tertiary)] bg-[var(--color-bg-secondary)] px-3 py-2">
                    <label htmlFor="simulation-params" className="shrink-0 text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--color-text-secondary)]">Params</label>
                    <input
                      id="simulation-params"
                      type="text"
                      value={simulationParamsInput}
                      onChange={(event) => setSimulationParamsInput(event.target.value)}
                      placeholder="TEMP=60 FAN=255"
                      spellCheck={false}
                      className="min-w-0 flex-1 rounded-md border border-[var(--color-bg-tertiary)] bg-[var(--color-bg-primary)] px-2 py-1 font-mono text-[11px] text-[var(--color-text-primary)] placeholder:text-[var(--color-text-secondary)] focus:border-[var(--color-accent)] focus:outline-none"
                    />
                    <span className="text-[10px] text-[var(--color-text-secondary)]">Applied to root macro</span>
                  </div>
                  <div className="mt-3 rounded-lg border border-[var(--color-bg-tertiary)] bg-[var(--color-bg-secondary)] px-3 py-2">
                    <div className="flex items-start justify-between gap-3">
                      <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--color-text-secondary)]">Timeline</span>
                      <span className="min-w-0 max-w-full truncate text-right text-[11px] text-[var(--color-text-primary)]" title={simulationTimelineLabel}>{simulationTimelineLabel}</span>
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={simulationStepCount}
                      value={stepIndex}
                      onChange={handleTimelineScrub}
                      disabled={!simulationStepCount}
                      className="mt-2 w-full accent-[var(--color-accent)] disabled:opacity-40"
                    />
                    <div className="mt-2 flex items-center justify-between gap-2 text-[10px] text-[var(--color-text-secondary)]">
                      <span>Start</span>
                      <span className="min-w-0 truncate">{simulationSelectedLineLabel}</span>
                      <span>End</span>
                    </div>
                  </div>
                </div>
                <div className="min-h-0 self-start rounded-lg border border-[var(--color-bg-tertiary)] bg-[var(--color-bg-primary)] p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--color-text-secondary)]">Execution output</div>
                    <div className="text-[10px] text-[var(--color-text-secondary)]">{simulationSelectedLineLabel}</div>
                  </div>
                  {planWarnings.length > 0 && (
                    <div className="mt-2 rounded-md border border-amber-400/25 bg-amber-500/10 px-2 py-1 text-[11px] text-amber-100">{planWarnings.join(' ')}</div>
                  )}
                  <div ref={executionOutputRef} className="mt-2 h-[26vh] min-h-[7rem] max-h-[12rem] overflow-y-auto rounded-md border border-[var(--color-bg-tertiary)] bg-[var(--color-bg-secondary)] px-2 py-1 font-mono text-[11px]">
                    {simulationLog.length === 0 ? (
                      <div className="text-[var(--color-text-secondary)]">No commands executed.</div>
                    ) : simulationLog.map((entry) => (
                      <button
                        key={entry.id}
                        onClick={() => {
                          syncSimulationPosition(entry.timelineStepIndex);
                          setSelectedLogWarning(entry.warnings.length ? entry.warnings.join(' ') : null);
                        }}
                        className={`flex w-full items-start gap-2 rounded px-1.5 py-1 text-left ${entry.warnings.length ? 'bg-amber-500/10 text-amber-100' : 'text-[var(--color-text-primary)] hover:bg-[var(--color-bg-primary)]'}`}
                      >
                        <span className="w-16 shrink-0 text-[10px] text-[var(--color-text-secondary)]">L{entry.lineNumber}</span>
                        <span className="min-w-0 flex-1 truncate">{entry.raw}</span>
                      </button>
                    ))}
                  </div>
                  <div className="mt-2 min-h-[2.75rem] rounded-md border border-[var(--color-bg-tertiary)] bg-[var(--color-bg-secondary)] px-2.5 py-2 text-[11px] text-[var(--color-text-secondary)]">
                    {simulationOutputSummary}
                  </div>
                </div>
              </div>
            </div>
          </main>

          {/* ==================== RIGHT SIDEBAR ==================== */}
          <aside className="min-h-0 min-w-0 overflow-y-auto border-l border-[var(--color-bg-tertiary)] p-4 pr-5 [scrollbar-gutter:stable]">
            {selectedItem ? (
              <div className="flex flex-col gap-4">
                <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
                  <button onClick={handleToggleEdit} disabled={selectedItem.source === 'playback'} className={`rounded-md px-3 py-2 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-40 ${editMode ? 'bg-[var(--color-accent)] text-[var(--color-bg-primary)]' : 'border border-[var(--color-bg-tertiary)] text-[var(--color-text-primary)]'}`}>{editMode ? 'Save' : 'Edit'}</button>
                  <button onClick={handleCancelEdit} disabled={!editMode} className="rounded-md border border-[var(--color-bg-tertiary)] px-3 py-2 text-xs text-[var(--color-text-primary)] disabled:opacity-40">Cancel</button>
                </div>
                <div>
                  <div className="mb-1 text-xs font-semibold uppercase tracking-[0.16em] text-[var(--color-text-secondary)]">Macro</div>
                  {selectedItem.source === 'playback' && (
                    <div className="mb-2 rounded-lg border border-[var(--color-bg-tertiary)] bg-[var(--color-bg-primary)] px-3 py-2 text-[11px] text-[var(--color-text-secondary)]">
                      Loaded G-code files stay in-memory for simulation only and are not added to your configuration.
                    </div>
                  )}
                  <input value={displayedItem?.title || ''} disabled={!editMode} onChange={(event) => updateEditedItem({ title: event.target.value })} className="mb-2 w-full rounded-md border border-[var(--color-bg-tertiary)] bg-[var(--color-bg-primary)] px-3 py-2 text-sm text-[var(--color-text-primary)] disabled:opacity-70" />
                  <input value={displayedItem?.renameExisting || ''} disabled={!editMode} onChange={(event) => updateEditedItem({ renameExisting: event.target.value })} placeholder="rename_existing" className="mb-2 w-full rounded-md border border-[var(--color-bg-tertiary)] bg-[var(--color-bg-primary)] px-3 py-2 text-xs text-[var(--color-text-primary)] disabled:opacity-50" />
                  <textarea
                    value={displayedItem?.description || ''}
                    disabled={!editMode}
                    onChange={(event) => updateEditedItem({ description: event.target.value })}
                    rows={2}
                    placeholder="Description"
                    className="mb-2 w-full resize-none overflow-y-auto rounded-xl border border-[var(--color-bg-tertiary)] bg-[var(--color-bg-primary)] px-3 py-2 text-xs leading-5 text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none disabled:opacity-70"
                  />
                  <textarea
                    value={displayedItem?.variables || ''}
                    disabled={!editMode}
                    onChange={(event) => updateEditedItem({ variables: event.target.value })}
                    rows={5}
                    placeholder="Variables / params above gcode, for example: variable_name: value"
                    className="mb-2 w-full resize-y overflow-y-auto rounded-xl border border-[var(--color-bg-tertiary)] bg-[var(--color-bg-primary)] px-3 py-3 font-mono text-xs leading-5 text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none disabled:opacity-70"
                    style={{ minHeight: '72px', maxHeight: '180px' }}
                  />
                  <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--color-text-secondary)]">gcode:</div>
                  <textarea
                    value={displayedItem?.gcode || ''}
                    disabled={!editMode}
                    onChange={(event) => updateEditedItem({ gcode: parseMacroGcodeFromEditorView(event.target.value) })}
                    rows={12}
                    spellCheck={false}
                    className="w-full resize-y overflow-y-auto rounded-xl border border-[var(--color-bg-tertiary)] bg-[var(--color-bg-primary)] px-3 py-3 font-mono text-xs leading-5 text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none disabled:opacity-70"
                    style={{ minHeight: '80px', maxHeight: '250px' }}
                  />
                </div>

                <div className="min-w-0 rounded-xl border border-[var(--color-bg-tertiary)] bg-[var(--color-bg-primary)] p-3">
                  <div className="mb-3 flex items-center justify-between gap-3">
                    <div className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--color-text-secondary)]">Control</div>
                    <button disabled={!editMode} onClick={() => setShowCommandPicker(true)} className="rounded-md border border-[var(--color-bg-tertiary)] px-2 py-1 text-[10px] text-[var(--color-text-primary)] disabled:opacity-40">Commands</button>
                  </div>
                  <div className="mb-3 flex flex-wrap items-end gap-2 text-xs">
                    <label className="min-w-[8rem] flex-1">
                      <span className="mb-1 block text-[var(--color-text-secondary)]">Feedrate</span>
                      <input disabled={!editMode} value={moveFeedRate} onChange={(event) => setMoveFeedRate(event.target.value)} placeholder="Optional" className="w-full rounded-md border border-[var(--color-bg-tertiary)] bg-[var(--color-bg-secondary)] px-2 py-1.5 text-[var(--color-text-primary)] disabled:opacity-40" />
                    </label>
                    <button disabled={!editMode} onClick={() => appendGcode('G28')} className="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-xs font-semibold text-[var(--color-bg-primary)] disabled:opacity-40">Home all</button>
                    <button disabled={!editMode} onClick={() => appendGcode('M84')} className="rounded-md border border-[var(--color-bg-tertiary)] px-3 py-1.5 text-xs text-[var(--color-text-primary)] disabled:opacity-40">M84</button>
                  </div>
                  <div className="space-y-2 text-xs">
                    <div className="grid grid-cols-7 overflow-hidden rounded-lg border border-[var(--color-bg-tertiary)]">
                      <button disabled={!editMode} onClick={() => handleAxisJog('X', -100)} className="border-r border-[var(--color-bg-tertiary)] px-2 py-2 text-[var(--color-text-primary)] hover:bg-[var(--color-bg-secondary)] disabled:opacity-40">-100</button>
                      <button disabled={!editMode} onClick={() => handleAxisJog('X', -10)} className="border-r border-[var(--color-bg-tertiary)] px-2 py-2 text-[var(--color-text-primary)] hover:bg-[var(--color-bg-secondary)] disabled:opacity-40">-10</button>
                      <button disabled={!editMode} onClick={() => handleAxisJog('X', -1)} className="border-r border-[var(--color-bg-tertiary)] px-2 py-2 text-[var(--color-text-primary)] hover:bg-[var(--color-bg-secondary)] disabled:opacity-40">-1</button>
                      <button disabled={!editMode} onClick={() => appendGcode('G28 X')} className="border-r border-[var(--color-accent)] bg-[var(--color-accent)] px-2 py-2 font-semibold text-[var(--color-bg-primary)] disabled:opacity-40">X</button>
                      <button disabled={!editMode} onClick={() => handleAxisJog('X', 1)} className="border-r border-[var(--color-bg-tertiary)] px-2 py-2 text-[var(--color-text-primary)] hover:bg-[var(--color-bg-secondary)] disabled:opacity-40">+1</button>
                      <button disabled={!editMode} onClick={() => handleAxisJog('X', 10)} className="border-r border-[var(--color-bg-tertiary)] px-2 py-2 text-[var(--color-text-primary)] hover:bg-[var(--color-bg-secondary)] disabled:opacity-40">+10</button>
                      <button disabled={!editMode} onClick={() => handleAxisJog('X', 100)} className="px-2 py-2 text-[var(--color-text-primary)] hover:bg-[var(--color-bg-secondary)] disabled:opacity-40">+100</button>
                    </div>
                    <div className="grid grid-cols-7 overflow-hidden rounded-lg border border-[var(--color-bg-tertiary)]">
                      <button disabled={!editMode} onClick={() => handleAxisJog('Y', -100)} className="border-r border-[var(--color-bg-tertiary)] px-2 py-2 text-[var(--color-text-primary)] hover:bg-[var(--color-bg-secondary)] disabled:opacity-40">-100</button>
                      <button disabled={!editMode} onClick={() => handleAxisJog('Y', -10)} className="border-r border-[var(--color-bg-tertiary)] px-2 py-2 text-[var(--color-text-primary)] hover:bg-[var(--color-bg-secondary)] disabled:opacity-40">-10</button>
                      <button disabled={!editMode} onClick={() => handleAxisJog('Y', -1)} className="border-r border-[var(--color-bg-tertiary)] px-2 py-2 text-[var(--color-text-primary)] hover:bg-[var(--color-bg-secondary)] disabled:opacity-40">-1</button>
                      <button disabled={!editMode} onClick={() => appendGcode('G28 Y')} className="border-r border-[var(--color-accent)] bg-[var(--color-accent)] px-2 py-2 font-semibold text-[var(--color-bg-primary)] disabled:opacity-40">Y</button>
                      <button disabled={!editMode} onClick={() => handleAxisJog('Y', 1)} className="border-r border-[var(--color-bg-tertiary)] px-2 py-2 text-[var(--color-text-primary)] hover:bg-[var(--color-bg-secondary)] disabled:opacity-40">+1</button>
                      <button disabled={!editMode} onClick={() => handleAxisJog('Y', 10)} className="border-r border-[var(--color-bg-tertiary)] px-2 py-2 text-[var(--color-text-primary)] hover:bg-[var(--color-bg-secondary)] disabled:opacity-40">+10</button>
                      <button disabled={!editMode} onClick={() => handleAxisJog('Y', 100)} className="px-2 py-2 text-[var(--color-text-primary)] hover:bg-[var(--color-bg-secondary)] disabled:opacity-40">+100</button>
                    </div>
                    <div className="grid grid-cols-7 overflow-hidden rounded-lg border border-[var(--color-bg-tertiary)]">
                      <button disabled={!editMode} onClick={() => handleAxisJog('Z', -25)} className="border-r border-[var(--color-bg-tertiary)] px-2 py-2 text-[var(--color-text-primary)] hover:bg-[var(--color-bg-secondary)] disabled:opacity-40">-25</button>
                      <button disabled={!editMode} onClick={() => handleAxisJog('Z', -1)} className="border-r border-[var(--color-bg-tertiary)] px-2 py-2 text-[var(--color-text-primary)] hover:bg-[var(--color-bg-secondary)] disabled:opacity-40">-1</button>
                      <button disabled={!editMode} onClick={() => handleAxisJog('Z', -0.1)} className="border-r border-[var(--color-bg-tertiary)] px-2 py-2 text-[var(--color-text-primary)] hover:bg-[var(--color-bg-secondary)] disabled:opacity-40">-0.1</button>
                      <button disabled={!editMode} onClick={() => appendGcode('G28 Z')} className="border-r border-[var(--color-accent)] bg-[var(--color-accent)] px-2 py-2 font-semibold text-[var(--color-bg-primary)] disabled:opacity-40">Z</button>
                      <button disabled={!editMode} onClick={() => handleAxisJog('Z', 0.1)} className="border-r border-[var(--color-bg-tertiary)] px-2 py-2 text-[var(--color-text-primary)] hover:bg-[var(--color-bg-secondary)] disabled:opacity-40">+0.1</button>
                      <button disabled={!editMode} onClick={() => handleAxisJog('Z', 1)} className="border-r border-[var(--color-bg-tertiary)] px-2 py-2 text-[var(--color-text-primary)] hover:bg-[var(--color-bg-secondary)] disabled:opacity-40">+1</button>
                      <button disabled={!editMode} onClick={() => handleAxisJog('Z', 25)} className="px-2 py-2 text-[var(--color-text-primary)] hover:bg-[var(--color-bg-secondary)] disabled:opacity-40">+25</button>
                    </div>
                  </div>
                  <div className="mt-3 grid gap-2 text-xs [grid-template-columns:minmax(0,1.2fr)_minmax(0,1.2fr)_auto_auto]">
                    <label className="min-w-0">
                      <span className="mb-1 block text-[var(--color-text-secondary)]">Distance</span>
                      <input disabled={!editMode} value={extrudeDistance} onChange={(event) => setExtrudeDistance(event.target.value)} placeholder="Distance (mm)" className="w-full rounded-md border border-[var(--color-bg-tertiary)] bg-[var(--color-bg-secondary)] px-2 py-1.5 text-[var(--color-text-primary)] disabled:opacity-40" />
                    </label>
                    <label className="min-w-0">
                      <span className="mb-1 block text-[var(--color-text-secondary)]">Feedrate</span>
                      <input disabled={!editMode} value={extrudeFeedRate} onChange={(event) => setExtrudeFeedRate(event.target.value)} placeholder="Feedrate" className="w-full rounded-md border border-[var(--color-bg-tertiary)] bg-[var(--color-bg-secondary)] px-2 py-1.5 text-[var(--color-text-primary)] disabled:opacity-40" />
                    </label>
                    <button
                      disabled={!editMode}
                      onClick={() => appendExtrusionCommand(1)}
                      className="self-end rounded-md border border-[var(--color-bg-tertiary)] px-3 py-1.5 text-[var(--color-text-primary)] disabled:opacity-40"
                    >
                      Extrude
                    </button>
                    <button
                      disabled={!editMode}
                      onClick={() => appendExtrusionCommand(-1)}
                      className="self-end rounded-md border border-[var(--color-bg-tertiary)] px-3 py-1.5 text-[var(--color-text-primary)] disabled:opacity-40"
                    >
                      Retract
                    </button>
                  </div>
                  <div className="mt-3 grid gap-3 text-xs lg:grid-cols-2">
                    <div className="min-w-0">
                      <label className="mb-1 block text-[var(--color-text-secondary)]">Bed target</label>
                      <div className="flex items-center gap-1">
                        <input disabled={!editMode} value={bedTarget} onChange={(event) => setBedTarget(event.target.value)} className="w-16 min-w-0 rounded-md border border-[var(--color-bg-tertiary)] bg-[var(--color-bg-secondary)] px-2 py-1.5 text-[var(--color-text-primary)] disabled:opacity-40" />
                        <button disabled={!editMode} onClick={() => {
                          const target = Number(bedTarget);
                          if (!Number.isFinite(target) || target < 0 || target > machineProfile.bedMaxTemp) {
                            setMessage(`Bed target must be between 0 and ${machineProfile.bedMaxTemp}.`);
                            return;
                          }
                          appendGcode(`M140 S${target}`);
                        }} className="shrink-0 rounded-md border border-[var(--color-bg-tertiary)] px-2 text-[var(--color-text-primary)] disabled:opacity-40" title="Set bed temp (no wait)">Set</button>
                        <button disabled={!editMode} onClick={() => {
                          const target = Number(bedTarget);
                          if (!Number.isFinite(target) || target < 0 || target > machineProfile.bedMaxTemp) {
                            setMessage(`Bed target must be between 0 and ${machineProfile.bedMaxTemp}.`);
                            return;
                          }
                          appendGcode(`M190 S${target}`);
                        }} className="shrink-0 rounded-md border border-[var(--color-bg-tertiary)] px-2 text-[var(--color-text-primary)] disabled:opacity-40" title="Set bed temp and wait">Wait</button>
                      </div>
                    </div>
                    <div className="min-w-0">
                      <label className="mb-1 block text-[var(--color-text-secondary)]">Nozzle target</label>
                      <div className="flex items-center gap-1">
                        <input disabled={!editMode} value={nozzleTarget} onChange={(event) => setNozzleTarget(event.target.value)} className="w-16 min-w-0 rounded-md border border-[var(--color-bg-tertiary)] bg-[var(--color-bg-secondary)] px-2 py-1.5 text-[var(--color-text-primary)] disabled:opacity-40" />
                        <button disabled={!editMode} onClick={() => {
                          const target = Number(nozzleTarget);
                          if (!Number.isFinite(target) || target < 0 || target > machineProfile.nozzleMaxTemp) {
                            setMessage(`Nozzle target must be between 0 and ${machineProfile.nozzleMaxTemp}.`);
                            return;
                          }
                          appendGcode(`M104 S${target}`);
                        }} className="shrink-0 rounded-md border border-[var(--color-bg-tertiary)] px-2 text-[var(--color-text-primary)] disabled:opacity-40" title="Set nozzle temp (no wait)">Set</button>
                        <button disabled={!editMode} onClick={() => {
                          const target = Number(nozzleTarget);
                          if (!Number.isFinite(target) || target < 0 || target > machineProfile.nozzleMaxTemp) {
                            setMessage(`Nozzle target must be between 0 and ${machineProfile.nozzleMaxTemp}.`);
                            return;
                          }
                          appendGcode(`M109 S${target}`);
                        }} className="shrink-0 rounded-md border border-[var(--color-bg-tertiary)] px-2 text-[var(--color-text-primary)] disabled:opacity-40" title="Set nozzle temp and wait">Wait</button>
                      </div>
                    </div>
                  </div>
                  <div className="mt-3 grid gap-3 text-xs lg:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)]">
                    <div className="min-w-0">
                      <label className="mb-1 block text-[var(--color-text-secondary)]">LED status</label>
                      <div className="flex flex-wrap items-center gap-2">
                        <input disabled={!editMode} value={ledName} onChange={(event) => setLedName(event.target.value)} placeholder="Name" className="min-w-[8rem] flex-1 rounded-md border border-[var(--color-bg-tertiary)] bg-[var(--color-bg-secondary)] px-2 py-1.5 text-[var(--color-text-primary)] disabled:opacity-40" />
                        <input disabled={!editMode} type="color" value={ledColor} onChange={(event) => setLedColor(event.target.value)} className="h-9 w-14 shrink-0 rounded-md border border-[var(--color-bg-tertiary)] bg-[var(--color-bg-secondary)] disabled:opacity-40" />
                        <button onClick={() => {
                          const red = parseInt(ledColor.slice(1, 3), 16) / 255;
                          const green = parseInt(ledColor.slice(3, 5), 16) / 255;
                          const blue = parseInt(ledColor.slice(5, 7), 16) / 255;
                          appendGcode(`SET_LED LED=${ledName || 'status_led'} RED=${red.toFixed(3)} GREEN=${green.toFixed(3)} BLUE=${blue.toFixed(3)}`);
                        }} className="shrink-0 rounded-md border border-[var(--color-bg-tertiary)] px-3 py-1.5 text-[var(--color-text-primary)] disabled:opacity-40" disabled={!editMode}>Add</button>
                      </div>
                    </div>
                    <div className="min-w-0">
                      <label className="mb-1 block text-[var(--color-text-secondary)]">Terminal message</label>
                      <div className="flex flex-wrap gap-2">
                        <input disabled={!editMode} value={terminalMessage} onChange={(event) => setTerminalMessage(event.target.value)} className="min-w-[10rem] flex-1 rounded-md border border-[var(--color-bg-tertiary)] bg-[var(--color-bg-secondary)] px-2 py-1.5 text-[var(--color-text-primary)] disabled:opacity-40" />
                        <button disabled={!editMode} onClick={() => appendGcode(`RESPOND MSG="${terminalMessage.replace(/"/g, '')}"`)} className="shrink-0 rounded-md border border-[var(--color-bg-tertiary)] px-3 py-1.5 text-[var(--color-text-primary)] disabled:opacity-40">Add</button>
                      </div>
                    </div>
                  </div>
                </div>
                {message && <div className="rounded-xl border border-[var(--color-bg-tertiary)] bg-[var(--color-bg-primary)] px-3 py-2 text-[11px] text-[var(--color-text-secondary)]">{message}</div>}
              </div>
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-[var(--color-text-secondary)]">Select or create a macro to start.</div>
            )}
          </aside>
        </div>

        {showExitDialog && (
          <div className="fixed inset-0 z-[68] flex items-center justify-center bg-black/45" onClick={() => setShowExitDialog(false)}>
            <div className="w-[min(92vw,760px)] rounded-xl border border-[var(--color-bg-tertiary)] bg-[var(--color-bg-secondary)] p-4 shadow-2xl" onClick={(event) => event.stopPropagation()}>
              <div className="mb-4 flex items-start justify-between gap-4">
                <div>
                  <div className="text-sm font-semibold text-[var(--color-text-primary)]">Unapplied macro changes</div>
                  <p className="mt-1 text-xs text-[var(--color-text-secondary)]">
                    Apply any changed macros before closing, or close now and keep the drafts for later.
                  </p>
                </div>
                <button onClick={() => setShowExitDialog(false)} className="rounded-md border border-[var(--color-bg-tertiary)] px-2 py-1 text-xs text-[var(--color-text-primary)]">Back</button>
              </div>

              <div className="space-y-2">
                {pendingExitItems.map((item) => {
                  const destinationFile = getExitTargetFile(item);
                  const actionState = getMacroActionState(item, destinationFile);
                  return (
                    <div key={item.key} className="grid gap-3 rounded-lg border border-[var(--color-bg-tertiary)] bg-[var(--color-bg-primary)] px-3 py-3 md:grid-cols-[minmax(0,1fr)_12rem_auto] md:items-center">
                      <div className="min-w-0">
                        <div className="truncate text-xs font-semibold text-[var(--color-text-primary)]">{item.title}</div>
                        <div className="mt-1 text-[11px] text-[var(--color-text-secondary)]">
                          {item.source === 'config' && item.sourceFile
                            ? `Edited macro from ${item.sourceFile}`
                            : 'New macro draft'}
                        </div>
                      </div>
                      <select
                        value={destinationFile}
                        onChange={(event) => setExitTargetOverrides((current) => ({ ...current, [item.key]: event.target.value }))}
                        className="rounded-md border border-[var(--color-bg-tertiary)] bg-[var(--color-bg-secondary)] px-3 py-2 text-xs text-[var(--color-text-primary)]"
                      >
                        {Object.keys(configFiles).map((filename) => (
                          <option key={`${item.key}:${filename}`} value={filename}>{filename}</option>
                        ))}
                      </select>
                      <button
                        onClick={() => {
                          applyMacroItemToConfiguration(item, destinationFile);
                        }}
                        disabled={actionState.disabled}
                        className="rounded-md bg-green-600 px-3 py-2 text-xs font-semibold text-white disabled:opacity-40"
                      >
                        {actionState.label}
                      </button>
                    </div>
                  );
                })}
              </div>

              <div className="mt-4 flex justify-end gap-2">
                <button
                  onClick={() => setShowExitDialog(false)}
                  className="rounded-md border border-[var(--color-bg-tertiary)] px-3 py-1.5 text-xs text-[var(--color-text-primary)]"
                >
                  Keep editing
                </button>
                <button
                  onClick={() => {
                    setShowExitDialog(false);
                    onClose();
                  }}
                  className="rounded-md bg-[var(--color-bg-tertiary)] px-3 py-1.5 text-xs font-medium text-[var(--color-text-primary)] hover:bg-[var(--color-accent)] hover:text-[var(--color-bg-primary)]"
                >
                  Close and keep drafts
                </button>
              </div>
            </div>
          </div>
        )}

        {showCommandPicker && (
          <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/45" onClick={() => setShowCommandPicker(false)}>
            <div className="w-[720px] max-w-[95vw] rounded-xl border border-[var(--color-bg-tertiary)] bg-[var(--color-bg-secondary)] p-4 shadow-2xl" onClick={(event) => event.stopPropagation()}>
              <div className="mb-3 flex items-center justify-between gap-2">
                <div className="text-sm font-semibold text-[var(--color-text-primary)]">Supported gcode commands</div>
                <button onClick={() => setShowCommandPicker(false)} className="rounded-md border border-[var(--color-bg-tertiary)] px-2 py-1 text-xs text-[var(--color-text-primary)]">Close</button>
              </div>
              <input
                value={commandSearch}
                onChange={(event) => setCommandSearch(event.target.value)}
                placeholder="Filter commands..."
                className="mb-3 w-full rounded-md border border-[var(--color-bg-tertiary)] bg-[var(--color-bg-primary)] px-3 py-2 text-xs text-[var(--color-text-primary)]"
              />
              <div className="max-h-[55vh] overflow-y-auto rounded-lg border border-[var(--color-bg-tertiary)]">
                {visibleSupportedCommands.map((entry) => (
                  <button
                    key={entry.command}
                    onClick={() => {
                      appendGcode(entry.format);
                      setShowCommandPicker(false);
                    }}
                    disabled={!editMode}
                    className="w-full border-b border-[var(--color-bg-tertiary)] px-3 py-2 text-left last:border-b-0 disabled:opacity-40"
                  >
                    <div className="text-xs font-semibold text-[var(--color-text-primary)]">{entry.command}</div>
                    <div className="mt-0.5 font-mono text-[11px] text-[var(--color-accent)]">{entry.format}</div>
                    <div className="mt-0.5 text-[11px] text-[var(--color-text-secondary)]">{entry.description}</div>
                  </button>
                ))}
                {!visibleSupportedCommands.length && (
                  <div className="px-3 py-4 text-xs text-[var(--color-text-secondary)]">No matching commands.</div>
                )}
              </div>
            </div>
          </div>
        )}

        {exactPositionDialog && (
          <div className="fixed inset-0 z-[72] flex items-center justify-center bg-black/45" onClick={() => setExactPositionDialog(null)}>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                handleApplyExactPosition();
              }}
              className="w-[360px] max-w-[95vw] rounded-xl border border-[var(--color-bg-tertiary)] bg-[var(--color-bg-secondary)] p-4 shadow-2xl"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="mb-3 flex items-center justify-between gap-2">
                <div>
                  <div className="text-sm font-semibold text-[var(--color-text-primary)]">Set exact position</div>
                  <div className="text-[11px] text-[var(--color-text-secondary)]">{exactPositionDialog.target === 'dock' ? 'Dock position' : 'No-go zone bounds'}</div>
                </div>
                <button type="button" onClick={() => setExactPositionDialog(null)} className="rounded-md border border-[var(--color-bg-tertiary)] px-2 py-1 text-xs text-[var(--color-text-primary)]">Close</button>
              </div>
              <div className="grid grid-cols-2 gap-3 text-xs">
                <label>
                  <span className="mb-1 block text-[var(--color-text-secondary)]">X</span>
                  <input
                    value={exactPositionDialog.x}
                    onChange={(event) => setExactPositionDialog((current) => (current ? { ...current, x: event.target.value } : current))}
                    className="w-full rounded-md border border-[var(--color-bg-tertiary)] bg-[var(--color-bg-primary)] px-2 py-1.5 text-[var(--color-text-primary)]"
                    autoFocus
                  />
                </label>
                <label>
                  <span className="mb-1 block text-[var(--color-text-secondary)]">Y</span>
                  <input
                    value={exactPositionDialog.y}
                    onChange={(event) => setExactPositionDialog((current) => (current ? { ...current, y: event.target.value } : current))}
                    className="w-full rounded-md border border-[var(--color-bg-tertiary)] bg-[var(--color-bg-primary)] px-2 py-1.5 text-[var(--color-text-primary)]"
                  />
                </label>
                {exactPositionDialog.target === 'zone' && (
                  <>
                    <label>
                      <span className="mb-1 block text-[var(--color-text-secondary)]">Width</span>
                      <input
                        value={exactPositionDialog.width}
                        onChange={(event) => setExactPositionDialog((current) => (current ? { ...current, width: event.target.value } : current))}
                        className="w-full rounded-md border border-[var(--color-bg-tertiary)] bg-[var(--color-bg-primary)] px-2 py-1.5 text-[var(--color-text-primary)]"
                      />
                    </label>
                    <label>
                      <span className="mb-1 block text-[var(--color-text-secondary)]">Height</span>
                      <input
                        value={exactPositionDialog.height}
                        onChange={(event) => setExactPositionDialog((current) => (current ? { ...current, height: event.target.value } : current))}
                        className="w-full rounded-md border border-[var(--color-bg-tertiary)] bg-[var(--color-bg-primary)] px-2 py-1.5 text-[var(--color-text-primary)]"
                      />
                    </label>
                  </>
                )}
              </div>
              <div className="mt-4 flex justify-end gap-2">
                <button type="button" onClick={() => setExactPositionDialog(null)} className="rounded-md border border-[var(--color-bg-tertiary)] px-3 py-1.5 text-xs text-[var(--color-text-primary)]">Cancel</button>
                <button type="submit" className="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-xs font-semibold text-[var(--color-bg-primary)]">Apply</button>
              </div>
            </form>
          </div>
        )}

        {canvasContextMenu && (
          <div
            className="fixed z-[65] min-w-[180px] rounded-lg border border-[var(--color-bg-tertiary)] bg-[var(--color-bg-secondary)] py-1 shadow-xl"
            style={{ left: canvasContextMenu.x, top: canvasContextMenu.y }}
            onClick={(event) => event.stopPropagation()}
          >
            {canvasContextMenu.target === 'zone' && canvasContextMenu.zoneId && (
              <>
                <button
                  onClick={() => {
                    const source = noGoZones.find((zone) => zone.id === canvasContextMenu.zoneId);
                    if (source) {
                      const copy = addNoGoZone({
                        x: clamp(source.x + 5, machineProfile.moveMinX, machineProfile.moveMaxX - source.width),
                        y: clamp(source.y + 5, machineProfile.moveMinY, machineProfile.moveMaxY - source.height),
                        width: source.width,
                        height: source.height,
                        name: `${source.name} Copy`,
                      });
                      setSelectedZoneId(copy.id);
                    }
                    setCanvasContextMenu(null);
                  }}
                  className="w-full px-4 py-2 text-left text-xs text-[var(--color-text-primary)] hover:bg-[var(--color-bg-primary)]"
                >
                  Copy no-go zone
                </button>
                <button
                  onClick={() => {
                    openExactPositionDialog('zone', canvasContextMenu.zoneId);
                    setCanvasContextMenu(null);
                  }}
                  className="w-full px-4 py-2 text-left text-xs text-[var(--color-text-primary)] hover:bg-[var(--color-bg-primary)]"
                >
                  Set exact position
                </button>
              </>
            )}
            {canvasContextMenu.target === 'dock' && (
              <button
                onClick={() => {
                  openExactPositionDialog('dock');
                  setCanvasContextMenu(null);
                }}
                className="w-full px-4 py-2 text-left text-xs text-[var(--color-text-primary)] hover:bg-[var(--color-bg-primary)]"
              >
                Set exact position
              </button>
            )}
            <button
              onClick={() => {
                if (canvasContextMenu.target === 'zone' && canvasContextMenu.zoneId) {
                  const zone = noGoZones.find((item) => item.id === canvasContextMenu.zoneId);
                  if (zone) {
                    deleteNoGoZone(zone.id);
                    setMessage(`Deleted ${zone.name}.`);
                  }
                } else if (canvasContextMenu.target === 'dock') {
                  setDockPosition(null);
                  setMessage('Dock deleted.');
                }
                setCanvasContextMenu(null);
              }}
              className="w-full px-4 py-2 text-left text-xs text-red-300 hover:bg-red-400/10"
            >
              Delete
            </button>
          </div>
        )}

        {/* Context menu */}
        {contextMenu && (
          <div
            className="fixed z-[60] min-w-[140px] rounded-lg border border-[var(--color-bg-tertiary)] bg-[var(--color-bg-secondary)] py-1 shadow-xl"
            style={{ left: contextMenu.x, top: contextMenu.y }}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              onClick={() => { handleCopy(contextMenu.itemKey); setContextMenu(null); }}
              className="w-full px-4 py-2 text-left text-xs text-[var(--color-text-primary)] hover:bg-[var(--color-bg-primary)]"
            >Copy</button>
            {contextMenu.itemSource !== 'playback' && (
              <button
                onClick={() => { handleRename(contextMenu.itemKey); setContextMenu(null); }}
                className="w-full px-4 py-2 text-left text-xs text-[var(--color-text-primary)] hover:bg-[var(--color-bg-primary)]"
              >Rename</button>
            )}
            {contextMenu.draftId && (
              <button
                onClick={() => { handleDelete(contextMenu.draftId!); setContextMenu(null); }}
                className="w-full px-4 py-2 text-left text-xs text-red-300 hover:bg-red-400/10"
              >Delete</button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
