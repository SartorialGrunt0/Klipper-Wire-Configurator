import type { ConfigFile } from '../types/config';
import type { MacroSourceItem } from '../types/macroDesigner';
import type {
  MachineProfile,
  MacroRuntimeState,
  ParsedGcodeCommand,
  RuntimeBedMeshState,
  RuntimeLedState,
  SimulationBuildResult,
  SimulationPoint,
  SimulationStep,
  SimulationTickResult,
} from '../types/macroDesigner';
import { logMacroDesignerEvent } from './macroDesignerLog';
import { findPathZoneHit, findZoneHit, isPointInBounds, isPointInMoveBounds, parseMacroVariables } from './macroDesigner';

export function parseParams(tokens: string[]): Record<string, string> {
  const params: Record<string, string> = {};
  for (const token of tokens) {
    if (!token) continue;
    const eqIndex = token.indexOf('=');
    if (eqIndex !== -1) {
      const key = token.slice(0, eqIndex).trim().toUpperCase();
      const value = token.slice(eqIndex + 1).trim().replace(/^["']|["']$/g, '');
      if (key) params[key] = value;
      continue;
    }
    const first = token[0]?.toUpperCase();
    const rest = token.slice(1).trim();
    if (first) {
      params[first] = rest;
    }
  }
  return params;
}

/**
 * Split a command line into tokens the way Klipper's shlex parser does:
 * whitespace-separated, but quote groups (single or double) stay intact
 * even when embedded mid-token (e.g. MSG='hello world' is one token).
 */
function splitCommandTokens(line: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: string | null = null;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (quote) {
      current += char;
      if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }
  if (current) {
    tokens.push(current);
  }
  return tokens;
}

function isTemplateDirective(line: string): boolean {
  return /^\{[%#].*[%#]\}$/.test(line) || /^\{\s*printer\./.test(line) || /^\{\s*[^}]+\s*\}$/.test(line);
}

function isTemplateValue(value: string | undefined): boolean {
  return typeof value === 'string' && /[{[]/.test(value);
}

function extractActionMessage(raw: string): string {
  const match = raw.match(/^\{\s*action_[^(]+\((.*)\)\s*\}$/i);
  return (match?.[1] || '').trim();
}

export function parseGcodeLine(line: string, lineNumber: number, sourceName: string): ParsedGcodeCommand | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  const actionCommand = parseActionLine(trimmed, lineNumber, sourceName);
  if (actionCommand) {
    return actionCommand;
  }
  if (isTemplateDirective(trimmed)) {
    return { command: '__TEMPLATE__', raw: trimmed, params: {}, lineNumber, sourceName };
  }
  // Strip both ; gcode comments and # config-style comments before tokenizing.
  // Without this, a line like `G1 X5 Y5 F1200  ## note` gets words from the
  // comment parsed as extra params (e.g. 'you' → Y:'ou'), silently overwriting
  // the real Y value.
  const withoutComment = line.replace(/;.*$/, '').replace(/\s*#.*$/, '').trim();
  if (!withoutComment) return null;
  const tokens = splitCommandTokens(withoutComment);
  const [commandToken, ...paramTokens] = tokens;
  if (!commandToken) return null;
  return {
    command: commandToken.toUpperCase(),
    raw: trimmed,
    params: parseParams(paramTokens),
    lineNumber,
    sourceName,
  };
}

function cloneLedState(state: RuntimeLedState): RuntimeLedState {
  return { ...state };
}

function createInitialBedMeshState(): RuntimeBedMeshState {
  return {
    active: false,
    profile: null,
    method: null,
    adaptive: false,
    offsets: {
      x: 0,
      y: 0,
      zFade: 0,
    },
  };
}

export function createInitialRuntimeState(profile: MachineProfile, macroName: string): MacroRuntimeState {
  return {
    x: profile.centerX,
    y: profile.centerY,
    z: Math.max(profile.minZ, 0),
    e: 0,
    feedRate: profile.maxVelocity > 0 ? profile.maxVelocity * 60 : 1500,
    absoluteMoves: true,
    absoluteExtrusion: true,
    gcodeOffset: { x: 0, y: 0, z: 0 },
    lastZDirection: 'flat',
    homedAxes: [],
    bed: { current: 25, target: 0 },
    nozzle: { current: 25, target: 0 },
    fanSpeed: 0,
    activeExtruder: DEFAULT_EXTRUDER_NAME,
    isPaused: false,
    bedMesh: createInitialBedMeshState(),
    displayText: '',
    messages: [],
    ledStates: {},
    activeProbePoint: null,
    activeBuiltInCommand: null,
    activeMacro: macroName,
    elapsedTimeS: 0,
    saveVariables: {},
    savedStates: {},
  };
}

function asNumber(value: string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeMessage(raw: string): string {
  return raw.replace(/^"|"$/g, '');
}

function getConfigSections(configFiles?: Record<string, ConfigFile>): ConfigFile['sections'] {
  return configFiles ? Object.values(configFiles).flatMap((configFile) => configFile.sections) : [];
}

function getConfigParamValue(section: ConfigFile['sections'][number] | undefined, key: string): string | undefined {
  return section?.params.find((param) => !param.is_commented_out && param.key.toUpperCase() === key.toUpperCase())?.value;
}

function isTruthyConfigValue(value: string | undefined): boolean {
  return typeof value === 'string' && /^(1|true|yes|on)$/i.test(value.trim());
}

function isForceMoveEnabled(configFiles?: Record<string, ConfigFile>): boolean {
  if (!configFiles) {
    return false;
  }

  const forceMoveSection = getConfigSections(configFiles).find((section) => section.section_type === 'force_move');
  return isTruthyConfigValue(getConfigParamValue(forceMoveSection, 'enable_force_move'));
}

function getSetKinematicPositionWarning(configFiles?: Record<string, ConfigFile>): string | null {
  if (!configFiles || isForceMoveEnabled(configFiles)) {
    return null;
  }

  return 'SET_KINEMATIC_POSITION requires [force_move] enable_force_move: True.';
}

function parsePairValue(value: string | undefined): [number, number] | null {
  if (!value) return null;
  const parts = value.split(',').map((part) => Number(part.trim()));
  if (parts.length < 2 || parts.some((part) => !Number.isFinite(part))) {
    return null;
  }
  return [parts[0], parts[1]];
}

function parseCountPair(value: string | undefined): [number, number] | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed.includes(',')) {
    return parsePairValue(trimmed);
  }
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed > 0 ? [parsed, parsed] : null;
}

function parsePositiveInteger(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : null;
}

function buildRectangularBedMeshPoints(
  meshMin: [number, number],
  meshMax: [number, number],
  probeCount: [number, number],
): SimulationPoint[] {
  const xCount = Math.max(1, Math.round(probeCount[0]));
  const yCount = Math.max(1, Math.round(probeCount[1]));
  const points: SimulationPoint[] = [];

  for (let yIndex = 0; yIndex < yCount; yIndex += 1) {
    const y = yCount === 1
      ? meshMin[1]
      : meshMin[1] + ((meshMax[1] - meshMin[1]) * yIndex) / (yCount - 1);
    const reversed = yIndex % 2 !== 0;

    for (let i = 0; i < xCount; i += 1) {
      const xIndex = reversed ? (xCount - 1 - i) : i;
      const x = xCount === 1
        ? meshMin[0]
        : meshMin[0] + ((meshMax[0] - meshMin[0]) * xIndex) / (xCount - 1);
      points.push({
        x: Math.round(x * 1000) / 1000,
        y: Math.round(y * 1000) / 1000,
        label: `${xIndex + 1},${yIndex + 1}`,
      });
    }
  }

  return points;
}

function buildRoundBedMeshPoints(
  meshRadius: number,
  meshOrigin: [number, number],
  roundProbeCount: number,
): SimulationPoint[] {
  const baseCount = Math.max(1, Math.round(roundProbeCount));
  const normalizedCount = baseCount % 2 === 0 ? baseCount + 1 : baseCount;
  const step = normalizedCount === 1 ? 0 : (meshRadius * 2) / (normalizedCount - 1);
  const points: SimulationPoint[] = [];

  for (let yIndex = 0; yIndex < normalizedCount; yIndex += 1) {
    const y = meshOrigin[1] - meshRadius + (step * yIndex);
    const row: SimulationPoint[] = [];

    for (let xIndex = 0; xIndex < normalizedCount; xIndex += 1) {
      const x = meshOrigin[0] - meshRadius + (step * xIndex);
      const dx = x - meshOrigin[0];
      const dy = y - meshOrigin[1];
      if (Math.sqrt(dx * dx + dy * dy) > meshRadius + 1e-6) {
        continue;
      }
      row.push({
        x: Math.round(x * 1000) / 1000,
        y: Math.round(y * 1000) / 1000,
        label: `${xIndex + 1},${yIndex + 1}`,
      });
    }

    if (yIndex % 2 !== 0) {
      row.reverse();
    }
    points.push(...row);
  }

  return points;
}

function getBedMeshCalibrationMethod(
  command: ParsedGcodeCommand,
  profile: MachineProfile,
): NonNullable<RuntimeBedMeshState['method']> {
  const rawMethod = (command.params.METHOD || (profile.hasProbe ? 'automatic' : 'manual')).trim().toLowerCase();
  return rawMethod === 'manual' || rawMethod === 'automatic' || rawMethod === 'scan' || rawMethod === 'rapid_scan'
    ? rawMethod
    : (profile.hasProbe ? 'automatic' : 'manual');
}

function getBedMeshProfileName(command: ParsedGcodeCommand): string {
  const requestedProfile = command.params.PROFILE?.trim() || 'default';
  if (command.params.ADAPTIVE === '1' && !requestedProfile.toLowerCase().startsWith('adaptive-')) {
    return `adaptive-${requestedProfile}`;
  }
  return requestedProfile;
}

function getProbeMoveConfigSection(command: ParsedGcodeCommand, configFiles?: Record<string, ConfigFile>) {
  const sectionTypeByCommand: Partial<Record<string, string>> = {
    Z_TILT_ADJUST: 'z_tilt',
    QUAD_GANTRY_LEVEL: 'quad_gantry_level',
    BED_TILT_CALIBRATE: 'bed_tilt',
    DELTA_CALIBRATE: 'delta_calibrate',
    SCREWS_TILT_CALCULATE: 'screws_tilt_adjust',
  };
  const sectionType = sectionTypeByCommand[command.command];
  return sectionType
    ? getConfigSections(configFiles).find((section) => section.section_type === sectionType)
    : undefined;
}

function getProbeTravelHeight(
  command: ParsedGcodeCommand,
  profile: MachineProfile,
  configFiles?: Record<string, ConfigFile>,
): number {
  const section = getProbeMoveConfigSection(command, configFiles);
  return asNumber(command.params.HORIZONTAL_MOVE_Z)
    ?? asNumber(getConfigParamValue(section, 'horizontal_move_z'))
    ?? profile.horizontalMoveZ;
}

function getBedMeshCalibrationPlan(
  command: ParsedGcodeCommand,
  profile: MachineProfile,
  configFiles?: Record<string, ConfigFile>,
): {
  points: SimulationPoint[];
  moveZ: number;
  method: NonNullable<RuntimeBedMeshState['method']>;
  adaptive: boolean;
  profileName: string;
} {
  const method = getBedMeshCalibrationMethod(command, profile);
  const bedMeshSection = getConfigSections(configFiles).find((section) => section.section_type === 'bed_mesh');
  const moveZ = asNumber(command.params.HORIZONTAL_MOVE_Z)
    ?? asNumber(getConfigParamValue(bedMeshSection, 'horizontal_move_z'))
    ?? profile.horizontalMoveZ;
  const adaptive = command.params.ADAPTIVE === '1';
  const profileName = getBedMeshProfileName(command);

  if (profile.shape === 'round') {
    const meshRadius = asNumber(command.params.MESH_RADIUS)
      ?? asNumber(getConfigParamValue(bedMeshSection, 'mesh_radius'));
    const meshOriginOffset = parsePairValue(command.params.MESH_ORIGIN)
      ?? parsePairValue(getConfigParamValue(bedMeshSection, 'mesh_origin'))
      ?? [0, 0];
    const roundProbeCount = parsePositiveInteger(command.params.ROUND_PROBE_COUNT)
      ?? parsePositiveInteger(getConfigParamValue(bedMeshSection, 'round_probe_count'))
      ?? 5;

    return {
      points: meshRadius !== null
        ? buildRoundBedMeshPoints(
            meshRadius,
            [profile.centerX + meshOriginOffset[0], profile.centerY + meshOriginOffset[1]],
            roundProbeCount,
          )
        : (profile.featurePoints.BED_MESH_CALIBRATE || []),
      moveZ,
      method,
      adaptive,
      profileName,
    };
  }

  const meshMin = parsePairValue(command.params.MESH_MIN)
    ?? parsePairValue(getConfigParamValue(bedMeshSection, 'mesh_min'));
  const meshMax = parsePairValue(command.params.MESH_MAX)
    ?? parsePairValue(getConfigParamValue(bedMeshSection, 'mesh_max'));
  const probeCount = parseCountPair(command.params.PROBE_COUNT)
    ?? parseCountPair(getConfigParamValue(bedMeshSection, 'probe_count'));

  return {
    points: meshMin && meshMax && probeCount
      ? buildRectangularBedMeshPoints(meshMin, meshMax, probeCount)
      : (profile.featurePoints.BED_MESH_CALIBRATE || []),
    moveZ,
    method,
    adaptive,
    profileName,
  };
}

function getProbeSamplingPlan(command: ParsedGcodeCommand, profile: MachineProfile): ProbeSamplingPlan {
  const defaultSampleCount = command.command === 'PROBE_ACCURACY' ? 10 : profile.probeSamples;
  const overrideSampleCount = parsePositiveInteger(command.params.SAMPLES);
  const sampleCount = Math.max(1, overrideSampleCount ?? defaultSampleCount);
  const sampleRetractDist = Math.max(0, asNumber(command.params.SAMPLE_RETRACT_DIST) ?? profile.probeSampleRetractDist);
  const liftSpeed = asNumber(command.params.LIFT_SPEED) ?? profile.probeLiftSpeed;

  return {
    sampleCount,
    sampleRetractDist,
    liftFeedRate: liftSpeed !== null && liftSpeed > 0 ? liftSpeed * 60 : null,
  };
}

function buildProbeSampleSteps(
  probeX: number,
  probeY: number,
  nozzleX: number,
  nozzleY: number,
  sampleZ: number,
  maxZ: number,
  label: string,
  sourceName: string,
  lineNumber: number,
  samplingPlan: ProbeSamplingPlan,
  rawBase = 'probe',
): SimulationStep[] {
  const steps: SimulationStep[] = [];

  for (let index = 0; index < samplingPlan.sampleCount; index += 1) {
    const suffix = samplingPlan.sampleCount > 1 ? ` sample ${index + 1}/${samplingPlan.sampleCount}` : '';
    steps.push({
      kind: 'probe' as const,
      x: probeX,
      y: probeY,
      label: `${label}${suffix}`,
      raw: `${rawBase} at ${probeX.toFixed(3)},${probeY.toFixed(3)}${suffix} is z=0.000`,
      sourceName,
      lineNumber,
    });

    if (index >= samplingPlan.sampleCount - 1 || samplingPlan.sampleRetractDist <= 0) {
      continue;
    }

    const retractZ = Math.min(maxZ, sampleZ + samplingPlan.sampleRetractDist);
    const nextSuffix = samplingPlan.sampleCount > 1 ? ` sample ${index + 2}/${samplingPlan.sampleCount}` : '';
    steps.push({
      kind: 'move' as const,
      x: nozzleX,
      y: nozzleY,
      z: retractZ,
      feedRate: samplingPlan.liftFeedRate ?? undefined,
      label: `Lift for ${label}${suffix}`,
      raw: `sample retract ${label}${suffix}`,
      sourceName,
      lineNumber,
    });
    steps.push({
      kind: 'move' as const,
      x: nozzleX,
      y: nozzleY,
      z: sampleZ,
      feedRate: samplingPlan.liftFeedRate ?? undefined,
      label: `Return for ${label}${nextSuffix}`,
      raw: `sample return ${label}${nextSuffix}`,
      sourceName,
      lineNumber,
    });
  }

  return steps;
}

function formatDocumentedCommandSummary(command: ParsedGcodeCommand): string {
  switch (command.command) {
    case 'SET_DISPLAY_GROUP':
      return command.params.GROUP ? `Set display group ${command.params.GROUP}` : 'Set display group';
    case 'SET_PRINT_STATS_INFO':
      return 'Update print stats';
    case 'SET_TEMPERATURE_FAN_TARGET':
      return command.params.TARGET ? `Set temperature fan target ${command.params.TARGET}C` : 'Set temperature fan target';
    case 'SET_Z_THERMAL_ADJUST':
      return command.params.ENABLE === '0' ? 'Disable Z thermal adjust' : 'Update Z thermal adjust';
    default:
      return command.command;
  }
}

function isExtruderHeater(heaterName: string | undefined, activeExtruder: string): boolean {
  if (!heaterName) return true;
  const normalized = heaterName.trim().toLowerCase();
  return normalized === 'extruder' || normalized === activeExtruder.trim().toLowerCase() || normalized.startsWith('extruder');
}

function isBedHeater(heaterName: string | undefined): boolean {
  return typeof heaterName === 'string' && heaterName.trim().toLowerCase().includes('bed');
}

export interface TrapezoidalProfile {
  totalTime: number;
  accelTime: number;
  cruiseTime: number;
  accelDist: number;
  cruiseDist: number;
  totalDist: number;
  maxSpeed: number;
  accel: number;
}

export function computeTrapezoidalProfile(
  distance: number,
  feedRate: number,
  maxVelocity: number,
  maxAccel: number,
): TrapezoidalProfile {
  const zero: TrapezoidalProfile = { totalTime: 0, accelTime: 0, cruiseTime: 0, accelDist: 0, cruiseDist: 0, totalDist: 0, maxSpeed: 0, accel: maxAccel };
  if (distance <= 0 || maxAccel <= 0) return zero;
  const requestedSpeed = feedRate / 60;
  const effectiveSpeed = Math.min(requestedSpeed, maxVelocity);
  if (effectiveSpeed <= 0) return zero;
  const accelDist = (effectiveSpeed * effectiveSpeed) / (2 * maxAccel);
  if (accelDist * 2 >= distance) {
    const accelTime = Math.sqrt(distance / maxAccel);
    return {
      totalTime: 2 * accelTime,
      accelTime,
      cruiseTime: 0,
      accelDist: distance / 2,
      cruiseDist: 0,
      totalDist: distance,
      maxSpeed: maxAccel * accelTime,
      accel: maxAccel,
    };
  }
  const accelTime = effectiveSpeed / maxAccel;
  const cruiseDist = distance - 2 * accelDist;
  const cruiseTime = cruiseDist / effectiveSpeed;
  return {
    totalTime: 2 * accelTime + cruiseTime,
    accelTime,
    cruiseTime,
    accelDist,
    cruiseDist,
    totalDist: distance,
    maxSpeed: effectiveSpeed,
    accel: maxAccel,
  };
}

export function trapezoidalPositionAtTime(profile: TrapezoidalProfile, t: number): number {
  if (t <= 0 || profile.totalTime <= 0) return 0;
  if (t >= profile.totalTime) return profile.totalDist;
  if (t <= profile.accelTime) {
    return 0.5 * profile.accel * t * t;
  }
  const t2 = t - profile.accelTime;
  if (t2 <= profile.cruiseTime) {
    return profile.accelDist + profile.maxSpeed * t2;
  }
  const t3 = t2 - profile.cruiseTime;
  return profile.accelDist + profile.cruiseDist + profile.maxSpeed * t3 - 0.5 * profile.accel * t3 * t3;
}

function estimateMoveTime(distance: number, feedRate: number, maxVelocity: number, maxAccel: number): number {
  return computeTrapezoidalProfile(distance, feedRate, maxVelocity, maxAccel).totalTime;
}

function buildMacroLookup(items: MacroSourceItem[]): Map<string, MacroSourceItem> {
  const lookup = new Map<string, MacroSourceItem>();
  for (const item of items) {
    lookup.set(item.title.toUpperCase(), item);
  }
  return lookup;
}

function getRequestedAxes(params: Record<string, string>): Array<'X' | 'Y' | 'Z'> {
  const axes = new Set<'X' | 'Y' | 'Z'>();
  for (const key of Object.keys(params)) {
    const axis = key.toUpperCase();
    if (axis === 'X' || axis === 'Y' || axis === 'Z') {
      axes.add(axis);
    }
  }
  return Array.from(axes);
}

type PlannerSavedState = {
  absoluteMoves: boolean;
  absoluteExtrusion: boolean;
};

type PlannerState = {
  homedAxes: Set<'X' | 'Y' | 'Z'>;
  absoluteMoves: boolean;
  absoluteExtrusion: boolean;
  bedCurrent: number;
  bedTarget: number;
  fanSpeed: number;
  nozzleCurrent: number;
  nozzleTarget: number;
  activeExtruder: string;
  isPaused: boolean;
  savedStates: Record<string, PlannerSavedState>;
  macroVariables: Record<string, Record<string, unknown>>;
  saveVariables: Record<string, unknown>;
};

type MacroInvocationContext = {
  params: Record<string, string>;
  rawparams: string;
  locals: Record<string, unknown>;
};

type ProbeSamplingPlan = {
  sampleCount: number;
  sampleRetractDist: number;
  liftFeedRate: number | null;
};

type TemplateStaticContext = {
  printerObjects: Record<string, unknown>;
  configSections: Record<string, unknown>;
  machineBounds?: {
    axis_minimum: Record<string, number>;
    axis_maximum: Record<string, number>;
  };
  homePosition?: Record<string, number>;
  livePosition?: () => { x: number; y: number; z: number; e: number };
};

type TemplateLineSegment =
  | { kind: 'text'; text: string }
  | { kind: 'directive'; directive: string };

type NumberedTemplateLine = {
  text: string;
  lineNumber: number;
};

const TEMPLATE_UNRESOLVED = Symbol('template-unresolved');
const HOT_EXTRUDER_THRESHOLD_C = 170;
const DEFAULT_EXTRUDER_NAME = 'extruder';
const DOCUMENTED_GCODE_PASSTHROUGH_COMMANDS = new Set([
  'ACCELEROMETER_DEBUG_READ',
  'ACCELEROMETER_DEBUG_WRITE',
  'ACCELEROMETER_MEASURE',
  'ACCELEROMETER_QUERY',
  'ANGLE_CALIBRATE',
  'ANGLE_CHIP_CALIBRATE',
  'ANGLE_DEBUG_READ',
  'ANGLE_DEBUG_WRITE',
  'BLTOUCH_DEBUG',
  'BLTOUCH_STORE',
  'CALC_MEASURED_SKEW',
  'DELTA_ANALYZE',
  'DISABLE_FILAMENT_WIDTH_LOG',
  'DISABLE_FILAMENT_WIDTH_SENSOR',
  'DUMP_TMC',
  'ENABLE_FILAMENT_WIDTH_LOG',
  'ENABLE_FILAMENT_WIDTH_SENSOR',
  'ENDSTOP_PHASE_CALIBRATE',
  'GET_CURRENT_SKEW',
  'GET_RETRACTION',
  'HELP',
  'INIT_TMC',
  'LDC_CALIBRATE_DRIVE_CURRENT',
  'MANUAL_STEPPER',
  'MEASURE_AXES_NOISE',
  'PALETTE_CLEAR',
  'PALETTE_CONNECT',
  'PALETTE_CUT',
  'PALETTE_DISCONNECT',
  'PALETTE_SMART_LOAD',
  'PROBE_EDDY_CURRENT_CALIBRATE',
  'QUERY_ADC',
  'QUERY_FILAMENT_SENSOR',
  'QUERY_FILAMENT_WIDTH',
  'QUERY_RAW_FILAMENT_WIDTH',
  'RESET_FILAMENT_WIDTH_SENSOR',
  'RESET_SMART_EFFECTOR',
  'RESTORE_DUAL_CARRIAGE_STATE',
  'SAVE_DUAL_CARRIAGE_STATE',
  'SDCARD_LOOP_BEGIN',
  'SDCARD_LOOP_DESIST',
  'SDCARD_LOOP_END',
  'SDCARD_PRINT_FILE',
  'SDCARD_RESET_FILE',
  'SET_DIGIPOT',
  'SET_DISPLAY_GROUP',
  'SET_DUAL_CARRIAGE',
  'SET_EXTRUDER_ROTATION_DISTANCE',
  'SET_FILAMENT_SENSOR',
  'SET_LED_TEMPLATE',
  'SET_PRINT_STATS_INFO',
  'SET_SKEW',
  'SET_SMART_EFFECTOR',
  'SET_STEPPER_CARRIAGES',
  'SET_TEMPERATURE_FAN_TARGET',
  'SET_Z_THERMAL_ADJUST',
  'SHAPER_CALIBRATE',
  'SKEW_PROFILE',
  'STEPPER_BUZZ',
  'SYNC_EXTRUDER_MOTION',
  'TEMPERATURE_PROBE_CALIBRATE',
  'TEMPERATURE_PROBE_COMPLETE',
  'TEMPERATURE_PROBE_NEXT',
  'TEST_RESONANCES',
  'Z_OFFSET_APPLY_ENDSTOP',
  'Z_OFFSET_APPLY_PROBE',
]);

function isUnresolved(value: unknown): value is typeof TEMPLATE_UNRESOLVED {
  return value === TEMPLATE_UNRESOLVED;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function setContextVariants(target: Record<string, unknown>, key: string, value: unknown) {
  if (!key) return;
  target[key] = value;
  const lower = key.toLowerCase();
  const upper = key.toUpperCase();
  if (!(lower in target)) {
    target[lower] = value;
  }
  if (!(upper in target)) {
    target[upper] = value;
  }
}

function parseConfiguredValue(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed) return '';
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  if (/^(true|false)$/i.test(trimmed)) {
    return trimmed.toLowerCase() === 'true';
  }
  if (/^(none|null)$/i.test(trimmed)) {
    return null;
  }
  const numeric = Number(trimmed);
  if (Number.isFinite(numeric)) {
    return numeric;
  }
  return trimmed;
}

function buildMacroVariableContext(variables: string): Record<string, unknown> {
  return parseMacroVariables(variables).reduce<Record<string, unknown>>((context, param) => {
    if (param.is_commented_out || !param.key.startsWith('variable_')) {
      return context;
    }
    const variableName = param.key.slice('variable_'.length);
    if (!variableName) {
      return context;
    }
    setContextVariants(context, variableName, parseConfiguredValue(param.value));
    return context;
  }, {});
}

function buildConfigSectionContext(section: ConfigFile['sections'][number]): Record<string, unknown> {
  return section.params.reduce<Record<string, unknown>>((context, param) => {
    if (param.is_commented_out || param.key === '_comment_') {
      return context;
    }
    setContextVariants(context, param.key, parseConfiguredValue(param.value));
    return context;
  }, {});
}

function buildTemplateStaticContext(
  allMacros: MacroSourceItem[],
  configFiles?: Record<string, ConfigFile>,
  profile?: MachineProfile,
  livePosition?: () => { x: number; y: number; z: number; e: number },
): TemplateStaticContext {
  const printerObjects: Record<string, unknown> = {};
  const configSections: Record<string, unknown> = {};

  const machineBounds = profile
    ? {
        axis_minimum: { x: profile.minX, y: profile.minY, z: profile.minZ },
        axis_maximum: { x: profile.maxX, y: profile.maxY, z: profile.maxZ },
      }
    : undefined;
  const homePosition = profile
    ? { x: profile.homeX, y: profile.homeY, z: profile.homeZ }
    : undefined;

  if (configFiles) {
    Object.values(configFiles).forEach((configFile) => {
      configFile.sections.forEach((section) => {
        const sectionContext = buildConfigSectionContext(section);
        setContextVariants(configSections, section.full_header, sectionContext);
        setContextVariants(printerObjects, section.full_header, sectionContext);
        if (!(section.section_type in printerObjects)) {
          setContextVariants(printerObjects, section.section_type, sectionContext);
        }
      });
    });
  }

  allMacros.forEach((macro) => {
    const macroKey = `gcode_macro ${macro.title}`;
    const macroContext = {
      ...asRecord(printerObjects[macroKey]),
      ...buildMacroVariableContext(macro.variables),
    };
    setContextVariants(printerObjects, macroKey, macroContext);
    setContextVariants(configSections, macroKey, {
      ...asRecord(configSections[macroKey]),
      ...macroContext,
    });
  });

  return { printerObjects, configSections, machineBounds, homePosition, livePosition };
}

function createInitialPlannerState(allMacros: MacroSourceItem[]): PlannerState {
  const macroVariables = allMacros.reduce<Record<string, Record<string, unknown>>>((context, macro) => {
    context[`gcode_macro ${macro.title}`] = buildMacroVariableContext(macro.variables);
    return context;
  }, {});

  return {
    homedAxes: new Set<'X' | 'Y' | 'Z'>(),
    absoluteMoves: true,
    absoluteExtrusion: true,
    bedCurrent: 25,
    bedTarget: 0,
    fanSpeed: 0,
    nozzleCurrent: 25,
    nozzleTarget: 0,
    activeExtruder: DEFAULT_EXTRUDER_NAME,
    isPaused: false,
    savedStates: {},
    macroVariables,
    saveVariables: {},
  };
}

const HOMING_AXES: Array<'X' | 'Y' | 'Z'> = ['X', 'Y', 'Z'];

// Klipper's default [extruder] min_extrude_temp.
const DEFAULT_MIN_EXTRUDE_TEMP = 170;

function getHomedAxesString(homedAxes: Set<'X' | 'Y' | 'Z'>): string {
  return HOMING_AXES.filter((axis) => homedAxes.has(axis)).map((axis) => axis.toLowerCase()).join('');
}

function normalizeRuntimeHomedAxes(homedAxes: string[]): string[] {
  const axisSet = new Set(homedAxes.map((axis) => axis.toUpperCase()).filter((axis): axis is 'X' | 'Y' | 'Z' => axis === 'X' || axis === 'Y' || axis === 'Z'));
  return HOMING_AXES.filter((axis) => axisSet.has(axis));
}

function applyPlannerCommandEffects(command: ParsedGcodeCommand, plannerState: PlannerState) {
  switch (command.command) {
    case 'G28': {
      const requestedAxes = getRequestedAxes(command.params);
      const axesToHome = requestedAxes.length > 0 ? requestedAxes : HOMING_AXES;
      for (const axis of axesToHome) {
        plannerState.homedAxes.add(axis);
      }
      break;
    }
    case 'G90':
      plannerState.absoluteMoves = true;
      break;
    case 'G91':
      plannerState.absoluteMoves = false;
      break;
    case 'M82':
      plannerState.absoluteExtrusion = true;
      break;
    case 'M83':
      plannerState.absoluteExtrusion = false;
      break;
    case 'M104': {
      const target = asNumber(command.params.S);
      if (target !== null) {
        plannerState.nozzleTarget = target;
      }
      break;
    }
    case 'M109': {
      const target = asNumber(command.params.S);
      if (target !== null) {
        plannerState.nozzleTarget = target;
        plannerState.nozzleCurrent = target;
      }
      break;
    }
    case 'M140': {
      const target = asNumber(command.params.S);
      if (target !== null) {
        plannerState.bedTarget = target;
      }
      break;
    }
    case 'M190': {
      const target = asNumber(command.params.S);
      if (target !== null) {
        plannerState.bedTarget = target;
        plannerState.bedCurrent = target;
      }
      break;
    }
    case 'M106': {
      const value = Math.max(0, Math.min(255, asNumber(command.params.S) ?? 255));
      plannerState.fanSpeed = value / 255;
      break;
    }
    case 'M107':
      plannerState.fanSpeed = 0;
      break;
    case 'SET_FAN_SPEED': {
      const speed = Math.max(0, Math.min(1, Number(command.params.SPEED) || 0));
      plannerState.fanSpeed = speed;
      break;
    }
    case 'TURN_OFF_HEATERS':
      plannerState.bedTarget = 0;
      plannerState.nozzleTarget = 0;
      break;
    case 'SAVE_GCODE_STATE': {
      const name = command.params.NAME || 'default';
      plannerState.savedStates[name] = {
        absoluteMoves: plannerState.absoluteMoves,
        absoluteExtrusion: plannerState.absoluteExtrusion,
      };
      break;
    }
    case 'RESTORE_GCODE_STATE': {
      const name = command.params.NAME || 'default';
      const savedState = plannerState.savedStates[name];
      if (savedState) {
        plannerState.absoluteMoves = savedState.absoluteMoves;
        plannerState.absoluteExtrusion = savedState.absoluteExtrusion;
      }
      break;
    }
    case 'SET_GCODE_VARIABLE': {
      const macroName = command.params.MACRO?.trim();
      const variableName = command.params.VARIABLE?.trim();
      if (!macroName || !variableName) {
        break;
      }
      const header = `gcode_macro ${macroName}`;
      const nextMacroVariables = {
        ...asRecord(plannerState.macroVariables[header]),
      };
      setContextVariants(nextMacroVariables, variableName, parseConfiguredValue(command.params.VALUE || ''));
      plannerState.macroVariables[header] = nextMacroVariables;
      break;
    }
    case 'SAVE_VARIABLE': {
      const variableName = command.params.VARIABLE?.trim();
      if (!variableName) {
        break;
      }
      plannerState.saveVariables = {
        ...plannerState.saveVariables,
        [variableName]: parseConfiguredValue(command.params.VALUE || ''),
      };
      break;
    }
    case 'PAUSE':
      plannerState.isPaused = true;
      break;
    case 'CLEAR_PAUSE':
    case 'RESUME':
    case 'CANCEL_PRINT':
      plannerState.isPaused = false;
      break;
    case 'ACTIVATE_EXTRUDER':
      plannerState.activeExtruder = command.params.EXTRUDER || command.params.NAME || plannerState.activeExtruder;
      break;
    case 'SET_HEATER_TEMPERATURE': {
      const heaterName = command.params.HEATER || command.params.HEATER_NAME;
      const target = asNumber(command.params.TARGET) ?? asNumber(command.params.S);
      if (target === null) {
        break;
      }
      if (isBedHeater(heaterName)) {
        plannerState.bedTarget = target;
      } else if (isExtruderHeater(heaterName, plannerState.activeExtruder)) {
        plannerState.nozzleTarget = target;
      }
      break;
    }
    case 'SET_KINEMATIC_POSITION': {
      const requestedAxes = getRequestedAxes(command.params);
      for (const axis of requestedAxes) {
        plannerState.homedAxes.add(axis);
      }
      break;
    }
    case 'FIRMWARE_RESTART':
    case 'RESTART':
      plannerState.homedAxes.clear();
      plannerState.absoluteMoves = true;
      plannerState.absoluteExtrusion = true;
      plannerState.bedCurrent = 25;
      plannerState.bedTarget = 0;
      plannerState.fanSpeed = 0;
      plannerState.nozzleCurrent = 25;
      plannerState.nozzleTarget = 0;
      plannerState.activeExtruder = DEFAULT_EXTRUDER_NAME;
      plannerState.isPaused = false;
      plannerState.savedStates = {};
      break;
    default:
      break;
  }
}

function isWordBoundary(char: string | undefined): boolean {
  return !char || /[^A-Za-z0-9_]/.test(char);
}

function stripEnclosingParens(expression: string): string {
  let trimmed = expression.trim();
  while (trimmed.startsWith('(') && trimmed.endsWith(')')) {
    let depth = 0;
    let inSingleQuote = false;
    let inDoubleQuote = false;
    let closesAtEnd = true;

    for (let index = 0; index < trimmed.length; index += 1) {
      const char = trimmed[index];
      if (char === "'" && !inDoubleQuote) {
        inSingleQuote = !inSingleQuote;
        continue;
      }
      if (char === '"' && !inSingleQuote) {
        inDoubleQuote = !inDoubleQuote;
        continue;
      }
      if (inSingleQuote || inDoubleQuote) {
        continue;
      }
      if (char === '(') depth += 1;
      if (char === ')') {
        depth -= 1;
        if (depth === 0 && index < trimmed.length - 1) {
          closesAtEnd = false;
          break;
        }
      }
    }

    if (!closesAtEnd || depth !== 0) {
      break;
    }
    trimmed = trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function splitTopLevelByKeyword(expression: string, keyword: 'and' | 'or' | 'else' | 'if'): string[] {
  const parts: string[] = [];
  let start = 0;
  let depthParen = 0;
  let depthBracket = 0;
  let depthBrace = 0;
  let inSingleQuote = false;
  let inDoubleQuote = false;

  for (let index = 0; index < expression.length; index += 1) {
    const char = expression[index];
    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      continue;
    }
    if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }
    if (inSingleQuote || inDoubleQuote) {
      continue;
    }

    if (char === '(') depthParen += 1;
    if (char === ')') depthParen -= 1;
    if (char === '[') depthBracket += 1;
    if (char === ']') depthBracket -= 1;
    if (char === '{') depthBrace += 1;
    if (char === '}') depthBrace -= 1;

    if (depthParen !== 0 || depthBracket !== 0 || depthBrace !== 0) {
      continue;
    }

    if (
      expression.slice(index, index + keyword.length).toLowerCase() === keyword
      && isWordBoundary(expression[index - 1])
      && isWordBoundary(expression[index + keyword.length])
    ) {
      parts.push(expression.slice(start, index).trim());
      start = index + keyword.length;
      index += keyword.length - 1;
    }
  }

  if (parts.length === 0) {
    return [expression.trim()];
  }

  parts.push(expression.slice(start).trim());
  return parts;
}

function splitTopLevelByCharacter(expression: string, separator: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let depthParen = 0;
  let depthBracket = 0;
  let depthBrace = 0;
  let inSingleQuote = false;
  let inDoubleQuote = false;

  for (let index = 0; index < expression.length; index += 1) {
    const char = expression[index];
    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      continue;
    }
    if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }
    if (inSingleQuote || inDoubleQuote) {
      continue;
    }

    if (char === '(') depthParen += 1;
    if (char === ')') depthParen -= 1;
    if (char === '[') depthBracket += 1;
    if (char === ']') depthBracket -= 1;
    if (char === '{') depthBrace += 1;
    if (char === '}') depthBrace -= 1;

    if (depthParen === 0 && depthBracket === 0 && depthBrace === 0 && char === separator) {
      parts.push(expression.slice(start, index).trim());
      start = index + 1;
    }
  }

  if (parts.length === 0) {
    return [expression.trim()];
  }

  parts.push(expression.slice(start).trim());
  return parts;
}

function findTopLevelBinaryCharacter(expression: string, operators: string[]): { index: number; operator: string } | null {
  let depthParen = 0;
  let depthBracket = 0;
  let depthBrace = 0;
  let inSingleQuote = false;
  let inDoubleQuote = false;

  for (let index = expression.length - 1; index >= 0; index -= 1) {
    const char = expression[index];
    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      continue;
    }
    if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }
    if (inSingleQuote || inDoubleQuote) {
      continue;
    }

    if (char === ')') depthParen += 1;
    if (char === '(') depthParen -= 1;
    if (char === ']') depthBracket += 1;
    if (char === '[') depthBracket -= 1;
    if (char === '}') depthBrace += 1;
    if (char === '{') depthBrace -= 1;

    if (depthParen !== 0 || depthBracket !== 0 || depthBrace !== 0 || !operators.includes(char)) {
      continue;
    }

    if (index === 0) {
      continue;
    }

    const previous = expression.slice(0, index).trimEnd().slice(-1);
    if (!previous || '([{,+-*/%<>=:'.includes(previous)) {
      continue;
    }

    return { index, operator: char };
  }

  return null;
}

function findTopLevelOperator(expression: string, operators: string[]): { index: number; operator: string } | null {
  let depthParen = 0;
  let depthBracket = 0;
  let depthBrace = 0;
  let inSingleQuote = false;
  let inDoubleQuote = false;

  for (let index = 0; index < expression.length; index += 1) {
    const char = expression[index];
    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      continue;
    }
    if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }
    if (inSingleQuote || inDoubleQuote) {
      continue;
    }

    if (char === '(') depthParen += 1;
    if (char === ')') depthParen -= 1;
    if (char === '[') depthBracket += 1;
    if (char === ']') depthBracket -= 1;
    if (char === '{') depthBrace += 1;
    if (char === '}') depthBrace -= 1;

    if (depthParen !== 0 || depthBracket !== 0 || depthBrace !== 0) {
      continue;
    }

    const match = operators.find((operator) => expression.slice(index, index + operator.length) === operator);
    if (match) {
      return { index, operator: match };
    }
  }

  return null;
}

