import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useConfigStore } from '../../stores/configStore';
import { useGraphStore } from '../../stores/graphStore';
import { createDefaultDraft, useMacroDesignerStore } from '../../stores/macroDesignerStore';
import * as api from '../../services/api';
import type { ConfigFile, ConfigSection } from '../../types/config';
import type {
  MachineProfile,
  MacroRuntimeState,
  MacroSourceItem,
  SimulationStep,
} from '../../types/macroDesigner';
import {
  createMachineProfile,
  deriveAvailableBuiltInMacros,
  deriveCurrentMacroItems,
  findPathZoneHit,
  findZoneHit,
  fuzzyFilterItems,
  isPointInBounds,
  normalizeMacroGcodeForConfig,
  parseMacroVariables,
  sanitizeMacroName,
  serializeMacroVariables,
} from '../../utils/macroDesigner';
import {
  buildSimulationSteps,
  createInitialRuntimeState,
  executeSimulationStep,
} from '../../utils/gcodeSimulator';

interface MacroDesignerDialogProps {
  onClose: () => void;
}

interface WorkingCopies {
  [key: string]: MacroSourceItem;
}

interface ToolheadPosition {
  x: number;
  y: number;
  z: number;
}

interface ContextMenuState {
  x: number;
  y: number;
  itemKey: string;
  itemSource: string;
  draftId: string | null;
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
  summary: string;
  warnings: string[];
}

const AXIS_LABELS: Record<number, { tl: string; tr: string; bl: string; br: string }> = {
  0:   { tl: '+Y', tr: '+X', bl: '-X', br: '-Y' },
  90:  { tl: '+X', tr: '-Y', bl: '+Y', br: '-X' },
  180: { tl: '-Y', tr: '-X', bl: '+X', br: '+Y' },
  270: { tl: '-X', tr: '+Y', bl: '-Y', br: '+X' },
};

function createGcodeMacroSection(item: MacroSourceItem): ConfigSection {
  const params = [];
  if (item.renameExisting.trim()) {
    params.push({ key: 'rename_existing', value: item.renameExisting.trim(), comment: '', is_commented_out: false });
  }
  if (item.description.trim()) {
    params.push({ key: 'description', value: item.description.trim(), comment: '', is_commented_out: false });
  }
  params.push(...parseMacroVariables(item.variables));
  params.push({ key: 'gcode', value: normalizeMacroGcodeForConfig(item.gcode), comment: '', is_commented_out: false });
  return {
    section_type: 'gcode_macro',
    section_name: sanitizeMacroName(item.title),
    full_header: `gcode_macro ${sanitizeMacroName(item.title)}`,
    line_number: 0,
    params,
    header_comments: [],
    trailing_comments: [],
    is_commented_out: false,
  };
}

function getSectionParamValue(section: ConfigSection | undefined, key: string): string {
  return section?.params.find((param) => param.key === key && !param.is_commented_out)?.value || '';
}

