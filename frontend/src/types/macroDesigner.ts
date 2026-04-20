export interface MacroDraft {
  id: string;
  title: string;
  renameExisting: string;
  description: string;
  variables: string;
  gcode: string;
  createdAt: number;
  updatedAt: number;
}

export interface NoGoZone {
  id: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DockPosition {
  x: number;
  y: number;
}

export interface MacroDesignerPersistedState {
  drafts: MacroDraft[];
  noGoZones: NoGoZone[];
  dockPosition: DockPosition | null;
  rotation: 0 | 90 | 180 | 270;
}

export interface MacroSourceItem {
  key: string;
  source: 'draft' | 'config' | 'builtin';
  title: string;
  renameExisting: string;
  description: string;
  variables: string;
  gcode: string;
  sourceFile?: string;
  sourceHeader?: string;
  readOnly?: boolean;
}

export interface SimulationPoint {
  x: number;
  y: number;
  label?: string;
}

export interface MachineProfile {
  shape: 'rect' | 'round';
  kinematics: string;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
  moveMinX: number;
  moveMaxX: number;
  moveMinY: number;
  moveMaxY: number;
  centerX: number;
  centerY: number;
  radius: number | null;
  homeX: number;
  homeY: number;
  homeZ: number;
  probeOffsetX: number;
  probeOffsetY: number;
  nozzleMaxTemp: number;
  bedMaxTemp: number;
  maxVelocity: number;
  maxAccel: number;
  noGoZones: NoGoZone[];
  dockPosition: DockPosition | null;
  featurePoints: Record<string, SimulationPoint[]>;
}

export interface BuiltInMacroDefinition {
  id: string;
  title: string;
  command: string;
  requiredSections: string[];
  description: string;
}

export interface ParsedGcodeCommand {
  command: string;
  raw: string;
  params: Record<string, string>;
  lineNumber: number;
  sourceName: string;
}

export interface SimulationStepMove {
  kind: 'move';
  x: number;
  y: number;
  z?: number;
  label: string;
  raw: string;
  sourceName: string;
  lineNumber: number;
}

export interface SimulationStepProbe {
  kind: 'probe';
  x: number;
  y: number;
  label: string;
  raw: string;
  sourceName: string;
  lineNumber: number;
}

export interface SimulationStepCommand {
  kind: 'command';
  command: ParsedGcodeCommand;
}

export type SimulationStep = SimulationStepMove | SimulationStepProbe | SimulationStepCommand;

export interface SimulationBuildResult {
  steps: SimulationStep[];
  warnings: string[];
}

export interface RuntimeTemperatureState {
  current: number;
  target: number;
}

export interface RuntimeLedState {
  red: number;
  green: number;
  blue: number;
  white: number;
}

export interface MacroRuntimeState {
  x: number;
  y: number;
  z: number;
  e: number;
  feedRate: number;
  absoluteMoves: boolean;
  absoluteExtrusion: boolean;
  gcodeOffset: { x: number; y: number; z: number };
  lastZDirection: 'up' | 'down' | 'flat';
  homedAxes: string[];
  bed: RuntimeTemperatureState;
  nozzle: RuntimeTemperatureState;
  fanSpeed: number;
  displayText: string;
  messages: string[];
  ledStates: Record<string, RuntimeLedState>;
  activeProbePoint: SimulationPoint | null;
  activeBuiltInCommand: string | null;
  activeMacro: string;
  elapsedTimeS: number;
  savedStates: Record<string, {
    x: number;
    y: number;
    z: number;
    e: number;
    feedRate: number;
    absoluteMoves: boolean;
    absoluteExtrusion: boolean;
    gcodeOffset: { x: number; y: number; z: number };
  }>;
}

export interface SimulationTickResult {
  nextState: MacroRuntimeState;
  warnings: string[];
  eventSummary: string;
}