function coerceBoolean(value: unknown): boolean | null {
  if (isUnresolved(value)) {
    return null;
  }
  return Boolean(value);
}

function asComparableNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'boolean') {
    return value ? 1 : 0;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
  }
  return null;
}

function compareTemplateValues(left: unknown, right: unknown, operator: string): boolean {
  const leftNumeric = asComparableNumber(left);
  const rightNumeric = asComparableNumber(right);

  if (leftNumeric !== null && rightNumeric !== null) {
    switch (operator) {
      case '==':
        return leftNumeric === rightNumeric;
      case '!=':
        return leftNumeric !== rightNumeric;
      case '>=':
        return leftNumeric >= rightNumeric;
      case '<=':
        return leftNumeric <= rightNumeric;
      case '>':
        return leftNumeric > rightNumeric;
      case '<':
        return leftNumeric < rightNumeric;
      default:
        return false;
    }
  }

  const leftValue = String(left ?? '');
  const rightValue = String(right ?? '');
  switch (operator) {
    case '==':
      return leftValue === rightValue;
    case '!=':
      return leftValue !== rightValue;
    case '>=':
      return leftValue >= rightValue;
    case '<=':
      return leftValue <= rightValue;
    case '>':
      return leftValue > rightValue;
    case '<':
      return leftValue < rightValue;
    default:
      return false;
  }
}