function formatNumber(value: number): string {
  if (value == null || !Number.isFinite(value)) return '0';
  return Number.isInteger(value) ? `${value}` : value.toFixed(2);
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

export default function MacroDesignerDialog({ onClose }: MacroDesignerDialogProps) {
  const configFiles = useConfigStore((state) => state.configFiles);
  const activeFile = useConfigStore((state) => state.activeFile);
  const originalTexts = useConfigStore((state) => state.originalTexts);
  const upsertSection = useConfigStore((state) => state.upsertSection);
  const updateSectionParam = useConfigStore((state) => state.updateSectionParam);
  const addParam = useConfigStore((state) => state.addParam);
  const drafts = useMacroDesignerStore((state) => state.drafts);
  const rotation = useMacroDesignerStore((state) => state.rotation);
  const noGoZones = useMacroDesignerStore((state) => state.noGoZones);
  const dockPosition = useMacroDesignerStore((state) => state.dockPosition);
  const createDraft = useMacroDesignerStore((state) => state.createDraft);
  const updateDraft = useMacroDesignerStore((state) => state.updateDraft);
  const duplicateDraft = useMacroDesignerStore((state) => state.duplicateDraft);
  const deleteDraft = useMacroDesignerStore((state) => state.deleteDraft);
  const setRotation = useMacroDesignerStore((state) => state.setRotation);
  const addNoGoZone = useMacroDesignerStore((state) => state.addNoGoZone);
  const updateNoGoZone = useMacroDesignerStore((state) => state.updateNoGoZone);
  const setDockPosition = useMacroDesignerStore((state) => state.setDockPosition);

  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [showBuiltIns, setShowBuiltIns] = useState(true);
  const [editMode, setEditMode] = useState(false);
  const [savedConfigFiles, setSavedConfigFiles] = useState<Record<string, ConfigFile>>({});
  const [workingCopies, setWorkingCopies] = useState<WorkingCopies>({});
  const [targetFile, setTargetFile] = useState(() => (configFiles['printer.cfg'] ? 'printer.cfg' : activeFile));
  const [message, setMessage] = useState<string | null>(null);
  const [runtime, setRuntime] = useState<MacroRuntimeState | null>(null);
  const [stepIndex, setStepIndex] = useState(0);
  const [planWarnings, setPlanWarnings] = useState<string[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [moveFeedRate, setMoveFeedRate] = useState('3000');
  const [nozzleTarget, setNozzleTarget] = useState('200');
  const [bedTarget, setBedTarget] = useState('60');
  const [fanPercent, setFanPercent] = useState('100');
  const [ledName, setLedName] = useState('status_led');
  const [ledColor, setLedColor] = useState('#00ffaa');
  const [terminalMessage, setTerminalMessage] = useState('Macro designer');
  const [moveMode, setMoveMode] = useState<'absolute' | 'relative'>('absolute');
  const [zMoveIndicator, setZMoveIndicator] = useState<'up' | 'down' | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [dragState, setDragState] = useState<DragState | null>(null);
  const [toolheadDragPos, setToolheadDragPos] = useState<ToolheadPosition | null>(null);
  const [editDraft, setEditDraft] = useState<MacroSourceItem | null>(null);
  const [runtimeHistory, setRuntimeHistory] = useState<MacroRuntimeState[]>([]);
  const [simulationLog, setSimulationLog] = useState<SimulationLogEntry[]>([]);
  const [selectedLogWarning, setSelectedLogWarning] = useState<string | null>(null);
  const [goToX, setGoToX] = useState('');
  const [goToY, setGoToY] = useState('');
  const [goToZ, setGoToZ] = useState('');
  const svgRef = useRef<SVGSVGElement>(null);
  const toolheadPositionRef = useRef<ToolheadPosition | null>(null);
  const zWheelStartRef = useRef<ToolheadPosition | null>(null);
  const zWheelTimeoutRef = useRef<number | null>(null);

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

  useEffect(() => {
    if (!selectedKey) {
      const firstDraft = drafts[0];
      const firstConfigMacro = deriveCurrentMacroItems(configFiles)[0];
      const first = firstDraft ? `draft:${firstDraft.id}` : firstConfigMacro?.key || null;
      setSelectedKey(first);
    }
  }, [configFiles, drafts, selectedKey]);

  const configMacroItems = useMemo(() => deriveCurrentMacroItems(configFiles), [configFiles]);
  const draftItems = useMemo<MacroSourceItem[]>(() => drafts.map((draft) => ({
    key: `draft:${draft.id}`,
    source: 'draft',
    title: draft.title,
    renameExisting: draft.renameExisting,
    description: draft.description,
    variables: draft.variables,
    gcode: draft.gcode,
  })), [drafts]);
  const builtInItems = useMemo(() => deriveAvailableBuiltInMacros(savedConfigFiles), [savedConfigFiles]);

  const visibleDraftItems = useMemo(() => fuzzyFilterItems(draftItems, search), [draftItems, search]);
  const visibleConfigItems = useMemo(() => fuzzyFilterItems(configMacroItems, search), [configMacroItems, search]);
  const visibleBuiltIns = useMemo(() => fuzzyFilterItems(builtInItems, search), [builtInItems, search]);
  const allMacroItems = useMemo(() => [...draftItems, ...configMacroItems, ...builtInItems], [builtInItems, configMacroItems, draftItems]);

  const selectedItem = useMemo(() => {
    if (!selectedKey) return null;
    const directMatch = allMacroItems.find((item) => item.key === selectedKey);
    if (directMatch?.source === 'draft') return directMatch;
    return workingCopies[selectedKey] || directMatch || null;
  }, [allMacroItems, selectedKey, workingCopies]);

  const displayedItem = editMode && editDraft ? editDraft : selectedItem;

  const machineProfile = useMemo(() => createMachineProfile(configFiles, noGoZones, dockPosition), [configFiles, dockPosition, noGoZones]);

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

  const simulationPlan = useMemo(() => {
    if (!selectedItem) {
      return { steps: [], warnings: [] };
    }
    return buildSimulationSteps(selectedItem, allMacroItems, machineProfile);
  }, [allMacroItems, machineProfile, selectedItem]);

  useEffect(() => {
    setPlanWarnings(simulationPlan.warnings);
    setRuntime(selectedItem ? createInitialRuntimeState(machineProfile, selectedItem.title) : null);
    setRuntimeHistory([]);
    setSimulationLog([]);
    setSelectedLogWarning(null);
    setStepIndex(0);
    setIsRunning(false);
  }, [machineProfile, selectedItem, simulationPlan.warnings]);

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

  useEffect(() => () => {
    if (zWheelTimeoutRef.current !== null) {
      window.clearTimeout(zWheelTimeoutRef.current);
    }
  }, []);

  useEffect(() => {
    if (!isRunning || !runtime) return;
    const id = window.setInterval(() => {
      setRuntime((current) => {
        if (!current) return current;
        const step = simulationPlan.steps[stepIndex];
        if (!step) {
          setIsRunning(false);
          return current;
        }
        const result = executeSimulationStep(current, step, machineProfile);
        const source = getStepSource(step);
        setRuntimeHistory((prev) => [...prev, current]);
        setSimulationLog((prev) => [...prev, {
          id: `${stepIndex}-${source.sourceName}-${source.lineNumber}`,
          raw: source.raw,
          sourceName: source.sourceName,
          lineNumber: source.lineNumber,
          summary: result.eventSummary,
          warnings: result.warnings,
        }]);
        setStepIndex((prev) => prev + 1);
        return result.nextState;
      });
    }, 350);
    return () => window.clearInterval(id);
  }, [isRunning, machineProfile, runtime, simulationPlan.steps, stepIndex]);

  useEffect(() => {
    if (stepIndex >= simulationPlan.steps.length && isRunning) {
      setIsRunning(false);
    }
  }, [isRunning, simulationPlan.steps.length, stepIndex]);

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

  const selectedDraftId = selectedItem?.source === 'draft' ? selectedItem.key.replace(/^draft:/, '') : null;

  const selectedMacroSection = useMemo(() => (
    selectedItem ? createGcodeMacroSection(selectedItem) : null
  ), [selectedItem]);

  const existingTargetSection = useMemo(() => {
    if (!selectedMacroSection || !targetFile) return null;
    return configFiles[targetFile]?.sections.find((candidate) => candidate.full_header === selectedMacroSection.full_header) || null;
  }, [configFiles, selectedMacroSection, targetFile]);

  const isTargetSectionUnchanged = useMemo(() => {
    if (!selectedItem || !selectedMacroSection || !existingTargetSection) return false;
    return (
      getSectionParamValue(existingTargetSection, 'gcode') === normalizeMacroGcodeForConfig(selectedItem.gcode)
      && getSectionParamValue(existingTargetSection, 'rename_existing') === selectedItem.renameExisting
      && getSectionParamValue(existingTargetSection, 'description') === selectedItem.description
      && serializeMacroVariables(existingTargetSection) === selectedItem.variables
    );
  }, [existingTargetSection, selectedItem, selectedMacroSection]);

  const addToConfigurationState = useMemo(() => {
    if (!selectedItem || selectedItem.source === 'builtin' || !targetFile || !selectedMacroSection) {
      return { disabled: true, label: 'Add to configuration' };
    }
    if (!existingTargetSection) {
      return { disabled: false, label: 'Add to configuration' };
    }
    if (isTargetSectionUnchanged) {
      return { disabled: true, label: 'Add to configuration' };
    }
    return { disabled: false, label: 'Apply Changes' };
  }, [existingTargetSection, isTargetSectionUnchanged, selectedItem, selectedMacroSection, targetFile]);

  const updateEditedItem = (updates: Partial<MacroSourceItem>) => {
    if (!editMode) return;
    setEditDraft((current) => (current ? { ...current, ...updates } : current));
  };

  const handleSaveEdit = () => {
    if (!editDraft || !selectedItem || !selectedKey) return;
    if (selectedItem.source === 'draft' && selectedDraftId) {
      updateDraft(selectedDraftId, {
        title: editDraft.title,
        renameExisting: editDraft.renameExisting,
        description: editDraft.description,
        variables: editDraft.variables,
        gcode: editDraft.gcode,
      });
    } else {
      setWorkingCopies((current) => ({
        ...current,
        [selectedKey]: editDraft,
      }));
    }
    setEditMode(false);
    setEditDraft(null);
    setMessage(null);
  };

  const handleCancelEdit = () => {
    setEditMode(false);
    setEditDraft(null);
    setMessage(null);
  };

  const handleToggleEdit = () => {
    if (!selectedItem) return;
    if (editMode) {
      handleSaveEdit();
      return;
    }
    setEditDraft({ ...selectedItem });
    setEditMode(true);
    setMessage(null);
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

  const getCurrentToolheadPosition = (): ToolheadPosition | null => toolheadPositionRef.current;

  const validateToolheadMove = (from: ToolheadPosition, to: ToolheadPosition): string | null => {
    if (!isPointInBounds(machineProfile, to.x, to.y)) {
      return 'That move exceeds the configured build volume.';
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
    const isChanged = (left: number, right: number) => Math.abs(left - right) > 1e-6;
    if (mode === 'relative') {
      const deltas = [
        isChanged(from.x, to.x) ? `X${formatNumber(to.x - from.x)}` : null,
        isChanged(from.y, to.y) ? `Y${formatNumber(to.y - from.y)}` : null,
        isChanged(from.z, to.z) ? `Z${formatNumber(to.z - from.z)}` : null,
      ].filter(Boolean);
      if (!deltas.length) return [];
      return [`G0 ${deltas.join(' ')} F${moveFeedRate || '3000'}`];
    }

    const axes = [
      isChanged(from.x, to.x) ? `X${formatNumber(to.x)}` : null,
      isChanged(from.y, to.y) ? `Y${formatNumber(to.y)}` : null,
      isChanged(from.z, to.z) ? `Z${formatNumber(to.z)}` : null,
    ].filter(Boolean);
    if (!axes.length) return [];
    return [`G0 ${axes.join(' ')} F${moveFeedRate || '3000'}`];
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
    if (selectedDraftId === id) {
      setSelectedKey(null);
    }
  };

  const handleRename = (itemKey?: string) => {
    const key = itemKey || selectedKey;
    if (key) {
      setSelectedKey(key);
      setEditMode(true);
    }
  };

  const handleStep = () => {
    if (!runtime) return;
    setToolheadDragPos(null);
    const step = simulationPlan.steps[stepIndex];
    if (!step) return;
    const result = executeSimulationStep(runtime, step, machineProfile);
    const source = getStepSource(step);
    setRuntimeHistory((prev) => [...prev, runtime]);
    setRuntime(result.nextState);
    setSimulationLog((prev) => [...prev, {
      id: `${stepIndex}-${source.sourceName}-${source.lineNumber}`,
      raw: source.raw,
      sourceName: source.sourceName,
      lineNumber: source.lineNumber,
      summary: result.eventSummary,
      warnings: result.warnings,
    }]);
    setStepIndex((prev) => prev + 1);
  };

  const handleStepBack = () => {
    if (!runtimeHistory.length) return;
    setIsRunning(false);
    setToolheadDragPos(null);
    const previousRuntime = runtimeHistory[runtimeHistory.length - 1];
    setRuntime(previousRuntime);
    setRuntimeHistory((prev) => prev.slice(0, -1));
    setSimulationLog((prev) => prev.slice(0, -1));
    setSelectedLogWarning(null);
    setStepIndex((prev) => Math.max(0, prev - 1));
  };

  const handleReset = () => {
    if (!selectedItem) return;
    setRuntime(createInitialRuntimeState(machineProfile, selectedItem.title));
    setStepIndex(0);
    setIsRunning(false);
    setToolheadDragPos(null);
    setRuntimeHistory([]);
    setSimulationLog([]);
    setSelectedLogWarning(null);
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

    const x = hasX ? (moveMode === 'relative' ? currentPosition.x + rawX : rawX) : currentPosition.x;
    const y = hasY ? (moveMode === 'relative' ? currentPosition.y + rawY : rawY) : currentPosition.y;
    const z = hasZ ? (moveMode === 'relative' ? currentPosition.z + rawZ : rawZ) : currentPosition.z;

    const cx = clamp(x, machineProfile.moveMinX, machineProfile.moveMaxX);
    const cy = clamp(y, machineProfile.moveMinY, machineProfile.moveMaxY);
    const cz = clamp(z, machineProfile.minZ, machineProfile.maxZ);
    const nextPosition = { x: cx, y: cy, z: cz };
    const moveValidation = validateToolheadMove(currentPosition, nextPosition);
    if (moveValidation) {
      setMessage(moveValidation);
      return;
    }

    const moveLines = buildMoveLines(currentPosition, nextPosition, moveMode);
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

    const moveLines = buildMoveLines(currentPosition, nextPosition, moveMode);
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
    const moveLines = buildMoveLines(start, current, moveMode);
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
    if (!selectedItem || !targetFile || !selectedMacroSection) return;
    if (existingTargetSection && isTargetSectionUnchanged) {
      return;
    }

    const existingGcode = getSectionParamValue(existingTargetSection || undefined, 'gcode');
    const existingRename = getSectionParamValue(existingTargetSection || undefined, 'rename_existing');
    const existingDescription = getSectionParamValue(existingTargetSection || undefined, 'description');
    const existingVariables = existingTargetSection ? serializeMacroVariables(existingTargetSection) : '';
    const selectedGcode = normalizeMacroGcodeForConfig(selectedItem.gcode);
    const sameHeader = existingTargetSection?.full_header === selectedMacroSection.full_header;
    const structuralChanged = existingRename !== selectedItem.renameExisting
      || existingDescription !== selectedItem.description
      || existingVariables !== selectedItem.variables;

    if (existingTargetSection && sameHeader) {
      if (structuralChanged) {
        upsertSection(targetFile, selectedMacroSection, existingTargetSection.full_header);
      } else if (existingGcode !== selectedGcode) {
        if (existingTargetSection.params.some((param) => param.key === 'gcode' && !param.is_commented_out)) {
          updateSectionParam(targetFile, existingTargetSection.full_header, 'gcode', selectedGcode);
        } else {
          addParam(targetFile, existingTargetSection.full_header, { key: 'gcode', value: selectedGcode, comment: '', is_commented_out: false });
        }
      }
    } else {
      upsertSection(
        targetFile,
        selectedMacroSection,
        existingTargetSection?.full_header,
      );
    }

    const graphStore = useGraphStore.getState();
    const alreadyInGraph = graphStore.nodes.some((node) => {
      const data = node.data as Record<string, unknown>;
      if (data.sectionHeader === selectedMacroSection.full_header && data.configFile === targetFile) {
        return true;
      }
      const children = data.children as Array<{ sectionHeader?: string; configFile?: string }> | undefined;
      return !!children?.some((child) => child.sectionHeader === selectedMacroSection.full_header && child.configFile === targetFile);
    });
    if (!alreadyInGraph) {
      const parent = graphStore.nodes.find((node) => node.type === 'hardware' && !!(node.data as Record<string, unknown>).isPrimary)
        || graphStore.nodes.find((node) => node.type === 'hardware' && (node.data as Record<string, unknown>).configFile === targetFile && (node.data as Record<string, unknown>).hardwareType !== 'sbc')
        || graphStore.nodes.find((node) => node.type === 'hardware' && (node.data as Record<string, unknown>).hardwareType !== 'sbc')
        || graphStore.nodes.find((node) => node.type === 'hardware');
      if (parent) {
        graphStore.addFeatureNode(parent.id, 'gcode_macro', selectedMacroSection.section_name, selectedMacroSection.full_header, targetFile);
      }
    }
    setMessage(existingTargetSection
      ? `Applied changes to ${selectedMacroSection.section_name} in ${targetFile}.`
      : `Macro ${selectedMacroSection.section_name} added to ${targetFile}.`);
  };

  const handleContextMenu = (event: React.MouseEvent, item: MacroSourceItem) => {
    event.preventDefault();
    event.stopPropagation();
    const draftId = item.source === 'draft' ? item.key.replace(/^draft:/, '') : null;
    setContextMenu({
      x: event.clientX,
      y: event.clientY,
      itemKey: item.key,
      itemSource: item.source,
      draftId,
    });
  };

  // --- SVG drag handlers ---
  const handleSvgPointerDown = (event: React.PointerEvent<SVGSVGElement>) => {
    if (!svgRef.current) return;
    const target = event.target as SVGElement;
    const dragType = target.closest('[data-drag]')?.getAttribute('data-drag');

    if (dragType === 'toolhead' && editMode && selectedItem) {
      event.preventDefault();
      const machine = clientToMachine(event, svgRef.current, machineProfile, rotation, viewBounds.viewMaxY);
      setDragState({ type: 'toolhead', offsetX: 0, offsetY: 0 });
      setToolheadDragPos({ x: machine.x, y: machine.y, z: toolheadDragPos?.z ?? runtime?.z ?? Math.max(machineProfile.minZ, 0) });
      svgRef.current.setPointerCapture(event.pointerId);
      return;
    }

    if (dragType === 'dock') {
      event.preventDefault();
      const machine = clientToMachine(event, svgRef.current, machineProfile, rotation, viewBounds.viewMaxY);
      setDragState({ type: 'dock', offsetX: (dockPosition?.x ?? 0) - machine.x, offsetY: (dockPosition?.y ?? 0) - machine.y });
      svgRef.current.setPointerCapture(event.pointerId);
      return;
    }

    const zoneResizeEl = target.closest('[data-zone-resize]');
    if (zoneResizeEl) {
      event.preventDefault();
      const zoneId = zoneResizeEl.getAttribute('data-zone-id')!;
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
      const moveLines = buildMoveLines(currentPosition, nextPosition, moveMode);
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
      const x = machine.x + dragState.offsetX;
      const y = machine.y + dragState.offsetY;
      updateNoGoZone(dragState.zoneId, { x, y });
      return;
    }

    if (dragState.type === 'zone-resize' && dragState.zoneId && dragState.fixedCornerX != null && dragState.fixedCornerY != null) {
      const fixX = dragState.fixedCornerX;
      const fixY = dragState.fixedCornerY;
      const newX = Math.min(machine.x, fixX);
      const newY = Math.min(machine.y, fixY);
      const newW = Math.max(1, Math.abs(machine.x - fixX));
      const newH = Math.max(1, Math.abs(machine.y - fixY));
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
      const moveLines = buildMoveLines(currentPosition, nextPosition, moveMode);
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

  // Toolhead position (use drag pos if dragging, otherwise runtime)
  const toolheadMachine = toolheadDragPos || (currentRuntime ? { x: currentRuntime.x, y: currentRuntime.y, z: currentRuntime.z } : null);
  const toolheadSvg = toolheadMachine ? toSvg(toolheadMachine.x, toolheadMachine.y) : null;
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
          stroke="rgba(248, 113, 113, 0.9)"
          strokeWidth="0.5"
          className="cursor-move"
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
      <g data-drag="dock" className="cursor-move">
        <circle cx={d.x} cy={d.y} r={dotR} fill="rgba(52,211,153,0.95)" stroke="white" strokeWidth="0.3" />
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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55" onClick={onClose}>
      <div className="w-[min(96vw,1600px)] h-[min(92vh,980px)] overflow-hidden rounded-2xl border border-[var(--color-bg-tertiary)] bg-[var(--color-bg-secondary)] shadow-2xl" onClick={(event) => event.stopPropagation()}>
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
            <button onClick={onClose} className="rounded-md border border-[var(--color-bg-tertiary)] px-3 py-1.5 text-xs text-[var(--color-text-primary)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]">Close</button>
          </div>
        </div>

        <div className="grid h-[calc(100%-69px)] grid-cols-[280px_minmax(0,1fr)_360px]">
          {/* ==================== LEFT SIDEBAR ==================== */}
          <aside className="flex min-h-0 flex-col border-r border-[var(--color-bg-tertiary)] p-4">
            <div className="mb-3 flex items-center gap-2">
              <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search macros" className="w-full rounded-md border border-[var(--color-bg-tertiary)] bg-[var(--color-bg-primary)] px-3 py-2 text-xs text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none" />
            </div>
            <div className="mb-3">
              <button onClick={handleCreateDraft} className="w-full rounded-md bg-[var(--color-accent)] px-3 py-2 text-xs font-semibold text-[var(--color-bg-primary)]">New</button>
            </div>

            <div className="flex-1 overflow-y-auto pr-1">
              <div>
                <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--color-text-secondary)]">Your macros</p>
                <div className="space-y-1.5">
                  {[...visibleDraftItems, ...visibleConfigItems].map((item) => (
                    <button
                      key={item.key}
                      onClick={() => setSelectedKey(item.key)}
                      onContextMenu={(event) => handleContextMenu(event, item)}
                      className={`w-full rounded-lg border px-3 py-2 text-left transition-colors ${selectedKey === item.key ? 'border-[var(--color-accent)] bg-[var(--color-bg-primary)]' : 'border-[var(--color-bg-tertiary)] hover:border-[var(--color-accent)]/60'}`}
                    >
                      <div className="truncate text-xs font-medium text-[var(--color-text-primary)]">{item.title}</div>
                      {item.description.trim() && (
                        <p className="mt-1 truncate text-[11px] text-[var(--color-text-secondary)]">{item.description}</p>
                      )}
                    </button>
                  ))}
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
                <button onClick={() => addNoGoZone({ x: machineProfile.centerX - 10, y: machineProfile.centerY - 10, width: 20, height: 20 })} className="rounded-md border border-[var(--color-bg-tertiary)] px-3 py-1.5 text-[var(--color-text-primary)] hover:border-[var(--color-accent)]">Add no-go zone</button>
                <button disabled={dockPosition !== null} onClick={() => setDockPosition({ x: machineProfile.centerX, y: machineProfile.centerY })} className="rounded-md border border-[var(--color-bg-tertiary)] px-3 py-1.5 text-[var(--color-text-primary)] hover:border-[var(--color-accent)] disabled:opacity-40">Add dock</button>
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
                <div className="min-w-[330px] flex-shrink-0 rounded-lg border border-[var(--color-bg-tertiary)] bg-[rgba(15,23,42,0.72)] px-3 py-2 text-[10px] text-[var(--color-text-secondary)]">
                  <div className="mb-1 flex items-center justify-between gap-3">
                    <div className="text-[10px] font-semibold uppercase tracking-[0.16em]">Machine state</div>
                    <button disabled={!editMode || !displayedItem} onClick={() => setMoveMode((current) => { const next = current === 'absolute' ? 'relative' : 'absolute'; appendGcode(current === 'absolute' ? 'G91' : 'G90'); return next; })} className={`rounded-md border px-2 py-0.5 text-[10px] font-semibold disabled:cursor-not-allowed disabled:opacity-40 ${moveMode === 'relative' ? 'border-[var(--color-accent)] text-[var(--color-accent)]' : 'border-[var(--color-bg-tertiary)] text-[var(--color-text-primary)]'}`}>{moveMode === 'absolute' ? 'Relative' : 'Absolute'}</button>
                  </div>
                  <div className="grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-[var(--color-text-primary)]">
                    <div>X: {formatNumber(toolheadMachine?.x ?? 0)} Y: {formatNumber(toolheadMachine?.y ?? 0)} Z: {formatNumber(toolheadMachine?.z ?? currentRuntime?.z ?? 0)}</div>
                    <div>Bed: {formatNumber(currentRuntime?.bed.current ?? 0)} / {formatNumber(currentRuntime?.bed.target ?? 0)} C</div>
                    <div>Nozzle: {formatNumber(currentRuntime?.nozzle.current ?? 0)} / {formatNumber(currentRuntime?.nozzle.target ?? 0)} C</div>
                    <div>Fan: {((currentRuntime?.fanSpeed ?? 0) * 100).toFixed(0)}%</div>
                    <div>Velocity: {formatNumber((currentRuntime?.feedRate ?? 0) / 60)} mm/s</div>
                    <div>Accel: {formatNumber(machineProfile.maxAccel)} mm/s²</div>
                  </div>
                  {editMode && selectedItem && (
                    <div className="mt-1 flex items-center gap-1.5">
                      <input value={goToX} onChange={(e) => setGoToX(e.target.value)} placeholder="X" className="w-14 rounded border border-[var(--color-bg-tertiary)] bg-[var(--color-bg-primary)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-primary)]" />
                      <input value={goToY} onChange={(e) => setGoToY(e.target.value)} placeholder="Y" className="w-14 rounded border border-[var(--color-bg-tertiary)] bg-[var(--color-bg-primary)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-primary)]" />
                      <input value={goToZ} onChange={(e) => setGoToZ(e.target.value)} placeholder="Z" className="w-14 rounded border border-[var(--color-bg-tertiary)] bg-[var(--color-bg-primary)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-primary)]" />
                      <button onClick={handleGoTo} className="rounded bg-[var(--color-accent)] px-2 py-0.5 text-[10px] font-semibold text-[var(--color-bg-primary)]">Move</button>
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
                      {zMoveIndicator === 'up' && (
                        <circle cx={toolheadSvg.x} cy={toolheadSvg.y} r={toolheadSize * 0.4} fill="white" />
                      )}
                      {zMoveIndicator === 'down' && (
                        <path
                          d={`M ${toolheadSvg.x - toolheadSize * 0.4} ${toolheadSvg.y - toolheadSize * 0.4} L ${toolheadSvg.x + toolheadSize * 0.4} ${toolheadSvg.y + toolheadSize * 0.4} M ${toolheadSvg.x + toolheadSize * 0.4} ${toolheadSvg.y - toolheadSize * 0.4} L ${toolheadSvg.x - toolheadSize * 0.4} ${toolheadSvg.y + toolheadSize * 0.4}`}
                          stroke="white"
                          strokeWidth="0.3"
                          strokeLinecap="round"
                        />
                      )}
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

                  {/* Axis labels */}
                  <text x={viewBounds.svgX + lblPad} y={viewBounds.svgY + lblSize + lblPad} fill="rgba(241,245,249,0.7)" fontSize={lblSize}>{labels.tl}</text>
                  <text x={viewBounds.svgX + viewBounds.svgW - lblPad} y={viewBounds.svgY + lblSize + lblPad} fill="rgba(241,245,249,0.7)" fontSize={lblSize} textAnchor="end">{labels.tr}</text>
                  <text x={viewBounds.svgX + lblPad} y={viewBounds.svgY + viewBounds.svgH - lblPad} fill="rgba(241,245,249,0.7)" fontSize={lblSize}>{labels.bl}</text>
                  <text x={viewBounds.svgX + viewBounds.svgW - lblPad} y={viewBounds.svgY + viewBounds.svgH - lblPad} fill="rgba(241,245,249,0.7)" fontSize={lblSize} textAnchor="end">{labels.br}</text>
                </svg>

              </div>

              {/* Simulation */}
              <div className="flex flex-shrink-0 flex-col gap-3 overflow-hidden border-t border-[var(--color-bg-tertiary)] px-4 py-2" style={{ maxHeight: '280px' }}>
                <div className="rounded-lg border border-[var(--color-bg-tertiary)] bg-[var(--color-bg-primary)] p-2">
                  <div className="mb-2 flex items-center justify-between">
                    <span className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--color-text-secondary)]">Simulation</span>
                    <span className="text-[11px] text-[var(--color-text-secondary)]">Step {Math.min(stepIndex, simulationPlan.steps.length)} / {simulationPlan.steps.length}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <button onClick={() => { if (isRunning) { setIsRunning(false); } else { setIsRunning(true); setToolheadDragPos(null); } }} disabled={!simulationPlan.steps.length || stepIndex >= simulationPlan.steps.length} className="flex h-8 w-8 items-center justify-center rounded-md border border-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] disabled:opacity-40" title={isRunning ? 'Pause' : 'Play'}>
                      {isRunning ? (
                        <svg viewBox="0 0 16 16" className="h-4 w-4 fill-current"><rect x="3" y="2.5" width="3.5" height="11" rx="0.8" /><rect x="9.5" y="2.5" width="3.5" height="11" rx="0.8" /></svg>
                      ) : (
                        <svg viewBox="0 0 16 16" className="h-4 w-4 fill-current"><path d="M4 2.5 L13 8 L4 13.5 Z" /></svg>
                      )}
                    </button>
                    <button onClick={handleStepBack} disabled={!runtimeHistory.length} className="flex h-8 w-8 items-center justify-center rounded-md border border-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] disabled:opacity-40" title="Step back">
                      <svg viewBox="0 0 16 16" className="h-4 w-4 fill-current"><path d="M10.5 2.5 L4.5 8 L10.5 13.5 Z" /><rect x="11.5" y="2.5" width="1.5" height="11" rx="0.5" /></svg>
                    </button>
                    <button onClick={handleStep} disabled={!simulationPlan.steps.length || stepIndex >= simulationPlan.steps.length} className="flex h-8 w-8 items-center justify-center rounded-md border border-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] disabled:opacity-40" title="Step forward">
                      <svg viewBox="0 0 16 16" className="h-4 w-4 fill-current"><path d="M5.5 2.5 L11.5 8 L5.5 13.5 Z" /><rect x="3" y="2.5" width="1.5" height="11" rx="0.5" /></svg>
                    </button>
                    <button onClick={handleReset} disabled={!selectedItem} className="flex h-8 w-8 items-center justify-center rounded-md border border-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] disabled:opacity-40" title="Reset">
                      <svg viewBox="0 0 16 16" className="h-4 w-4 fill-current"><path d="M8 3 A5 5 0 1 1 3.4 6 H1.8 L4.4 3.4 L7 6 H5.2 A3.5 3.5 0 1 0 8 4.5 Z" /></svg>
                    </button>
                    <div className="ml-auto text-[10px] text-[var(--color-text-secondary)]">Max {formatNumber(machineProfile.maxVelocity)} mm/s | Accel {formatNumber(machineProfile.maxAccel)} mm/s²</div>
                  </div>
                </div>
                <div className="min-h-0 flex-1 rounded-lg border border-[var(--color-bg-tertiary)] bg-[var(--color-bg-primary)] p-2">
                  <div className="mb-2 text-xs font-semibold uppercase tracking-[0.16em] text-[var(--color-text-secondary)]">Execution output</div>
                  {planWarnings.length > 0 && (
                    <div className="mb-2 rounded-md border border-amber-400/25 bg-amber-500/10 px-2 py-1 text-[11px] text-amber-100">{planWarnings.join(' ')}</div>
                  )}
                  <div className="h-[120px] overflow-y-auto rounded-md border border-[var(--color-bg-tertiary)] bg-[var(--color-bg-secondary)] px-2 py-1 font-mono text-[11px]">
                    {simulationLog.length === 0 ? (
                      <div className="text-[var(--color-text-secondary)]">No commands executed.</div>
                    ) : simulationLog.map((entry) => (
                      <button
                        key={entry.id}
                        onClick={() => setSelectedLogWarning(entry.warnings.length ? entry.warnings.join(' ') : null)}
                        className={`flex w-full items-start gap-2 rounded px-1.5 py-1 text-left ${entry.warnings.length ? 'bg-amber-500/10 text-amber-100' : 'text-[var(--color-text-primary)] hover:bg-[var(--color-bg-primary)]'}`}
                      >
                        <span className="w-16 shrink-0 text-[10px] text-[var(--color-text-secondary)]">L{entry.lineNumber}</span>
                        <span className="min-w-0 flex-1 truncate">{entry.raw}</span>
                      </button>
                    ))}
                  </div>
                  <div className="mt-2 min-h-[20px] text-[11px] text-[var(--color-text-secondary)]">
                    {selectedLogWarning || (simulationLog[simulationLog.length - 1]?.summary ?? 'Select a line to inspect warnings.')}
                  </div>
                </div>
              </div>
            </div>
          </main>

          {/* ==================== RIGHT SIDEBAR ==================== */}
          <aside className="min-h-0 border-l border-[var(--color-bg-tertiary)] overflow-y-auto p-4">
            {selectedItem ? (
              <div className="flex flex-col gap-4">
                <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
                  <button onClick={handleToggleEdit} className={`rounded-md px-3 py-2 text-xs font-semibold ${editMode ? 'bg-[var(--color-accent)] text-[var(--color-bg-primary)]' : 'border border-[var(--color-bg-tertiary)] text-[var(--color-text-primary)]'}`}>{editMode ? 'Save' : 'Edit'}</button>
                  <button onClick={handleCancelEdit} disabled={!editMode} className="rounded-md border border-[var(--color-bg-tertiary)] px-3 py-2 text-xs text-[var(--color-text-primary)] disabled:opacity-40">Cancel</button>
                </div>
                <div>
                  <div className="mb-1 text-xs font-semibold uppercase tracking-[0.16em] text-[var(--color-text-secondary)]">Macro</div>
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
                  <textarea
                    value={displayedItem?.gcode || ''}
                    disabled={!editMode}
                    onChange={(event) => updateEditedItem({ gcode: event.target.value })}
                    rows={12}
                    className="w-full resize-y overflow-y-auto rounded-xl border border-[var(--color-bg-tertiary)] bg-[var(--color-bg-primary)] px-3 py-3 font-mono text-xs leading-5 text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none disabled:opacity-70"
                    style={{ minHeight: '80px', maxHeight: '250px' }}
                  />
                </div>

                <div className="rounded-xl border border-[var(--color-bg-tertiary)] bg-[var(--color-bg-primary)] p-3">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <div className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--color-text-secondary)]">Control</div>
                    <div className="flex items-center gap-2">
                      <label className="text-[10px] text-[var(--color-text-secondary)]">Feed rate</label>
                      <input disabled={!editMode} value={moveFeedRate} onChange={(event) => setMoveFeedRate(event.target.value)} className="w-16 rounded-md border border-[var(--color-bg-tertiary)] bg-[var(--color-bg-secondary)] px-2 py-1 text-xs text-[var(--color-text-primary)] disabled:opacity-40" />
                      <button disabled={!editMode} onClick={() => appendGcode('M84')} className="rounded-md border border-[var(--color-bg-tertiary)] px-3 py-1 text-xs text-[var(--color-text-primary)] disabled:opacity-40">M84</button>
                      <button disabled={!editMode} onClick={() => appendGcode('G28')} className="rounded-md bg-[var(--color-accent)] px-3 py-1 text-xs font-semibold text-[var(--color-bg-primary)] disabled:opacity-40">Home all</button>
                    </div>
                  </div>
                  <div className="mb-3 space-y-2 text-xs">
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
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <div>
                      <label className="mb-1 block text-[var(--color-text-secondary)]">Nozzle target</label>
                      <div className="flex gap-1">
                        <input disabled={!editMode} value={nozzleTarget} onChange={(event) => setNozzleTarget(event.target.value)} className="w-full rounded-md border border-[var(--color-bg-tertiary)] bg-[var(--color-bg-secondary)] px-2 py-1.5 text-[var(--color-text-primary)] disabled:opacity-40" />
                        <button disabled={!editMode} onClick={() => {
                          const target = Number(nozzleTarget);
                          if (!Number.isFinite(target) || target < 0 || target > machineProfile.nozzleMaxTemp) {
                            setMessage(`Nozzle target must be between 0 and ${machineProfile.nozzleMaxTemp}.`);
                            return;
                          }
                          appendGcode(`M104 S${target}`);
                        }} className="rounded-md border border-[var(--color-bg-tertiary)] px-2 text-[var(--color-text-primary)] disabled:opacity-40" title="Set nozzle temp (no wait)">Set</button>
                        <button disabled={!editMode} onClick={() => {
                          const target = Number(nozzleTarget);
                          if (!Number.isFinite(target) || target < 0 || target > machineProfile.nozzleMaxTemp) {
                            setMessage(`Nozzle target must be between 0 and ${machineProfile.nozzleMaxTemp}.`);
                            return;
                          }
                          appendGcode(`M109 S${target}`);
                        }} className="rounded-md border border-[var(--color-bg-tertiary)] px-2 text-[var(--color-text-primary)] disabled:opacity-40" title="Set nozzle temp and wait">Wait</button>
                      </div>
                    </div>
                    <div>
                      <label className="mb-1 block text-[var(--color-text-secondary)]">Bed target</label>
                      <div className="flex gap-1">
                        <input disabled={!editMode} value={bedTarget} onChange={(event) => setBedTarget(event.target.value)} className="w-full rounded-md border border-[var(--color-bg-tertiary)] bg-[var(--color-bg-secondary)] px-2 py-1.5 text-[var(--color-text-primary)] disabled:opacity-40" />
                        <button disabled={!editMode} onClick={() => {
                          const target = Number(bedTarget);
                          if (!Number.isFinite(target) || target < 0 || target > machineProfile.bedMaxTemp) {
                            setMessage(`Bed target must be between 0 and ${machineProfile.bedMaxTemp}.`);
                            return;
                          }
                          appendGcode(`M140 S${target}`);
                        }} className="rounded-md border border-[var(--color-bg-tertiary)] px-2 text-[var(--color-text-primary)] disabled:opacity-40" title="Set bed temp (no wait)">Set</button>
                        <button disabled={!editMode} onClick={() => {
                          const target = Number(bedTarget);
                          if (!Number.isFinite(target) || target < 0 || target > machineProfile.bedMaxTemp) {
                            setMessage(`Bed target must be between 0 and ${machineProfile.bedMaxTemp}.`);
                            return;
                          }
                          appendGcode(`M190 S${target}`);
                        }} className="rounded-md border border-[var(--color-bg-tertiary)] px-2 text-[var(--color-text-primary)] disabled:opacity-40" title="Set bed temp and wait">Wait</button>
                      </div>
                    </div>
                    <div>
                      <label className="mb-1 block text-[var(--color-text-secondary)]">Fan %</label>
                      <div className="flex gap-2">
                        <input disabled={!editMode} value={fanPercent} onChange={(event) => setFanPercent(event.target.value)} className="w-full rounded-md border border-[var(--color-bg-tertiary)] bg-[var(--color-bg-secondary)] px-2 py-1.5 text-[var(--color-text-primary)] disabled:opacity-40" />
                        <button disabled={!editMode} onClick={() => {
                          const percent = Number(fanPercent);
                          if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
                            setMessage('Fan percentage must be between 0 and 100.');
                            return;
                          }
                          appendGcode(percent === 0 ? 'M107' : `M106 S${Math.round(percent / 100 * 255)}`);
                        }} className="rounded-md border border-[var(--color-bg-tertiary)] px-2 text-[var(--color-text-primary)] disabled:opacity-40">Add</button>
                      </div>
                    </div>
                    <div>
                      <label className="mb-1 block text-[var(--color-text-secondary)]">LED</label>
                      <div className="flex items-center gap-2">
                        <input disabled={!editMode} value={ledName} onChange={(event) => setLedName(event.target.value)} placeholder="Name" className="w-full rounded-md border border-[var(--color-bg-tertiary)] bg-[var(--color-bg-secondary)] px-2 py-1.5 text-[var(--color-text-primary)] disabled:opacity-40" />
                        <input disabled={!editMode} type="color" value={ledColor} onChange={(event) => setLedColor(event.target.value)} className="h-9 w-14 rounded-md border border-[var(--color-bg-tertiary)] bg-[var(--color-bg-secondary)] disabled:opacity-40" />
                        <button onClick={() => {
                          const red = parseInt(ledColor.slice(1, 3), 16) / 255;
                          const green = parseInt(ledColor.slice(3, 5), 16) / 255;
                          const blue = parseInt(ledColor.slice(5, 7), 16) / 255;
                          appendGcode(`SET_LED LED=${ledName || 'status_led'} RED=${red.toFixed(3)} GREEN=${green.toFixed(3)} BLUE=${blue.toFixed(3)}`);
                        }} className="rounded-md border border-[var(--color-bg-tertiary)] px-3 text-[var(--color-text-primary)] disabled:opacity-40" disabled={!editMode}>Add</button>
                      </div>
                    </div>
                    <div className="col-span-2">
                      <label className="mb-1 block text-[var(--color-text-secondary)]">Terminal message</label>
                      <div className="flex gap-2">
                        <input disabled={!editMode} value={terminalMessage} onChange={(event) => setTerminalMessage(event.target.value)} className="w-full rounded-md border border-[var(--color-bg-tertiary)] bg-[var(--color-bg-secondary)] px-2 py-1.5 text-[var(--color-text-primary)] disabled:opacity-40" />
                        <button disabled={!editMode} onClick={() => appendGcode(`RESPOND MSG="${terminalMessage.replace(/"/g, '')}"`)} className="rounded-md border border-[var(--color-bg-tertiary)] px-3 text-[var(--color-text-primary)] disabled:opacity-40">Add</button>
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
            <button
              onClick={() => { handleRename(contextMenu.itemKey); setContextMenu(null); }}
              className="w-full px-4 py-2 text-left text-xs text-[var(--color-text-primary)] hover:bg-[var(--color-bg-primary)]"
            >Rename</button>
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