function evaluateMembership(left: unknown, right: unknown): boolean | null {
  if (isUnresolved(left) || isUnresolved(right) || right == null) {
    return null;
  }
  if (typeof right === 'string') {
    return right.includes(String(left));
  }
  if (Array.isArray(right)) {
    return right.some((entry) => entry === left || String(entry) === String(left));
  }
  if (typeof right === 'object' && typeof left === 'string') {
    return Object.prototype.hasOwnProperty.call(right, left)
      || Object.prototype.hasOwnProperty.call(right, left.toLowerCase())
      || Object.prototype.hasOwnProperty.call(right, left.toUpperCase());
  }
  return null;
}

function extractBracketExpression(expression: string, startIndex: number): { content: string; nextIndex: number } | null {
  let depth = 0;
  let inSingleQuote = false;
  let inDoubleQuote = false;

  for (let index = startIndex; index < expression.length; index += 1) {
    const char = expression[index];
    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      continue;
    }
    if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }
    if (inSingleQuote || inDoubleQuote) {
      continue;
    }

    if (char === '[') {
      depth += 1;
    } else if (char === ']') {
      depth -= 1;
      if (depth === 0) {
        return {
          content: expression.slice(startIndex + 1, index),
          nextIndex: index + 1,
        };
      }
    }
  }

  return null;
}

function buildTemplatePrinterContext(
  plannerState: PlannerState,
  staticContext: TemplateStaticContext,
): Record<string, unknown> {
  const printer = {
    ...staticContext.printerObjects,
  };

  setContextVariants(printer, 'toolhead', {
    ...asRecord(printer.toolhead),
    homed_axes: getHomedAxesString(plannerState.homedAxes),
    home_axes: getHomedAxesString(plannerState.homedAxes),
    extruder: plannerState.activeExtruder,
    ...(staticContext.livePosition ? { position: staticContext.livePosition() } : {}),
    ...(staticContext.machineBounds
      ? {
          axis_minimum: staticContext.machineBounds.axis_minimum,
          axis_maximum: staticContext.machineBounds.axis_maximum,
        }
      : {}),
  });
  setContextVariants(printer, 'gcode_move', {
    ...asRecord(printer.gcode_move),
    absolute_coordinates: plannerState.absoluteMoves,
    absolute_extrude: plannerState.absoluteExtrusion,
    ...(staticContext.homePosition ? { homing_origin: staticContext.homePosition } : {}),
  });
  setContextVariants(printer, 'print_stats', {
    ...asRecord(printer.print_stats),
    state: 'standby',
    info: {
      ...asRecord(asRecord(printer.print_stats).info),
      current_layer: null,
      current_speed: 0,
    },
  });
  setContextVariants(printer, 'idle_timeout', {
    ...asRecord(printer.idle_timeout),
    state: 'Idle',
  });
  setContextVariants(printer, 'quad_gantry_level', {
    ...asRecord(printer.quad_gantry_level),
    applied: false,
  });
  setContextVariants(printer, 'fan', {
    ...asRecord(printer.fan),
    speed: plannerState.fanSpeed,
  });
  setContextVariants(printer, 'heater_bed', {
    ...asRecord(printer.heater_bed),
    target: plannerState.bedTarget,
    temperature: plannerState.bedCurrent,
  });
  setContextVariants(printer, 'pause_resume', {
    ...asRecord(printer.pause_resume),
    is_paused: plannerState.isPaused,
  });
  setContextVariants(printer, 'save_variables', {
    ...asRecord(printer.save_variables),
    variables: {
      ...asRecord(asRecord(printer.save_variables).variables),
      ...plannerState.saveVariables,
    },
  });
  setContextVariants(printer, 'configfile', {
    ...asRecord(printer.configfile),
    config: staticContext.configSections,
    // Real Klipper exposes settings via printer.configfile.settings
    // (e.g. printer.configfile.settings.printer.max_velocity).
    settings: staticContext.configSections,
  });

  if (plannerState.activeExtruder) {
    const activeExtruderState = {
      ...asRecord(printer[plannerState.activeExtruder]),
      can_extrude: plannerState.nozzleCurrent >= HOT_EXTRUDER_THRESHOLD_C,
      target: plannerState.nozzleTarget,
      temperature: plannerState.nozzleCurrent,
    };
    setContextVariants(printer, plannerState.activeExtruder, activeExtruderState);
    if (plannerState.activeExtruder === DEFAULT_EXTRUDER_NAME) {
      setContextVariants(printer, 'extruder0', {
        ...asRecord(printer.extruder0),
        ...activeExtruderState,
      });
    }
  }

  Object.entries(plannerState.macroVariables).forEach(([macroKey, values]) => {
    setContextVariants(printer, macroKey, {
      ...asRecord(printer[macroKey]),
      ...values,
    });
  });

  return printer;
}

function getPropertyValue(container: unknown, key: string | number): unknown {
  if (isUnresolved(container) || container == null) {
    return TEMPLATE_UNRESOLVED;
  }
  if (Array.isArray(container)) {
    const index = typeof key === 'number' ? key : Number(key);
    return Number.isInteger(index) && index >= 0 && index < container.length
      ? container[index]
      : TEMPLATE_UNRESOLVED;
  }
  if (typeof container !== 'object') {
    return TEMPLATE_UNRESOLVED;
  }

  const record = container as Record<string, unknown>;
  const exactKey = String(key);
  if (Object.prototype.hasOwnProperty.call(record, exactKey)) {
    return record[exactKey];
  }
  const upperKey = exactKey.toUpperCase();
  if (Object.prototype.hasOwnProperty.call(record, upperKey)) {
    return record[upperKey];
  }
  const lowerKey = exactKey.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(record, lowerKey)) {
    return record[lowerKey];
  }
  return TEMPLATE_UNRESOLVED;
}

function resolveReference(
  expression: string,
  invocation: MacroInvocationContext,
  plannerState: PlannerState,
  staticContext: TemplateStaticContext,
): unknown {
  const rootMatch = expression.match(/^([A-Za-z_][A-Za-z0-9_]*)/);
  if (!rootMatch) {
    return TEMPLATE_UNRESOLVED;
  }

  const rootName = rootMatch[1];
  let current: unknown;
  if (Object.prototype.hasOwnProperty.call(invocation.locals, rootName)) {
    current = invocation.locals[rootName];
  } else if (rootName === 'params') {
    current = invocation.params;
  } else if (rootName === 'rawparams') {
    current = invocation.rawparams;
  } else if (rootName === 'printer') {
    current = buildTemplatePrinterContext(plannerState, staticContext);
  } else {
    return TEMPLATE_UNRESOLVED;
  }

  let index = rootMatch[0].length;
  while (index < expression.length) {
    const char = expression[index];
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    if (char === '.') {
      const propertyMatch = expression.slice(index + 1).match(/^([A-Za-z_][A-Za-z0-9_]*)/);
      if (!propertyMatch) {
        return TEMPLATE_UNRESOLVED;
      }
      current = getPropertyValue(current, propertyMatch[1]);
      index += 1 + propertyMatch[1].length;
      continue;
    }
    if (char === '[') {
      const bracket = extractBracketExpression(expression, index);
      if (!bracket) {
        return TEMPLATE_UNRESOLVED;
      }
      const key = evaluateTemplateExpression(bracket.content, invocation, plannerState, staticContext);
      if (isUnresolved(key)) {
        return TEMPLATE_UNRESOLVED;
      }
      current = getPropertyValue(current, typeof key === 'number' ? key : String(key));
      index = bracket.nextIndex;
      continue;
    }
    return TEMPLATE_UNRESOLVED;
  }

  return current;
}

function applyTemplateFilter(
  value: unknown,
  filterExpression: string,
  invocation: MacroInvocationContext,
  plannerState: PlannerState,
  staticContext: TemplateStaticContext,
): unknown {
  const match = filterExpression.match(/^([A-Za-z_][A-Za-z0-9_]*)(?:\((.*)\))?$/);
  if (!match) {
    return value;
  }

  const [, filterName, rawArgs] = match;
  switch (filterName) {
    case 'default': {
      if (!isUnresolved(value) && value !== undefined && value !== null && value !== '') {
        return value;
      }
      if (!rawArgs) {
        return value;
      }
      return evaluateTemplateExpression(rawArgs.trim(), invocation, plannerState, staticContext);
    }
    case 'int': {
      const numeric = Number.parseInt(String(isUnresolved(value) ? '' : value), 10);
      return Number.isFinite(numeric) ? numeric : 0;
    }
    case 'float': {
      const numeric = Number.parseFloat(String(isUnresolved(value) ? '' : value));
      return Number.isFinite(numeric) ? numeric : 0;
    }
    case 'lower':
      return String(isUnresolved(value) ? '' : value).toLowerCase();
    case 'upper':
      return String(isUnresolved(value) ? '' : value).toUpperCase();
    case 'abs': {
      const numeric = Number(isUnresolved(value) ? NaN : value);
      return Number.isFinite(numeric) ? Math.abs(numeric) : value;
    }
    default:
      return value;
  }
}

function evaluateValueExpression(
  expression: string,
  invocation: MacroInvocationContext,
  plannerState: PlannerState,
  staticContext: TemplateStaticContext,
): unknown {
  const parts = splitTopLevelByCharacter(expression.trim(), '|');
  const baseExpression = parts[0];
  let value: unknown;

  if (baseExpression === '{}') {
    value = {};
  } else if (baseExpression === '[]') {
    value = [];
  } else if (baseExpression.startsWith('[') && baseExpression.endsWith(']')) {
    const inner = baseExpression.slice(1, -1).trim();
    value = inner
      ? splitTopLevelByCharacter(inner, ',').map((part) => evaluateTemplateExpression(part, invocation, plannerState, staticContext))
      : [];
  } else if (baseExpression.startsWith('(') && baseExpression.endsWith(')') && splitTopLevelByCharacter(baseExpression.slice(1, -1), ',').length > 1) {
    const inner = baseExpression.slice(1, -1).trim();
    value = inner
      ? splitTopLevelByCharacter(inner, ',').map((part) => evaluateTemplateExpression(part, invocation, plannerState, staticContext))
      : [];
  } else if ((baseExpression.startsWith('"') && baseExpression.endsWith('"')) || (baseExpression.startsWith("'") && baseExpression.endsWith("'"))) {
    value = baseExpression.slice(1, -1);
  } else if (/^-?\d+(?:\.\d+)?$/.test(baseExpression)) {
    value = Number(baseExpression);
  } else if (/^(true|false)$/i.test(baseExpression)) {
    value = baseExpression.toLowerCase() === 'true';
  } else if (/^(none|null)$/i.test(baseExpression)) {
    value = null;
  } else {
    const functionMatch = baseExpression.match(/^([A-Za-z_][A-Za-z0-9_]*)\((.*)\)$/);
    value = functionMatch && isBalancedCallExpression(baseExpression)
      ? evaluateTemplateCall(functionMatch[1], functionMatch[2], invocation, plannerState, staticContext)
      : resolveReference(baseExpression, invocation, plannerState, staticContext);
  }

  return parts.slice(1).reduce<unknown>((current, filterExpression) => (
    applyTemplateFilter(current, filterExpression, invocation, plannerState, staticContext)
  ), value);
}

function evaluateTemplateExpression(
  expression: string,
  invocation: MacroInvocationContext,
  plannerState: PlannerState,
  staticContext: TemplateStaticContext,
): unknown {
  const originalTrimmed = expression.trim();
  const trimmed = originalTrimmed.startsWith('(')
    && originalTrimmed.endsWith(')')
    && splitTopLevelByCharacter(originalTrimmed.slice(1, -1), ',').length > 1
    ? originalTrimmed
    : stripEnclosingParens(originalTrimmed);
  if (!trimmed) {
    return TEMPLATE_UNRESOLVED;
  }

  // Inline ternary: <true> if <cond> else <false> — split on a top-level
  // 'else' first (shortest match so nested ternaries keep their own), then
  // find the top-level 'if' in the true-branch.
  const elseParts = splitTopLevelByKeyword(trimmed, 'else');
  if (elseParts.length > 1) {
    const trueExpression = elseParts[0];
    const falseExpression = elseParts.slice(1).join(' else ');
    const ifParts = splitTopLevelByKeyword(trueExpression, 'if');
    if (ifParts.length > 1) {
      const condition = ifParts[ifParts.length - 1];
      const trueValueExpression = ifParts.slice(0, ifParts.length - 1).join(' if ');
      const conditionValue = evaluateTemplateExpression(condition, invocation, plannerState, staticContext);
      const conditionBoolean = coerceBoolean(conditionValue);
      if (conditionBoolean === null) {
        return TEMPLATE_UNRESOLVED;
      }
      return conditionBoolean
        ? evaluateTemplateExpression(trueValueExpression, invocation, plannerState, staticContext)
        : evaluateTemplateExpression(falseExpression, invocation, plannerState, staticContext);
    }
  }

  const orParts = splitTopLevelByKeyword(trimmed, 'or');
  if (orParts.length > 1) {
    let hasUnresolvedBranch = false;
    for (const part of orParts) {
      const value = evaluateTemplateExpression(part, invocation, plannerState, staticContext);
      const booleanValue = coerceBoolean(value);
      if (booleanValue === true) {
        return true;
      }
      if (booleanValue === null) {
        hasUnresolvedBranch = true;
      }
    }
    return hasUnresolvedBranch ? TEMPLATE_UNRESOLVED : false;
  }

  const andParts = splitTopLevelByKeyword(trimmed, 'and');
  if (andParts.length > 1) {
    let hasUnresolvedBranch = false;
    for (const part of andParts) {
      const value = evaluateTemplateExpression(part, invocation, plannerState, staticContext);
      const booleanValue = coerceBoolean(value);
      if (booleanValue === false) {
        return false;
      }
      if (booleanValue === null) {
        hasUnresolvedBranch = true;
      }
    }
    return hasUnresolvedBranch ? TEMPLATE_UNRESOLVED : true;
  }

  const definedOperator = findTopLevelOperator(trimmed, [' is not defined', ' is defined']);
  if (definedOperator) {
    const left = evaluateValueExpression(trimmed.slice(0, definedOperator.index).trim(), invocation, plannerState, staticContext);
    const isDefined = !isUnresolved(left);
    return definedOperator.operator.includes('not') ? !isDefined : isDefined;
  }

  const noneOperator = findTopLevelOperator(trimmed, [' is not none', ' is none']);
  if (noneOperator) {
    const left = evaluateValueExpression(trimmed.slice(0, noneOperator.index).trim(), invocation, plannerState, staticContext);
    const isNone = left === null || isUnresolved(left);
    return noneOperator.operator.includes('not') ? !isNone : isNone;
  }

  const membershipOperator = findTopLevelOperator(trimmed, [' not in ', ' in ']);
  if (membershipOperator) {
    const left = evaluateTemplateExpression(trimmed.slice(0, membershipOperator.index).trim(), invocation, plannerState, staticContext);
    const right = evaluateTemplateExpression(trimmed.slice(membershipOperator.index + membershipOperator.operator.length).trim(), invocation, plannerState, staticContext);
    const result = evaluateMembership(left, right);
    if (result === null) {
      return TEMPLATE_UNRESOLVED;
    }
    return membershipOperator.operator.includes('not') ? !result : result;
  }

  const comparisonOperator = findTopLevelOperator(trimmed, ['==', '!=', '>=', '<=', '>', '<']);
  if (comparisonOperator) {
    const left = evaluateTemplateExpression(trimmed.slice(0, comparisonOperator.index).trim(), invocation, plannerState, staticContext);
    const right = evaluateTemplateExpression(trimmed.slice(comparisonOperator.index + comparisonOperator.operator.length).trim(), invocation, plannerState, staticContext);
    if (isUnresolved(left) || isUnresolved(right)) {
      return TEMPLATE_UNRESOLVED;
    }
    return compareTemplateValues(left, right, comparisonOperator.operator);
  }

  if (/^not\s+/i.test(trimmed)) {
    const value = evaluateTemplateExpression(trimmed.replace(/^not\s+/i, ''), invocation, plannerState, staticContext);
    const booleanValue = coerceBoolean(value);
    return booleanValue === null ? TEMPLATE_UNRESOLVED : !booleanValue;
  }

  const additiveOperator = findTopLevelBinaryCharacter(trimmed, ['+', '-']);
  if (additiveOperator) {
    const left = evaluateTemplateExpression(trimmed.slice(0, additiveOperator.index).trim(), invocation, plannerState, staticContext);
    const right = evaluateTemplateExpression(trimmed.slice(additiveOperator.index + 1).trim(), invocation, plannerState, staticContext);
    return applyTemplateBinaryOperator(left, right, additiveOperator.operator);
  }

  const multiplicativeOperator = findTopLevelBinaryCharacter(trimmed, ['*', '/', '%']);
  if (multiplicativeOperator) {
    const left = evaluateTemplateExpression(trimmed.slice(0, multiplicativeOperator.index).trim(), invocation, plannerState, staticContext);
    const right = evaluateTemplateExpression(trimmed.slice(multiplicativeOperator.index + 1).trim(), invocation, plannerState, staticContext);
    return applyTemplateBinaryOperator(left, right, multiplicativeOperator.operator);
  }

  if (/^[+-]\s*/.test(trimmed)) {
    const operator = trimmed[0];
    const value = evaluateTemplateExpression(trimmed.slice(1).trim(), invocation, plannerState, staticContext);
    if (isUnresolved(value)) {
      return TEMPLATE_UNRESOLVED;
    }
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
      return TEMPLATE_UNRESOLVED;
    }
    return operator === '-' ? -numeric : numeric;
  }

  return evaluateValueExpression(trimmed, invocation, plannerState, staticContext);
}

function evaluateTemplateCondition(
  expression: string,
  invocation: MacroInvocationContext,
  plannerState: PlannerState,
  staticContext: TemplateStaticContext,
): boolean | null {
  const value = evaluateTemplateExpression(expression, invocation, plannerState, staticContext);
  return coerceBoolean(value);
}

function parseTemplateDirective(
  directive: string,
  invocation: MacroInvocationContext,
  plannerState: PlannerState,
  staticContext: TemplateStaticContext,
): { kind: 'if' | 'elif' | 'else' | 'endif' | 'set' | 'for' | 'endfor'; result?: boolean | null; name?: string; value?: unknown; loopVariables?: string[]; iterable?: unknown } | null {
  const trimmed = directive.trim();
  if (!trimmed) {
    return null;
  }
  if (/^else$/i.test(trimmed)) {
    return { kind: 'else' };
  }
  if (/^endif$/i.test(trimmed)) {
    return { kind: 'endif' };
  }
  if (/^endfor$/i.test(trimmed)) {
    return { kind: 'endfor' };
  }

  const setMatch = trimmed.match(/^set\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/i);
  if (setMatch) {
    return {
      kind: 'set',
      name: setMatch[1],
      value: evaluateTemplateExpression(setMatch[2].trim(), invocation, plannerState, staticContext),
    };
  }

  const forMatch = trimmed.match(/^for\s+(.+?)\s+in\s+(.+)$/i);
  if (forMatch) {
    return {
      kind: 'for',
      loopVariables: forMatch[1].split(',').map((name) => name.trim()).filter(Boolean),
      iterable: evaluateTemplateExpression(forMatch[2].trim(), invocation, plannerState, staticContext),
    };
  }

  const controlMatch = trimmed.match(/^(if|elif)\s+(.+)$/i);
  if (!controlMatch) {
    return null;
  }

  return {
    kind: controlMatch[1].toLowerCase() as 'if' | 'elif',
    result: evaluateTemplateCondition(controlMatch[2].trim(), invocation, plannerState, staticContext),
  };
}

function tokenizeTemplateLine(line: string): TemplateLineSegment[] {
  const trimmed = line.trimStart();
  if (trimmed.startsWith('#') || trimmed.startsWith(';')) {
    return [{ kind: 'text', text: line }];
  }

  const segments: TemplateLineSegment[] = [];
  const pattern = /\{%([\s\S]*?)%\}/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(line)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ kind: 'text', text: line.slice(lastIndex, match.index) });
    }
    segments.push({ kind: 'directive', directive: match[1] });
    lastIndex = pattern.lastIndex;
  }

  if (lastIndex < line.length) {
    segments.push({ kind: 'text', text: line.slice(lastIndex) });
  }

  return segments.length > 0 ? segments : [{ kind: 'text', text: line }];
}

function extractWholeLineTemplateDirective(line: string): string | null {
  const match = line.trim().match(/^\{%\s*([\s\S]*?)\s*%\}$/);
  return match?.[1] ?? null;
}

function collectTemplateLoopBody(lines: NumberedTemplateLine[], startIndex: number): { body: NumberedTemplateLine[]; endIndex: number } {
  const body: NumberedTemplateLine[] = [];
  let depth = 0;

  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const directive = extractWholeLineTemplateDirective(lines[index].text);
    if (directive) {
      const trimmed = directive.trim();
      if (/^for\b/i.test(trimmed)) {
        depth += 1;
      } else if (/^endfor$/i.test(trimmed)) {
        if (depth === 0) {
          return { body, endIndex: index };
        }
        depth -= 1;
      }
    }
    body.push(lines[index]);
  }

  return { body, endIndex: lines.length };
}

function coerceTemplateIterable(value: unknown): unknown[] {
  if (isUnresolved(value) || value == null) {
    return [];
  }
  if (Array.isArray(value)) {
    return value;
  }
  if (typeof value === 'string') {
    return value.split('');
  }
  if (typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>);
  }
  return [];
}

function assignLoopVariables(target: Record<string, unknown>, names: string[], value: unknown) {
  if (names.length === 0) {
    return;
  }
  if (names.length === 1) {
    target[names[0]] = value;
    return;
  }

  const values = Array.isArray(value) ? value : [value];
  names.forEach((name, index) => {
    target[name] = values[index];
  });
}

function findTemplateExpressionEnd(line: string, startIndex: number): number {
  let depthParen = 0;
  let depthBracket = 0;
  let depthBrace = 0;
  let inSingleQuote = false;
  let inDoubleQuote = false;

  for (let index = startIndex; index < line.length; index += 1) {
    const char = line[index];
    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      continue;
    }
    if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }
    if (inSingleQuote || inDoubleQuote) {
      continue;
    }

    if (char === '(') depthParen += 1;
    if (char === ')') depthParen -= 1;
    if (char === '[') depthBracket += 1;
    if (char === ']') depthBracket -= 1;
    if (char === '{') depthBrace += 1;
    if (char === '}') {
      if (depthBrace === 0 && depthParen === 0 && depthBracket === 0) {
        return index;
      }
      depthBrace -= 1;
    }
  }

  return -1;
}

function stringifyTemplateValue(value: unknown): string {
  if (value == null || isUnresolved(value)) {
    return '';
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => stringifyTemplateValue(entry)).join(', ');
  }
  return JSON.stringify(value);
}

function renderInlineTemplateExpressions(
  line: string,
  invocation: MacroInvocationContext,
  plannerState: PlannerState,
  staticContext: TemplateStaticContext,
): string {
  if (!line.includes('{')) {
    return line;
  }

  let rendered = '';
  let index = 0;

  while (index < line.length) {
    const openIndex = line.indexOf('{', index);
    if (openIndex === -1) {
      rendered += line.slice(index);
      break;
    }

    const nextChar = line[openIndex + 1];
    if (nextChar === '%' || nextChar === '#') {
      rendered += line.slice(index, openIndex + 1);
      index = openIndex + 1;
      continue;
    }

    const closeIndex = findTemplateExpressionEnd(line, openIndex + 1);
    if (closeIndex === -1) {
      rendered += line.slice(index);
      break;
    }

    rendered += line.slice(index, openIndex);
    const expression = line.slice(openIndex + 1, closeIndex).trim();
    const value = evaluateTemplateExpression(expression, invocation, plannerState, staticContext);
    rendered += isUnresolved(value) ? line.slice(openIndex, closeIndex + 1) : stringifyTemplateValue(value);
    index = closeIndex + 1;
  }

  return rendered;
}

function parseTemplateAwareGcodeLine(
  line: string,
  lineNumber: number,
  sourceName: string,
  invocation: MacroInvocationContext,
  plannerState: PlannerState,
  staticContext: TemplateStaticContext,
): ParsedGcodeCommand | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }

  const actionCommand = parseActionLine(trimmed, lineNumber, sourceName, (expression) => (
    evaluateTemplateExpression(expression, invocation, plannerState, staticContext)
  ));
  if (actionCommand) {
    return actionCommand;
  }

  return parseGcodeLine(renderInlineTemplateExpressions(line, invocation, plannerState, staticContext), lineNumber, sourceName);
}

function extractRawParams(commandRaw: string, commandName: string): string {
  return commandRaw.slice(commandName.length).trim();
}

function isBalancedCallExpression(expression: string): boolean {
  let depth = 0;
  let inSingleQuote = false;
  let inDoubleQuote = false;

  for (let index = 0; index < expression.length; index += 1) {
    const char = expression[index];
    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      continue;
    }
    if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }
    if (inSingleQuote || inDoubleQuote) {
      continue;
    }
    if (char === '(') depth += 1;
    if (char === ')') {
      depth -= 1;
      if (depth === 0 && index < expression.length - 1) {
        return false;
      }
    }
  }

  return depth === 0;
}

function evaluateTemplateCall(
  name: string,
  rawArgs: string,
  invocation: MacroInvocationContext,
  plannerState: PlannerState,
  staticContext: TemplateStaticContext,
): unknown {
  const args = rawArgs.trim()
    ? splitTopLevelByCharacter(rawArgs, ',').map((arg) => evaluateTemplateExpression(arg, invocation, plannerState, staticContext))
    : [];

  switch (name.toLowerCase()) {
    case 'range': {
      const numericArgs = args.map((arg) => (isUnresolved(arg) ? NaN : Number(arg)));
      if (numericArgs.length === 0 || numericArgs.some((arg) => !Number.isFinite(arg)) || numericArgs.length > 3) {
        return TEMPLATE_UNRESOLVED;
      }
      const [start, stop, step] = numericArgs.length === 1
        ? [0, numericArgs[0], 1]
        : numericArgs.length === 2
          ? [numericArgs[0], numericArgs[1], 1]
          : [numericArgs[0], numericArgs[1], numericArgs[2]];
      if (step === 0) {
        return TEMPLATE_UNRESOLVED;
      }
      const values: number[] = [];
      if (step > 0) {
        for (let value = start; value < stop; value += step) {
          values.push(value);
        }
      } else {
        for (let value = start; value > stop; value += step) {
          values.push(value);
        }
      }
      return values;
    }
    default:
      return TEMPLATE_UNRESOLVED;
  }
}

function formatPrintfValue(specifier: string, precision: number | null, value: unknown): string {
  const numericValue = isUnresolved(value) ? NaN : value;
  switch (specifier) {
    case 'd':
    case 'i':
      return `${Math.trunc(Number(numericValue) || 0)}`;
    case 'f': {
      const numeric = Number(numericValue);
      if (!Number.isFinite(numeric)) {
        return '0';
      }
      return precision === null ? `${numeric}` : numeric.toFixed(precision);
    }
    case 's':
    default:
      return stringifyTemplateValue(value);
  }
}

function formatTemplateString(format: string, value: unknown): string {
  const values = Array.isArray(value) ? value : [value];
  let valueIndex = 0;

  return format.replace(/%%|%(?:\.(\d+))?([disf])/g, (match, rawPrecision, specifier: string) => {
    if (match === '%%') {
      return '%';
    }
    const nextValue = valueIndex < values.length ? values[valueIndex] : '';
    valueIndex += 1;
    const precision = rawPrecision !== undefined ? Number(rawPrecision) : null;
    return formatPrintfValue(specifier, Number.isFinite(precision ?? NaN) ? precision : null, nextValue);
  });
}

function applyTemplateBinaryOperator(left: unknown, right: unknown, operator: string): unknown {
  if (isUnresolved(left) || isUnresolved(right)) {
    return TEMPLATE_UNRESOLVED;
  }

  if (operator === '+' && (typeof left === 'string' || typeof right === 'string')) {
    return `${stringifyTemplateValue(left)}${stringifyTemplateValue(right)}`;
  }

  if (operator === '%' && typeof left === 'string') {
    return formatTemplateString(left, right);
  }

  const leftNumeric = Number(left);
  const rightNumeric = Number(right);
  if (!Number.isFinite(leftNumeric) || !Number.isFinite(rightNumeric)) {
    return TEMPLATE_UNRESOLVED;
  }

  switch (operator) {
    case '+':
      return leftNumeric + rightNumeric;
    case '-':
      return leftNumeric - rightNumeric;
    case '*':
      return leftNumeric * rightNumeric;
    case '/':
      return rightNumeric === 0 ? TEMPLATE_UNRESOLVED : leftNumeric / rightNumeric;
    case '%':
      return rightNumeric === 0 ? TEMPLATE_UNRESOLVED : leftNumeric % rightNumeric;
    default:
      return TEMPLATE_UNRESOLVED;
  }
}

function parseActionLine(
  raw: string,
  lineNumber: number,
  sourceName: string,
  evaluator?: (expression: string) => unknown,
): ParsedGcodeCommand | null {
  const match = raw.match(/^\{\s*(action_[A-Za-z_][A-Za-z0-9_]*)\((.*)\)\s*\}$/i);
  if (!match) {
    return null;
  }

  const actionName = match[1].toUpperCase();
  const args = match[2].trim() ? splitTopLevelByCharacter(match[2], ',') : [];
  const evaluateArg = (expression: string): unknown => (
    evaluator ? evaluator(expression.trim()) : normalizeMessage(expression.trim())
  );

  if (actionName === 'ACTION_RESPOND_INFO' || actionName === 'ACTION_RAISE_ERROR' || actionName === 'ACTION_EMERGENCY_STOP') {
    const firstArg = args[0] ?? '';
    return {
      command: actionName,
      raw,
      params: { MSG: firstArg ? stringifyTemplateValue(evaluateArg(firstArg)) : '' },
      lineNumber,
      sourceName,
    };
  }

  if (actionName === 'ACTION_CALL_REMOTE_METHOD') {
    const params: Record<string, string> = {};
    const firstArg = args[0] ?? '';
    if (firstArg) {
      params.METHOD = stringifyTemplateValue(evaluateArg(firstArg));
    }
    args.slice(1).forEach((part) => {
      const separatorIndex = part.indexOf('=');
      if (separatorIndex === -1) {
        return;
      }
      const key = part.slice(0, separatorIndex).trim().toUpperCase();
      const valueExpression = part.slice(separatorIndex + 1).trim();
      if (!key) {
        return;
      }
      params[key] = stringifyTemplateValue(evaluateArg(valueExpression));
    });
    return {
      command: actionName,
      raw,
      params,
      lineNumber,
      sourceName,
    };
  }

  return null;
}

// Commands where featurePoints are probe coordinates — nozzle = point - probeOffset
const PROBE_COORD_COMMANDS = new Set([
  'BED_MESH_CALIBRATE', 'Z_TILT_ADJUST', 'QUAD_GANTRY_LEVEL',
  'BED_TILT_CALIBRATE', 'DELTA_CALIBRATE',
]);
// Commands where featurePoints are nozzle coordinates — probe = point + probeOffset
const NOZZLE_COORD_PROBE_COMMANDS = new Set(['SCREWS_TILT_CALCULATE']);
const CURRENT_POSITION_PROBE_COMMANDS = new Set(['PROBE', 'PROBE_ACCURACY', 'PROBE_CALIBRATE']);
// Commands where the nozzle moves directly with no probe involvement
const NOZZLE_DIRECT_COMMANDS = new Set(['BED_SCREWS_ADJUST']);

function expandCommandToSteps(
  command: ParsedGcodeCommand,
  profile: MachineProfile,
  configFiles?: Record<string, ConfigFile>,
  currentState?: Pick<MacroRuntimeState, 'x' | 'y' | 'z'>,
): SimulationStep[] {
  if (command.command === 'BED_MESH_CALIBRATE') {
    const calibrationPlan = getBedMeshCalibrationPlan(command, profile, configFiles);
    const samplingPlan = getProbeSamplingPlan(command, profile);
    const initialStep: SimulationStep = { kind: 'command', command };
    if (!calibrationPlan.points.length) {
      return [initialStep];
    }

    const useToolCoordinates = calibrationPlan.method === 'manual';
    return [
      initialStep,
      ...calibrationPlan.points.flatMap((point) => ([
        {
          kind: 'move' as const,
          x: useToolCoordinates ? point.x : point.x - profile.probeOffsetX,
          y: useToolCoordinates ? point.y : point.y - profile.probeOffsetY,
          z: calibrationPlan.moveZ,
          label: `${useToolCoordinates ? 'Travel to manual point' : 'Travel to'} ${point.label || ''}`.trim(),
          raw: `${useToolCoordinates ? 'travel to manual point' : 'travel to'} ${point.label || ''}`.trim(),
          sourceName: command.sourceName,
          lineNumber: command.lineNumber,
        },
        ...buildProbeSampleSteps(
          point.x,
          point.y,
          useToolCoordinates ? point.x : point.x - profile.probeOffsetX,
          useToolCoordinates ? point.y : point.y - profile.probeOffsetY,
          calibrationPlan.moveZ,
          profile.maxZ,
          `${useToolCoordinates ? 'Manual probe' : 'Probe'} ${point.label || ''}`.trim(),
          command.sourceName,
          command.lineNumber,
          samplingPlan,
          useToolCoordinates ? 'manual probe' : 'probe',
        ),
      ])),
    ];
  }

  if (CURRENT_POSITION_PROBE_COMMANDS.has(command.command) && currentState) {
    const samplingPlan = getProbeSamplingPlan(command, profile);
    const label = command.command === 'PROBE_ACCURACY'
      ? 'Probe accuracy'
      : command.command === 'PROBE_CALIBRATE'
        ? 'Probe calibrate'
        : 'Probe';
    return [
      { kind: 'command', command },
      ...buildProbeSampleSteps(
        currentState.x + profile.probeOffsetX,
        currentState.y + profile.probeOffsetY,
        currentState.x,
        currentState.y,
        currentState.z,
        profile.maxZ,
        label,
        command.sourceName,
        command.lineNumber,
        samplingPlan,
        command.command.toLowerCase(),
      ),
    ];
  }

  const points = profile.featurePoints[command.command] || [];

  if (PROBE_COORD_COMMANDS.has(command.command) && points.length) {
    const samplingPlan = getProbeSamplingPlan(command, profile);
    const moveZ = getProbeTravelHeight(command, profile, configFiles);
    const initialStep: SimulationStep = { kind: 'command', command };
    return [
      initialStep,
      ...points.flatMap((point) => ([
        {
          kind: 'move' as const,
          x: point.x - profile.probeOffsetX,
          y: point.y - profile.probeOffsetY,
          z: moveZ,
          label: `Travel to ${point.label || ''}`.trim(),
          raw: `travel to ${point.label || ''}`.trim(),
          sourceName: command.sourceName,
          lineNumber: command.lineNumber,
        },
        ...buildProbeSampleSteps(
          point.x,
          point.y,
          point.x - profile.probeOffsetX,
          point.y - profile.probeOffsetY,
          moveZ,
          profile.maxZ,
          `Probe ${point.label || ''}`.trim(),
          command.sourceName,
          command.lineNumber,
          samplingPlan,
        ),
      ])),
    ];
  }

  if (NOZZLE_COORD_PROBE_COMMANDS.has(command.command) && points.length) {
    const calculateProbeX = (point: { x: number; y: number }) => point.x + profile.probeOffsetX;
    const calculateProbeY = (point: { x: number; y: number }) => point.y + profile.probeOffsetY;
    const samplingPlan = getProbeSamplingPlan(command, profile);
    const moveZ = getProbeTravelHeight(command, profile, configFiles);
    const initialStep: SimulationStep = { kind: 'command', command };
    return [
      initialStep,
      ...points.flatMap((point) => ([
        {
          kind: 'move' as const,
          x: point.x,
          y: point.y,
          z: moveZ,
          label: `Travel to ${point.label || ''}`.trim(),
          raw: `travel to ${point.label || ''}`.trim(),
          sourceName: command.sourceName,
          lineNumber: command.lineNumber,
        },
        ...buildProbeSampleSteps(
          calculateProbeX(point),
          calculateProbeY(point),
          point.x,
          point.y,
          moveZ,
          profile.maxZ,
          `Probe ${point.label || ''}`.trim(),
          command.sourceName,
          command.lineNumber,
          samplingPlan,
        ),
      ])),
    ];
  }

  if (NOZZLE_DIRECT_COMMANDS.has(command.command) && points.length) {
    const initialStep: SimulationStep = { kind: 'command', command };
    return [
      initialStep,
      ...points.map((point) => ({
        kind: 'move' as const,
        x: point.x,
        y: point.y,
        z: 0,
        label: `Move to ${point.label || ''}`.trim(),
        raw: command.raw,
        sourceName: command.sourceName,
        lineNumber: command.lineNumber,
      })),
    ];
  }

  return [{ kind: 'command', command }];
}

export function buildSimulationSteps(
  root: MacroSourceItem,
  allMacros: MacroSourceItem[],
  profile: MachineProfile,
  configFiles?: Record<string, ConfigFile>,
  rootInvocation?: { params?: Record<string, string>; rawparams?: string },
  initialState?: MacroRuntimeState,
): SimulationBuildResult {
  const macroLookup = buildMacroLookup(allMacros);
  const warnings: string[] = [];
  const steps: SimulationStep[] = [];
  const stack: string[] = [];
  const plannerState = createInitialPlannerState(allMacros);
  if (initialState) {
    plannerState.homedAxes = new Set(initialState.homedAxes.map((axis) => axis.toUpperCase() as 'X' | 'Y' | 'Z'));
    plannerState.bedCurrent = initialState.bed.current;
    plannerState.bedTarget = initialState.bed.target;
    plannerState.nozzleCurrent = initialState.nozzle.current;
    plannerState.nozzleTarget = initialState.nozzle.target;
    plannerState.fanSpeed = initialState.fanSpeed;
    plannerState.absoluteMoves = initialState.absoluteMoves;
    plannerState.absoluteExtrusion = initialState.absoluteExtrusion;
  }
  let previewState = initialState ?? createInitialRuntimeState(profile, root.title);
  const staticContext = buildTemplateStaticContext(
    allMacros,
    configFiles,
    profile,
    () => ({ x: previewState.x, y: previewState.y, z: previewState.z, e: previewState.e }),
  );
  let visit: (macro: MacroSourceItem, allowHomingOverride?: boolean, invocation?: MacroInvocationContext) => void;

  const appendSimulationSteps = (nextSteps: SimulationStep[]) => {
    if (!nextSteps.length) {
      return;
    }
    steps.push(...nextSteps);
    nextSteps.forEach((step) => {
      previewState = executeSimulationStep(previewState, step, profile, configFiles).nextState;
    });
  };

  // Build a reverse map: rename_existing value → original command name.
  // e.g. if [gcode_macro BED_MESH_CALIBRATE] has rename_existing: _BED_MESH_CALIBRATE,
  // then "_BED_MESH_CALIBRATE" → "BED_MESH_CALIBRATE" (the built-in).
  const renameMap = new Map<string, string>();
  for (const item of allMacros) {
    if (item.renameExisting.trim()) {
      renameMap.set(item.renameExisting.trim().toUpperCase(), item.title.toUpperCase());
    }
  }

  const appendHomingOverrideSteps = (parsed: ParsedGcodeCommand) => {
    if (parsed.command !== 'G28' || !profile.homingOverride?.gcode.trim()) return false;

    // If the homing override gcode would call a macro that is already in the
    // call stack (e.g. _HOME_X calling G28 X0 while homing_override calls _HOME_X),
    // skip the override and fall through to raw G28 behaviour to avoid a loop.
    const overrideWouldLoop = profile.homingOverride.gcode.split(/\r?\n/).some((line) => {
      const cmd = parseGcodeLine(line, 0, 'homing_override');
      return cmd && cmd.command !== '__TEMPLATE__' && stack.includes(cmd.command.toUpperCase());
    });
    if (overrideWouldLoop) return false;

    const requestedAxes = getRequestedAxes(parsed.params);
    const shouldUseOverride = requestedAxes.length === 0
      ? true
      : requestedAxes.some((axis) => profile.homingOverride?.axes.includes(axis));

    if (!shouldUseOverride) return false;

    const relevantAxes: Array<'X' | 'Y' | 'Z'> = requestedAxes.length ? requestedAxes : ['X', 'Y', 'Z'];
    const preHomeParams = relevantAxes.reduce<Record<string, string>>((params, axis) => {
      const value = profile.homingOverride?.setPosition[axis];
      if (typeof value === 'number') {
        params[axis] = `${value}`;
      }
      return params;
    }, {});

    if (Object.keys(preHomeParams).length > 0) {
      appendSimulationSteps([{
        kind: 'command',
        command: {
          command: 'G92',
          raw: `G92 ${Object.entries(preHomeParams).map(([axis, value]) => `${axis}${value}`).join(' ')}`,
          params: preHomeParams,
          lineNumber: parsed.lineNumber,
          sourceName: 'homing_override',
        },
      }]);
    }

    visit({
      key: '__homing_override__',
      source: 'builtin',
      title: 'homing_override',
      renameExisting: '',
      description: '',
      variables: '',
      gcode: profile.homingOverride.gcode,
      readOnly: true,
    }, false, {
      params: parsed.params,
      rawparams: extractRawParams(parsed.raw, parsed.command),
      locals: {},
    });

    return true;
  };

  const appendParsedCommand = (
    parsed: ParsedGcodeCommand,
    currentMacro: MacroSourceItem | null,
    allowHomingOverride = true,
  ) => {
    if (allowHomingOverride && appendHomingOverrideSteps(parsed)) {
      return;
    }

    const nested = macroLookup.get(parsed.command);
    if (nested && (!currentMacro || nested.key !== currentMacro.key)) {
      visit(nested, allowHomingOverride, {
        params: parsed.params,
        rawparams: extractRawParams(parsed.raw, parsed.command),
        locals: {},
      });
      return;
    }

    const originalCommand = renameMap.get(parsed.command);
    if (originalCommand) {
      const rawRest = parsed.raw.slice(parsed.command.length);
      const rewritten: ParsedGcodeCommand = { ...parsed, command: originalCommand, raw: `${originalCommand}${rawRest}` };
      const rewrittenWarning = rewritten.command === 'SET_KINEMATIC_POSITION'
        ? getSetKinematicPositionWarning(configFiles)
        : null;
      if (rewrittenWarning && !warnings.includes(rewrittenWarning)) {
        warnings.push(rewrittenWarning);
      }
      appendSimulationSteps(expandCommandToSteps(rewritten, profile, configFiles, previewState));
      applyPlannerCommandEffects(rewritten, plannerState);
      return;
    }

    const commandWarning = parsed.command === 'SET_KINEMATIC_POSITION'
      ? getSetKinematicPositionWarning(configFiles)
      : null;
    if (commandWarning && !warnings.includes(commandWarning)) {
      warnings.push(commandWarning);
    }

    appendSimulationSteps(expandCommandToSteps(parsed, profile, configFiles, previewState));
    applyPlannerCommandEffects(parsed, plannerState);
  };

  visit = (macro: MacroSourceItem, allowHomingOverride = true, invocation = { params: {}, rawparams: '', locals: {} }) => {
    const title = macro.title.toUpperCase();
    if (stack.includes(title)) {
      warnings.push(`Macro loop detected: ${[...stack, title].join(' -> ')}`);
      return;
    }
    stack.push(title);
    const lines: NumberedTemplateLine[] = macro.gcode.split(/\r?\n/).map((text, index) => ({ text, lineNumber: index + 1 }));
    const conditionalStack: Array<{ parentActive: boolean; branchTaken: boolean; active: boolean }> = [];
    const isBranchActive = () => conditionalStack.every((entry) => entry.active);

    const visitLines = (templateLines: NumberedTemplateLine[]) => {
      for (let lineIndex = 0; lineIndex < templateLines.length; lineIndex += 1) {
        const line = templateLines[lineIndex];
        const wholeLineDirective = extractWholeLineTemplateDirective(line.text);
        if (wholeLineDirective) {
          const templateControl = parseTemplateDirective(wholeLineDirective, invocation, plannerState, staticContext);
          if (!templateControl) {
            continue;
          }
          switch (templateControl.kind) {
            case 'set':
              if (isBranchActive() && templateControl.name && !isUnresolved(templateControl.value)) {
                invocation.locals[templateControl.name] = templateControl.value;
              }
              continue;
            case 'if': {
              const parentActive = isBranchActive();
              const conditionMatched = templateControl.result !== false;
              conditionalStack.push({
                parentActive,
                branchTaken: conditionMatched,
                active: parentActive && conditionMatched,
              });
              continue;
            }
            case 'elif': {
              const current = conditionalStack[conditionalStack.length - 1];
              if (!current) {
                continue;
              }
              const conditionMatched = templateControl.result !== false;
              current.active = current.parentActive && !current.branchTaken && conditionMatched;
              current.branchTaken = current.branchTaken || conditionMatched;
              continue;
            }
            case 'else': {
              const current = conditionalStack[conditionalStack.length - 1];
              if (!current) {
                continue;
              }
              current.active = current.parentActive && !current.branchTaken;
              current.branchTaken = true;
              continue;
            }
            case 'endif':
              conditionalStack.pop();
              continue;
            case 'for': {
              const { body, endIndex } = collectTemplateLoopBody(templateLines, lineIndex);
              if (isBranchActive()) {
                const iterable = coerceTemplateIterable(templateControl.iterable);
                const loopVariables = templateControl.loopVariables || [];
                const savedValues = loopVariables.map((name) => ({
                  name,
                  hasValue: Object.prototype.hasOwnProperty.call(invocation.locals, name),
                  value: invocation.locals[name],
                }));
                iterable.forEach((entry) => {
                  assignLoopVariables(invocation.locals, loopVariables, entry);
                  visitLines(body);
                });
                savedValues.forEach(({ name, hasValue, value }) => {
                  if (hasValue) {
                    invocation.locals[name] = value;
                  } else {
                    delete invocation.locals[name];
                  }
                });
              }
              lineIndex = endIndex;
              continue;
            }
            case 'endfor':
              continue;
          }
        }

        if (!isBranchActive()) {
          continue;
        }

        const parsed = parseTemplateAwareGcodeLine(line.text, line.lineNumber, macro.title, invocation, plannerState, staticContext);
        if (!parsed) {
          continue;
        }
        appendParsedCommand(parsed, macro, allowHomingOverride);
      }
    };

    visitLines(lines);
    stack.pop();
  };

  visit(root, true, {
    params: rootInvocation?.params ?? {},
    rawparams: rootInvocation?.rawparams ?? '',
    locals: {},
  });
  logMacroDesignerEvent({
    event: 'sim:plan',
    macro: root.title,
    stepCount: steps.length,
    warningCount: warnings.length,
    warnings: warnings.slice(0, 10),
    rootParams: rootInvocation?.params ?? {},
    nestedMacros: stack.length > 0 ? stack : undefined,
  });
  return { steps, warnings };
}

function updateTargetTemperature(current: number, target: number): number {
  if (current === target) return current;
  const delta = target - current;
  const step = Math.min(Math.abs(delta), 20);
  return current + Math.sign(delta) * step;
}

function applyLinearMove(
  state: MacroRuntimeState,
  params: Record<string, string>,
  profile: MachineProfile,
  configFiles?: Record<string, ConfigFile>,
): SimulationTickResult {
  const xValue = asNumber(params.X);
  const yValue = asNumber(params.Y);
  const zValue = asNumber(params.Z);
  const eValue = asNumber(params.E);
  const fValue = asNumber(params.F);

  const nextX = xValue === null
    ? state.x
    : (state.absoluteMoves ? xValue + state.gcodeOffset.x : state.x + xValue);
  const nextY = yValue === null
    ? state.y
    : (state.absoluteMoves ? yValue + state.gcodeOffset.y : state.y + yValue);
  const nextZ = zValue === null
    ? state.z
    : (state.absoluteMoves ? zValue + state.gcodeOffset.z : state.z + zValue);
  const nextE = eValue === null
    ? state.e
    : (state.absoluteExtrusion ? eValue : state.e + eValue);
  const warnings: string[] = [];

  if (isTemplateValue(params.X) || isTemplateValue(params.Y) || isTemplateValue(params.Z) || isTemplateValue(params.E)) {
    return {
      nextState: {
        ...state,
        feedRate: fValue ?? state.feedRate,
        nozzle: { ...state.nozzle, current: updateTargetTemperature(state.nozzle.current, state.nozzle.target) },
        bed: { ...state.bed, current: updateTargetTemperature(state.bed.current, state.bed.target) },
        activeProbePoint: null,
        activeBuiltInCommand: null,
      },
      warnings,
      eventSummary: 'Dynamic move with template values',
    };
  }

  // Klipper refuses moves on axes that have not been homed yet ("Must home
  // axis first"). Only axes explicitly requested in this move are checked.
  const movedAxes = [
    xValue !== null ? 'X' : null,
    yValue !== null ? 'Y' : null,
    zValue !== null ? 'Z' : null,
  ].filter((axis): axis is 'X' | 'Y' | 'Z' => axis !== null);
  const homedSet = new Set(state.homedAxes.map((axis) => axis.toUpperCase()));
  const unhomedAxes = movedAxes.filter((axis) => !homedSet.has(axis));
  if (unhomedAxes.length > 0) {
    warnings.push(`Move requires homed ${unhomedAxes.join(', ')} axis (must home first).`);
  }

  // Klipper refuses extrusion below min_extrude_temp (default 170C).
  const extrudeDelta = nextE - state.e;
  if (extrudeDelta > 0 && state.nozzle.current < DEFAULT_MIN_EXTRUDE_TEMP) {
    warnings.push(
      `Extrusion requires nozzle temperature above ${DEFAULT_MIN_EXTRUDE_TEMP}C (currently ${state.nozzle.current.toFixed(0)}C).`,
    );
  }

  if (unhomedAxes.length > 0 || (extrudeDelta > 0 && state.nozzle.current < DEFAULT_MIN_EXTRUDE_TEMP)) {
    // Klipper raises an error and the move does not execute.
    return {
      nextState: {
        ...state,
        feedRate: fValue ?? state.feedRate,
        nozzle: { ...state.nozzle, current: updateTargetTemperature(state.nozzle.current, state.nozzle.target) },
        bed: { ...state.bed, current: updateTargetTemperature(state.bed.current, state.bed.target) },
        activeProbePoint: null,
        activeBuiltInCommand: null,
      },
      warnings,
      eventSummary: 'Move refused',
    };
  }

  if (!isPointInMoveBounds(profile, nextX, nextY)) {
    warnings.push(`Move to X${nextX.toFixed(2)} Y${nextY.toFixed(2)} exceeds the moveable area.`);
  }
  const zone = findPathZoneHit(profile, state.x, state.y, nextX, nextY);
  if (zone) {
    warnings.push(`Move path crosses no-go zone \"${zone.name}\".`);
  }
  if (nextZ < profile.minZ || nextZ > profile.maxZ) {
    warnings.push(`Move to Z${nextZ.toFixed(2)} exceeds the configured Z range.`);
  }

  const distance = Math.sqrt((nextX - state.x) ** 2 + (nextY - state.y) ** 2 + (nextZ - state.z) ** 2);
  if (distance < 1e-6 && extrudeDelta > profile.maxExtrudeCrossSection) {
    warnings.push(
      `Extrude-only move E${extrudeDelta.toFixed(2)} exceeds max_extrude_cross_section ${profile.maxExtrudeCrossSection.toFixed(2)}.`,
    );
  }
  const effectiveFeedRate = fValue ?? state.feedRate;
  const moveTime = estimateMoveTime(distance, effectiveFeedRate, profile.maxVelocity, profile.maxAccel);
  if (effectiveFeedRate / 60 > profile.maxVelocity) {
    warnings.push(`Feed rate ${effectiveFeedRate} mm/min (${(effectiveFeedRate / 60).toFixed(1)} mm/s) exceeds max velocity ${profile.maxVelocity} mm/s.`);
  }

  return {
    nextState: {
      ...state,
      x: nextX,
      y: nextY,
      z: nextZ,
      e: nextE,
      feedRate: effectiveFeedRate,
      elapsedTimeS: state.elapsedTimeS + moveTime,
      lastZDirection: nextZ > state.z ? 'up' : nextZ < state.z ? 'down' : 'flat',
      nozzle: { ...state.nozzle, current: updateTargetTemperature(state.nozzle.current, state.nozzle.target) },
      bed: { ...state.bed, current: updateTargetTemperature(state.bed.current, state.bed.target) },
      activeProbePoint: null,
      activeBuiltInCommand: null,
    },
    warnings,
    eventSummary: `Move to X${nextX.toFixed(2)} Y${nextY.toFixed(2)} Z${nextZ.toFixed(2)}`,
  };
}

function setLedState(state: MacroRuntimeState, params: Record<string, string>): MacroRuntimeState {
  const ledName = params.LED || 'default';
  const next = cloneLedState(state.ledStates[ledName] || { red: 0, green: 0, blue: 0, white: 0 });
  if (params.RED !== undefined) next.red = Number(params.RED) || 0;
  if (params.GREEN !== undefined) next.green = Number(params.GREEN) || 0;
  if (params.BLUE !== undefined) next.blue = Number(params.BLUE) || 0;
  if (params.WHITE !== undefined) next.white = Number(params.WHITE) || 0;
  return {
    ...state,
    ledStates: {
      ...state.ledStates,
      [ledName]: next,
    },
  };
}

export function executeStandaloneCommand(
  line: string,
  state: MacroRuntimeState,
  profile: MachineProfile,
  configFiles?: Record<string, ConfigFile>,
): { nextState: MacroRuntimeState; warnings: string[]; eventSummary: string } {
  const parsed = parseGcodeLine(line, 0, 'seed');
  if (!parsed) {
    return { nextState: state, warnings: [], eventSummary: 'No command recognized' };
  }
  const steps = expandCommandToSteps(parsed, profile, configFiles, state);
  let current = state;
  const warnings: string[] = [];
  let lastSummary = parsed.raw;
  for (const step of steps) {
    const result = executeSimulationStep(current, step, profile, configFiles);
    current = result.nextState;
    warnings.push(...result.warnings);
    lastSummary = result.eventSummary || lastSummary;
  }
  return { nextState: current, warnings, eventSummary: lastSummary };
}

export function executeSimulationStep(
  state: MacroRuntimeState,
  step: SimulationStep,
  profile: MachineProfile,
  configFiles?: Record<string, ConfigFile>,
): SimulationTickResult {
  if (step.kind === 'move') {
    const warnings: string[] = [];
    if (!isPointInMoveBounds(profile, step.x, step.y)) {
      warnings.push(`${step.label} goes outside the moveable area.`);
    }
    const zone = findPathZoneHit(profile, state.x, state.y, step.x, step.y);
    if (zone) warnings.push(`${step.label} path crosses no-go zone \"${zone.name}\".`);
    const distance = Math.sqrt((step.x - state.x) ** 2 + (step.y - state.y) ** 2);
    const effectiveFeedRate = step.feedRate ?? state.feedRate;
    const moveTime = estimateMoveTime(distance, effectiveFeedRate, profile.maxVelocity, profile.maxAccel);
    return {
      nextState: {
        ...state,
        x: step.x,
        y: step.y,
        z: typeof step.z === 'number' ? step.z : state.z,
        elapsedTimeS: state.elapsedTimeS + moveTime,
        lastZDirection: typeof step.z === 'number'
          ? (step.z > state.z ? 'up' : step.z < state.z ? 'down' : 'flat')
          : 'flat',
        activeProbePoint: null,
      },
      warnings,
      eventSummary: step.label,
    };
  }

  if (step.kind === 'probe') {
    const warnings: string[] = [];
    if (!isPointInBounds(profile, step.x, step.y)) {
      warnings.push(`${step.label} is outside the probeable area.`);
    }
    const zone = findZoneHit(profile, step.x, step.y);
    if (zone) warnings.push(`${step.label} is inside no-go zone \"${zone.name}\".`);
    return {
      nextState: {
        ...state,
        activeProbePoint: { x: step.x, y: step.y, label: step.label },
        activeBuiltInCommand: step.label.split(' ')[0],
      },
      warnings,
      eventSummary: step.label,
    };
  }

  const { command } = step;
  const warnings: string[] = [];
  let nextState: MacroRuntimeState = {
    ...state,
    nozzle: { ...state.nozzle, current: updateTargetTemperature(state.nozzle.current, state.nozzle.target) },
    bed: { ...state.bed, current: updateTargetTemperature(state.bed.current, state.bed.target) },
    activeProbePoint: null,
    activeBuiltInCommand: null,
  };
  let eventSummary = command.raw;

  switch (command.command) {
    case 'G0':
    case 'G1':
      return applyLinearMove(state, command.params, profile, configFiles);
    case 'G28': {
      const requestedAxes = Object.keys(command.params).map((key) => key.toUpperCase());
      const homeAllAxes = requestedAxes.length === 0;
      const homeX = homeAllAxes || requestedAxes.includes('X') ? profile.homeX : state.x;
      const homeY = homeAllAxes || requestedAxes.includes('Y') ? profile.homeY : state.y;
      const homeZ = homeAllAxes || requestedAxes.includes('Z') ? profile.homeZ : state.z;
      nextState = {
        ...nextState,
        x: homeX,
        y: homeY,
        z: homeZ,
        homedAxes: normalizeRuntimeHomedAxes([
          ...state.homedAxes,
          ...(homeAllAxes ? ['X', 'Y', 'Z'] : requestedAxes),
        ]),
      };
      eventSummary = 'Home axes';
      break;
    }
    case 'G90':
      nextState = { ...nextState, absoluteMoves: true };
      eventSummary = 'Absolute positioning';
      break;
    case 'G91':
      nextState = { ...nextState, absoluteMoves: false };
      eventSummary = 'Relative positioning';
      break;
    case 'M82':
      nextState = { ...nextState, absoluteExtrusion: true };
      eventSummary = 'Absolute extrusion';
      break;
    case 'M83':
      nextState = { ...nextState, absoluteExtrusion: false };
      eventSummary = 'Relative extrusion';
      break;
    case 'G92':
      nextState = {
        ...nextState,
        x: asNumber(command.params.X) ?? state.x,
        y: asNumber(command.params.Y) ?? state.y,
        z: asNumber(command.params.Z) ?? state.z,
        e: asNumber(command.params.E) ?? state.e,
      };
      eventSummary = 'Set current position';
      break;
    case 'M104':
    case 'M109': {
      if (isTemplateValue(command.params.S)) {
        eventSummary = `${command.command === 'M109' ? 'Wait for' : 'Set'} nozzle target (template)`;
        break;
      }
      const target = asNumber(command.params.S) ?? nextState.nozzle.target;
      if (target < 0 || target > profile.nozzleMaxTemp) {
        warnings.push(`Requested nozzle temperature ${target} exceeds the configured range.`);
        eventSummary = `Refuse nozzle target ${target}C (out of range)`;
        break;
      }
      nextState = {
        ...nextState,
        nozzle: {
          current: command.command === 'M109' ? target : nextState.nozzle.current,
          target,
        },
      };
      eventSummary = `${command.command === 'M109' ? 'Wait for' : 'Set'} nozzle target ${target}C`;
      break;
    }
    case 'M140':
    case 'M190': {
      if (isTemplateValue(command.params.S)) {
        eventSummary = `${command.command === 'M190' ? 'Wait for' : 'Set'} bed target (template)`;
        break;
      }
      const target = asNumber(command.params.S) ?? nextState.bed.target;
      if (target < 0 || target > profile.bedMaxTemp) {
        warnings.push(`Requested bed temperature ${target} exceeds the configured range.`);
        eventSummary = `Refuse bed target ${target}C (out of range)`;
        break;
      }
      nextState = {
        ...nextState,
        bed: {
          current: command.command === 'M190' ? target : nextState.bed.current,
          target,
        },
      };
      eventSummary = `${command.command === 'M190' ? 'Wait for' : 'Set'} bed target ${target}C`;
      break;
    }
    case 'TURN_OFF_HEATERS':
      nextState = {
        ...nextState,
        bed: { current: nextState.bed.current, target: 0 },
        nozzle: { current: nextState.nozzle.current, target: 0 },
      };
      eventSummary = 'Turn off heaters';
      break;
    case 'M106': {
      if (isTemplateValue(command.params.S)) {
        eventSummary = 'Set fan speed (template)';
        break;
      }
      const value = Math.max(0, Math.min(255, asNumber(command.params.S) ?? 255));
      nextState = { ...nextState, fanSpeed: value / 255 };
      eventSummary = `Set fan ${(value / 255 * 100).toFixed(0)}%`;
      break;
    }
    case 'M107':
      nextState = { ...nextState, fanSpeed: 0 };
      eventSummary = 'Fan off';
      break;
    case 'M18':
    case 'M84':
      eventSummary = 'Disable steppers';
      break;
    case 'SET_FAN_SPEED': {
      if (isTemplateValue(command.params.SPEED)) {
        eventSummary = 'Set fan speed (template)';
        break;
      }
      const speed = Math.max(0, Math.min(1, Number(command.params.SPEED) || 0));
      nextState = { ...nextState, fanSpeed: speed };
      eventSummary = `Set fan ${(speed * 100).toFixed(0)}%`;
      break;
    }
    case 'SET_LED':
      nextState = setLedState(nextState, command.params);
      eventSummary = `Update LED ${command.params.LED || 'default'}`;
      break;
    case 'SET_DISPLAY_TEXT':
    case 'M117': {
      const text = normalizeMessage(command.params.MSG || command.raw.replace(/^M117\s*/i, ''));
      nextState = { ...nextState, displayText: text };
      eventSummary = `Display: ${text}`;
      break;
    }
    case 'RESPOND': {
      const text = normalizeMessage(command.params.MSG || '');
      nextState = { ...nextState, messages: [...nextState.messages, text] };
      eventSummary = `Terminal: ${text}`;
      break;
    }
    case 'ACTION_RESPOND_INFO': {
      const text = normalizeMessage(command.params.MSG || command.raw);
      nextState = { ...nextState, messages: [...nextState.messages, text] };
      eventSummary = `Info: ${text}`;
      break;
    }
    case 'ACTION_RAISE_ERROR': {
      const text = normalizeMessage(command.params.MSG || command.raw);
      nextState = { ...nextState, messages: [...nextState.messages, text] };
      warnings.push(text || 'Macro raised an error.');
      eventSummary = 'Raise error';
      break;
    }
    case 'ACTION_EMERGENCY_STOP': {
      const text = normalizeMessage(command.params.MSG || command.raw);
      nextState = { ...nextState, messages: [...nextState.messages, text] };
      warnings.push(text || 'Emergency stop requested.');
      eventSummary = 'Emergency stop';
      break;
    }
    case 'ACTION_CALL_REMOTE_METHOD': {
      const methodName = command.params.METHOD || 'remote_method';
      const argumentEntries = Object.entries(command.params)
        .filter(([key]) => key !== 'METHOD')
        .map(([key, value]) => `${key.toLowerCase()}=${value}`);
      const summary = argumentEntries.length > 0
        ? `Remote method ${methodName}(${argumentEntries.join(', ')})`
        : `Remote method ${methodName}`;
      nextState = { ...nextState, messages: [...nextState.messages, summary] };
      eventSummary = summary;
      break;
    }
    case '__TEMPLATE__':
      eventSummary = 'Template directive';
      break;
    case 'SET_GCODE_OFFSET': {
      const nextOffset = { ...nextState.gcodeOffset };
      if (command.params.X !== undefined) nextOffset.x = Number(command.params.X) || 0;
      if (command.params.Y !== undefined) nextOffset.y = Number(command.params.Y) || 0;
      if (command.params.Z !== undefined) nextOffset.z = Number(command.params.Z) || 0;
      if (command.params.X_ADJUST !== undefined) nextOffset.x += Number(command.params.X_ADJUST) || 0;
      if (command.params.Y_ADJUST !== undefined) nextOffset.y += Number(command.params.Y_ADJUST) || 0;
      if (command.params.Z_ADJUST !== undefined) nextOffset.z += Number(command.params.Z_ADJUST) || 0;
      nextState = { ...nextState, gcodeOffset: nextOffset };
      eventSummary = 'Adjust gcode offset';
      break;
    }
    case 'SET_KINEMATIC_POSITION': {
      const forceMoveWarning = getSetKinematicPositionWarning(configFiles);
      if (forceMoveWarning) {
        warnings.push(forceMoveWarning);
      }
      const requestedAxes = getRequestedAxes(command.params);
      nextState = {
        ...nextState,
        x: asNumber(command.params.X) ?? nextState.x,
        y: asNumber(command.params.Y) ?? nextState.y,
        z: asNumber(command.params.Z) ?? nextState.z,
        homedAxes: normalizeRuntimeHomedAxes([...nextState.homedAxes, ...requestedAxes]),
      };
      eventSummary = 'Set kinematic position';
      break;
    }
    case 'SAVE_GCODE_STATE': {
      const name = command.params.NAME || 'default';
      nextState = {
        ...nextState,
        savedStates: {
          ...nextState.savedStates,
          [name]: {
            x: nextState.x,
            y: nextState.y,
            z: nextState.z,
            e: nextState.e,
            feedRate: nextState.feedRate,
            absoluteMoves: nextState.absoluteMoves,
            absoluteExtrusion: nextState.absoluteExtrusion,
            gcodeOffset: { ...nextState.gcodeOffset },
          },
        },
      };
      eventSummary = `Saved gcode state ${name}`;
      break;
    }
    case 'RESTORE_GCODE_STATE': {
      const name = command.params.NAME || 'default';
      const saved = nextState.savedStates[name];
      if (!saved) {
        warnings.push(`No saved gcode state named ${name}.`);
      } else {
        // In Klipper, RESTORE_GCODE_STATE defaults to MOVE=0, meaning the
        // toolhead does NOT physically move. Only restore the coordinate-system
        // settings; only restore position when MOVE=1 is explicitly requested.
        const shouldMove = command.params.MOVE === '1';
        nextState = {
          ...nextState,
          ...(shouldMove ? { x: saved.x, y: saved.y, z: saved.z, e: saved.e } : {}),
          feedRate: saved.feedRate,
          absoluteMoves: saved.absoluteMoves,
          absoluteExtrusion: saved.absoluteExtrusion,
          gcodeOffset: { ...saved.gcodeOffset },
        };
        eventSummary = `Restored gcode state ${name}`;
      }
      break;
    }
    case 'M400':
      eventSummary = 'Wait for queued moves';
      break;
    case 'G4':
      eventSummary = `Dwell ${command.params.P || '0'}ms`;
      break;
    case 'PAUSE':
      nextState = { ...nextState, isPaused: true };
      eventSummary = 'Pause print';
      break;
    case 'CLEAR_PAUSE':
      nextState = { ...nextState, isPaused: false };
      eventSummary = 'Clear pause';
      break;
    case 'RESUME':
      nextState = { ...nextState, isPaused: false };
      eventSummary = 'Resume print';
      break;
    case 'CANCEL_PRINT':
      nextState = { ...nextState, isPaused: false };
      eventSummary = 'Cancel print';
      break;
    case 'ACTIVATE_EXTRUDER': {
      const extruderName = command.params.EXTRUDER || command.params.NAME || nextState.activeExtruder;
      nextState = { ...nextState, activeExtruder: extruderName };
      eventSummary = `Activate extruder ${extruderName}`;
      break;
    }
    case 'TEMPERATURE_WAIT': {
      const sensor = command.params.SENSOR || command.params.HEATER || nextState.activeExtruder;
      eventSummary = sensor ? `Wait for ${sensor} temperature` : 'Wait for temperature';
      break;
    }
    case 'BED_MESH_PROFILE': {
      if (command.params.LOAD) {
        nextState = {
          ...nextState,
          bedMesh: {
            ...nextState.bedMesh,
            active: true,
            profile: command.params.LOAD,
          },
        };
        eventSummary = `Load bed mesh profile ${command.params.LOAD}`;
        break;
      }
      if (command.params.SAVE) {
        if (!nextState.bedMesh.active) {
          warnings.push('BED_MESH_PROFILE SAVE was issued without an active mesh loaded or calibrated.');
        }
        nextState = {
          ...nextState,
          bedMesh: {
            ...nextState.bedMesh,
            profile: nextState.bedMesh.active ? command.params.SAVE : nextState.bedMesh.profile,
          },
        };
        eventSummary = `Save bed mesh profile ${command.params.SAVE}`;
        break;
      }
      if (command.params.REMOVE) {
        eventSummary = `Remove bed mesh profile ${command.params.REMOVE}`;
        break;
      }
      eventSummary = 'Manage bed mesh profiles';
      break;
    }
    case 'BED_MESH_CLEAR':
      nextState = {
        ...nextState,
        bedMesh: {
          ...nextState.bedMesh,
          active: false,
          profile: null,
          method: null,
          adaptive: false,
        },
        activeBuiltInCommand: null,
        activeProbePoint: null,
      };
      eventSummary = 'Clear bed mesh';
      break;
    case 'BED_MESH_OUTPUT':
      eventSummary = command.params.PGP === '1'
        ? `Output bed mesh${nextState.bedMesh.profile ? ` ${nextState.bedMesh.profile}` : ''} with generated points`
        : `Output bed mesh${nextState.bedMesh.profile ? ` ${nextState.bedMesh.profile}` : ''}`;
      break;
    case 'BED_MESH_MAP':
      eventSummary = `Output bed mesh map${nextState.bedMesh.profile ? ` ${nextState.bedMesh.profile}` : ''}`;
      break;
    case 'BED_MESH_OFFSET': {
      nextState = {
        ...nextState,
        bedMesh: {
          ...nextState.bedMesh,
          offsets: {
            x: asNumber(command.params.X) ?? nextState.bedMesh.offsets.x,
            y: asNumber(command.params.Y) ?? nextState.bedMesh.offsets.y,
            zFade: asNumber(command.params.ZFADE) ?? nextState.bedMesh.offsets.zFade,
          },
        },
      };
      eventSummary = `Set bed mesh offset X${nextState.bedMesh.offsets.x.toFixed(2)} Y${nextState.bedMesh.offsets.y.toFixed(2)} ZFADE${nextState.bedMesh.offsets.zFade.toFixed(2)}`;
      break;
    }
    case 'SET_HEATER_TEMPERATURE': {
      const heaterName = command.params.HEATER || command.params.HEATER_NAME;
      const target = asNumber(command.params.TARGET) ?? asNumber(command.params.S);
      if (target !== null) {
        if (isBedHeater(heaterName)) {
          nextState = { ...nextState, bed: { ...nextState.bed, target } };
        } else if (isExtruderHeater(heaterName, nextState.activeExtruder)) {
          nextState = { ...nextState, nozzle: { ...nextState.nozzle, target } };
        }
      }
      eventSummary = heaterName
        ? `Set heater ${heaterName} target ${target ?? 0}C`
        : 'Set heater temperature';
      break;
    }
    case 'SAVE_VARIABLE': {
      const variableName = command.params.VARIABLE?.trim();
      const nextSaveVariables = variableName
        ? {
          ...nextState.saveVariables,
          [variableName]: parseConfiguredValue(command.params.VALUE || ''),
        }
        : nextState.saveVariables;
      nextState = { ...nextState, saveVariables: nextSaveVariables };
      eventSummary = variableName ? `Save variable ${variableName}` : 'Save variable';
      break;
    }
    case 'UPDATE_DELAYED_GCODE': {
      const identifier = command.params.ID || command.params.GCODE || 'delayed_gcode';
      const duration = asNumber(command.params.DURATION);
      eventSummary = duration === 0
        ? `Cancel delayed_gcode ${identifier}`
        : duration !== null
          ? `Schedule delayed_gcode ${identifier} in ${duration}s`
          : `Update delayed_gcode ${identifier}`;
      break;
    }
    case 'RESET_ACCEL':
    case 'SET_GCODE_VARIABLE':
    case 'QUERY_PROBE':
    case 'QUERY_ENDSTOPS':
    case 'M220':
    case 'M221':
    case 'SET_VELOCITY_LIMIT':
    case 'SET_IDLE_TIMEOUT':
    case 'EXCLUDE_OBJECT_DEFINE':
    case 'EXCLUDE_OBJECT':
    case 'SET_PRESSURE_ADVANCE':
    case 'SET_INPUT_SHAPER':
    case 'SET_RETRACTION':
    case 'SET_STEPPER_ENABLE':
    case 'SET_TMC_FIELD':
    case 'SET_TMC_CURRENT':
    case 'SET_SERVO':
    case 'SET_PIN':
    case 'MANUAL_PROBE':
    case 'Z_ENDSTOP_CALIBRATE':
    case 'AXIS_TWIST_COMPENSATION_CALIBRATE':
    case 'SAVE_CONFIG':
      eventSummary = command.command;
      break;
    case 'FIRMWARE_RESTART':
    case 'RESTART':
      nextState = {
        ...nextState,
        homedAxes: [],
        activeExtruder: DEFAULT_EXTRUDER_NAME,
        isPaused: false,
        bedMesh: createInitialBedMeshState(),
      };
      eventSummary = command.command;
      break;
    case 'STATUS':
    case 'TUNING_TOWER':
    case 'M204':
    case 'M205':
    case 'M900':
    case 'M105':
    case 'M112':
    case 'M114':
    case 'M115':
    case 'M118':
    case 'FORCE_MOVE':
    case 'ACCEPT':
    case 'ABORT':
    case 'TESTZ':
    case 'GET_POSITION':
    case 'PID_CALIBRATE':
      eventSummary = command.command;
      break;
    case 'BED_MESH_CALIBRATE': {
      const method = getBedMeshCalibrationMethod(command, profile);
      const profileName = getBedMeshProfileName(command);
      nextState = {
        ...nextState,
        bedMesh: {
          ...nextState.bedMesh,
          active: true,
          profile: profileName,
          method,
          adaptive: command.params.ADAPTIVE === '1',
        },
        activeBuiltInCommand: command.command,
      };
      eventSummary = `Calibrate bed mesh ${profileName} (${method})`;
      break;
    }
    case 'QUAD_GANTRY_LEVEL':
    case 'Z_TILT_ADJUST':
    case 'SCREWS_TILT_CALCULATE':
    case 'BED_SCREWS_ADJUST':
    case 'BED_TILT_CALIBRATE':
    case 'DELTA_CALIBRATE':
      nextState = { ...nextState, activeBuiltInCommand: command.command };
      eventSummary = command.command;
      break;
    case 'PROBE':
    case 'PROBE_ACCURACY':
    case 'PROBE_CALIBRATE': {
      const probeX = nextState.x + profile.probeOffsetX;
      const probeY = nextState.y + profile.probeOffsetY;
      if (profile.hasProbe && !isPointInBounds(profile, probeX, probeY)) {
        warnings.push(`${command.command} at X${probeX.toFixed(2)} Y${probeY.toFixed(2)} is outside the probeable area.`);
      }
      nextState = {
        ...nextState,
        activeProbePoint: profile.hasProbe ? { x: probeX, y: probeY, label: command.command } : null,
        activeBuiltInCommand: command.command,
      };
      eventSummary = `${command.command} at nozzle X${nextState.x.toFixed(2)} Y${nextState.y.toFixed(2)}`;
      break;
    }
    default:
      if (DOCUMENTED_GCODE_PASSTHROUGH_COMMANDS.has(command.command)) {
        eventSummary = formatDocumentedCommandSummary(command);
        break;
      }
      warnings.push(`Unsupported command ${command.command} was displayed but not fully simulated.`);
      break;
  }

  return {
    nextState,
    warnings,
    eventSummary,
  };
}