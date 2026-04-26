import type { MacroSourceItem } from '../types/macroDesigner';
import type {
  MachineProfile,
  MacroRuntimeState,
  ParsedGcodeCommand,
  RuntimeLedState,
  SimulationBuildResult,
  SimulationStep,
  SimulationTickResult,
} from '../types/macroDesigner';
import { findPathZoneHit, findZoneHit, isPointInBounds, isPointInMoveBounds } from './macroDesigner';

function parseParams(tokens: string[]): Record<string, string> {
  const params: Record<string, string> = {};
  for (const token of tokens) {
    if (!token) continue;
    const eqIndex = token.indexOf('=');
    if (eqIndex !== -1) {
      const key = token.slice(0, eqIndex).trim().toUpperCase();
      const value = token.slice(eqIndex + 1).trim().replace(/^"|"$/g, '');
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
  if (/^\{\s*action_respond_info\(/i.test(trimmed)) {
    return { command: 'ACTION_RESPOND_INFO', raw: trimmed, params: { MSG: extractActionMessage(trimmed) }, lineNumber, sourceName };
  }
  if (/^\{\s*action_raise_error\(/i.test(trimmed)) {
    return { command: 'ACTION_RAISE_ERROR', raw: trimmed, params: { MSG: extractActionMessage(trimmed) }, lineNumber, sourceName };
  }
  if (/^\{\s*action_emergency_stop/i.test(trimmed)) {
    return { command: 'ACTION_EMERGENCY_STOP', raw: trimmed, params: { MSG: extractActionMessage(trimmed) }, lineNumber, sourceName };
  }
  if (isTemplateDirective(trimmed)) {
    return { command: '__TEMPLATE__', raw: trimmed, params: {}, lineNumber, sourceName };
  }
  const withoutComment = line.replace(/;.*$/, '').trim();
  if (!withoutComment || withoutComment.startsWith('#')) return null;
  const tokens = withoutComment.match(/(?:"[^"]*"|\S+)/g) || [];
  const [commandToken, ...paramTokens] = tokens;
  if (!commandToken) return null;
  return {
    command: commandToken.toUpperCase(),
    raw: withoutComment,
    params: parseParams(paramTokens),
    lineNumber,
    sourceName,
  };
}

function cloneLedState(state: RuntimeLedState): RuntimeLedState {
  return { ...state };
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
    displayText: '',
    messages: [],
    ledStates: {},
    activeProbePoint: null,
    activeBuiltInCommand: null,
    activeMacro: macroName,
    elapsedTimeS: 0,
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

type PlannerState = {
  homedAxes: Set<'X' | 'Y' | 'Z'>;
};

const HOMING_AXES: Array<'X' | 'Y' | 'Z'> = ['X', 'Y', 'Z'];

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
      break;
    default:
      break;
  }
}

function evaluateHomedAxesExpression(expression: string, homedAxes: Set<'X' | 'Y' | 'Z'>): boolean | null {
  const trimmed = expression.trim().replace(/^\((.*)\)$/u, '$1').trim();

  const andParts = trimmed.split(/\s+and\s+/i);
  if (andParts.length > 1) {
    const values = andParts.map((part) => evaluateHomedAxesExpression(part, homedAxes));
    return values.every((value) => value !== null) ? values.every(Boolean) : null;
  }

  const orParts = trimmed.split(/\s+or\s+/i);
  if (orParts.length > 1) {
    const values = orParts.map((part) => evaluateHomedAxesExpression(part, homedAxes));
    return values.every((value) => value !== null) ? values.some(Boolean) : null;
  }

  const notMatch = trimmed.match(/^not\s+(.+)$/i);
  if (notMatch) {
    const value = evaluateHomedAxesExpression(notMatch[1], homedAxes);
    return value == null ? null : !value;
  }

  const membershipMatch = trimmed.match(/^['\"]([xyz]+)['\"]\s+(not\s+)?in\s+printer\.toolhead\.(?:homed_axes|home_axes)$/i);
  if (membershipMatch) {
    const wantedAxes = membershipMatch[1].toLowerCase();
    const isNegated = Boolean(membershipMatch[2]);
    const homed = getHomedAxesString(homedAxes);
    const value = homed.includes(wantedAxes);
    return isNegated ? !value : value;
  }

  const equalityMatch = trimmed.match(/^printer\.toolhead\.(?:homed_axes|home_axes)\s*([=!]=)\s*['\"]([xyz]+)['\"]$/i);
  if (equalityMatch) {
    const homed = getHomedAxesString(homedAxes);
    return equalityMatch[1] === '==' ? homed === equalityMatch[2].toLowerCase() : homed !== equalityMatch[2].toLowerCase();
  }

  return null;
}

function parseTemplateControlDirective(
  line: string,
  homedAxes: Set<'X' | 'Y' | 'Z'>,
): { kind: 'if' | 'elif' | 'else' | 'endif'; result?: boolean | null } | null {
  const trimmed = line.trim();
  const match = trimmed.match(/^\{%\s*(if|elif|else|endif)(.*?)%\}$/i);
  if (!match) return null;

  const kind = match[1].toLowerCase() as 'if' | 'elif' | 'else' | 'endif';
  if (kind === 'else' || kind === 'endif') {
    return { kind };
  }

  return {
    kind,
    result: evaluateHomedAxesExpression(match[2].trim(), homedAxes),
  };
}

// Commands where featurePoints are probe coordinates — nozzle = point - probeOffset
const PROBE_COORD_COMMANDS = new Set([
  'BED_MESH_CALIBRATE', 'Z_TILT_ADJUST', 'QUAD_GANTRY_LEVEL',
  'BED_TILT_CALIBRATE', 'DELTA_CALIBRATE',
]);
// Commands where featurePoints are nozzle coordinates — probe = point + probeOffset
const NOZZLE_COORD_PROBE_COMMANDS = new Set(['SCREWS_TILT_CALCULATE']);
// Commands where the nozzle moves directly with no probe involvement
const NOZZLE_DIRECT_COMMANDS = new Set(['BED_SCREWS_ADJUST']);

function expandCommandToSteps(command: ParsedGcodeCommand, profile: MachineProfile): SimulationStep[] {
  const points = profile.featurePoints[command.command] || [];

  if (PROBE_COORD_COMMANDS.has(command.command) && points.length) {
    return points.flatMap((point) => ([
      {
        kind: 'move' as const,
        x: point.x - profile.probeOffsetX,
        y: point.y - profile.probeOffsetY,
        z: profile.horizontalMoveZ,
        label: `${command.command} travel to ${point.label || ''}`.trim(),
        raw: command.raw,
        sourceName: command.sourceName,
        lineNumber: command.lineNumber,
      },
      {
        kind: 'probe' as const,
        x: point.x,
        y: point.y,
        label: `${command.command} probe ${point.label || ''}`.trim(),
        raw: `probe at ${point.x.toFixed(3)},${point.y.toFixed(3)} is z=0.000`,
        sourceName: command.sourceName,
        lineNumber: command.lineNumber,
      },
    ]));
  }

  if (NOZZLE_COORD_PROBE_COMMANDS.has(command.command) && points.length) {
    const calculateProbeX = (point: { x: number; y: number }) => point.x + profile.probeOffsetX;
    const calculateProbeY = (point: { x: number; y: number }) => point.y + profile.probeOffsetY;
    return points.flatMap((point) => ([
      {
        kind: 'move' as const,
        x: point.x,
        y: point.y,
        z: profile.horizontalMoveZ,
        label: `${command.command} travel to ${point.label || ''}`.trim(),
        raw: command.raw,
        sourceName: command.sourceName,
        lineNumber: command.lineNumber,
      },
      {
        kind: 'probe' as const,
        x: calculateProbeX(point),
        y: calculateProbeY(point),
        label: `${command.command} probe ${point.label || ''}`.trim(),
        raw: `probe at ${calculateProbeX(point).toFixed(3)},${calculateProbeY(point).toFixed(3)} is z=0.000`,
        sourceName: command.sourceName,
        lineNumber: command.lineNumber,
      },
    ]));
  }

  if (NOZZLE_DIRECT_COMMANDS.has(command.command) && points.length) {
    return points.map((point) => ({
      kind: 'move' as const,
      x: point.x,
      y: point.y,
      z: 0,
      label: `${command.command} nozzle to ${point.label || ''}`.trim(),
      raw: command.raw,
      sourceName: command.sourceName,
      lineNumber: command.lineNumber,
    }));
  }

  return [{ kind: 'command', command }];
}

export function buildSimulationSteps(
  root: MacroSourceItem,
  allMacros: MacroSourceItem[],
  profile: MachineProfile,
): SimulationBuildResult {
  const macroLookup = buildMacroLookup(allMacros);
  const warnings: string[] = [];
  const steps: SimulationStep[] = [];
  const stack: string[] = [];
  const plannerState: PlannerState = { homedAxes: new Set<'X' | 'Y' | 'Z'>() };

  // Build a reverse map: rename_existing value → original command name.
  // e.g. if [gcode_macro BED_MESH_CALIBRATE] has rename_existing: _BED_MESH_CALIBRATE,
  // then "_BED_MESH_CALIBRATE" → "BED_MESH_CALIBRATE" (the built-in).
  const renameMap = new Map<string, string>();
  for (const item of allMacros) {
    if (item.renameExisting.trim()) {
      renameMap.set(item.renameExisting.trim().toUpperCase(), item.title.toUpperCase());
    }
  }

  const appendHomingOverrideSteps = (parsed: ParsedGcodeCommand, appendParsedCommand: (command: ParsedGcodeCommand, currentMacro: MacroSourceItem | null, allowHomingOverride: boolean) => void) => {
    if (parsed.command !== 'G28' || !profile.homingOverride?.gcode.trim()) return false;

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
      steps.push({
        kind: 'command',
        command: {
          command: 'G92',
          raw: `G92 ${Object.entries(preHomeParams).map(([axis, value]) => `${axis}${value}`).join(' ')}`,
          params: preHomeParams,
          lineNumber: parsed.lineNumber,
          sourceName: 'homing_override',
        },
      });
    }

    profile.homingOverride.gcode.split(/\r?\n/).forEach((line, index) => {
      const overrideCommand = parseGcodeLine(line, index + 1, 'homing_override');
      if (!overrideCommand) return;
      appendParsedCommand(overrideCommand, null, false);
    });

    return true;
  };

  const appendParsedCommand = (
    parsed: ParsedGcodeCommand,
    currentMacro: MacroSourceItem | null,
    allowHomingOverride = true,
  ) => {
    if (allowHomingOverride && appendHomingOverrideSteps(parsed, appendParsedCommand)) {
      return;
    }

    const nested = macroLookup.get(parsed.command);
    if (nested && (!currentMacro || nested.key !== currentMacro.key)) {
      visit(nested, allowHomingOverride);
      return;
    }

    const originalCommand = renameMap.get(parsed.command);
    if (originalCommand) {
      const rawRest = parsed.raw.slice(parsed.command.length);
      const rewritten: ParsedGcodeCommand = { ...parsed, command: originalCommand, raw: `${originalCommand}${rawRest}` };
      steps.push(...expandCommandToSteps(rewritten, profile));
      applyPlannerCommandEffects(rewritten, plannerState);
      return;
    }

    steps.push(...expandCommandToSteps(parsed, profile));
    applyPlannerCommandEffects(parsed, plannerState);
  };

  const visit = (macro: MacroSourceItem, allowHomingOverride = true) => {
    const title = macro.title.toUpperCase();
    if (stack.includes(title)) {
      warnings.push(`Macro loop detected: ${[...stack, title].join(' -> ')}`);
      return;
    }
    stack.push(title);
    const lines = macro.gcode.split(/\r?\n/);
    const conditionalStack: Array<{ parentActive: boolean; branchTaken: boolean; active: boolean }> = [];
    const isBranchActive = () => conditionalStack.every((entry) => entry.active);

    lines.forEach((line, index) => {
      const templateControl = parseTemplateControlDirective(line, plannerState.homedAxes);
      if (templateControl) {
        switch (templateControl.kind) {
          case 'if': {
            const parentActive = isBranchActive();
            // Treat unknown (null) conditions as true so that template-guarded blocks
            // (e.g. homing_override sections using `params`) are included in the simulation.
            const conditionMatched = templateControl.result !== false;
            conditionalStack.push({
              parentActive,
              branchTaken: conditionMatched,
              active: parentActive && conditionMatched,
            });
            return;
          }
          case 'elif': {
            const current = conditionalStack[conditionalStack.length - 1];
            if (!current) return;
            // Treat unknown (null) conditions as true for the same reason as 'if'.
            const conditionMatched = templateControl.result !== false;
            current.active = current.parentActive && !current.branchTaken && conditionMatched;
            current.branchTaken = current.branchTaken || conditionMatched;
            return;
          }
          case 'else': {
            const current = conditionalStack[conditionalStack.length - 1];
            if (!current) return;
            current.active = current.parentActive && !current.branchTaken;
            current.branchTaken = true;
            return;
          }
          case 'endif':
            conditionalStack.pop();
            return;
        }
      }

      if (!isBranchActive()) {
        return;
      }

      const parsed = parseGcodeLine(line, index + 1, macro.title);
      if (!parsed) return;
      appendParsedCommand(parsed, macro, allowHomingOverride);
    });
    stack.pop();
  };

  visit(root);
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

export function executeSimulationStep(
  state: MacroRuntimeState,
  step: SimulationStep,
  profile: MachineProfile,
): SimulationTickResult {
  if (step.kind === 'move') {
    const warnings: string[] = [];
    if (!isPointInMoveBounds(profile, step.x, step.y)) {
      warnings.push(`${step.label} goes outside the moveable area.`);
    }
    const zone = findPathZoneHit(profile, state.x, state.y, step.x, step.y);
    if (zone) warnings.push(`${step.label} path crosses no-go zone \"${zone.name}\".`);
    const distance = Math.sqrt((step.x - state.x) ** 2 + (step.y - state.y) ** 2);
    const moveTime = estimateMoveTime(distance, state.feedRate, profile.maxVelocity, profile.maxAccel);
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
      return applyLinearMove(state, command.params, profile);
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
        nextState = {
          ...nextState,
          ...saved,
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
    case 'RESET_ACCEL':
    case 'SET_GCODE_VARIABLE':
    case 'SAVE_VARIABLE':
    case 'UPDATE_DELAYED_GCODE':
    case 'ACTIVATE_EXTRUDER':
    case 'TEMPERATURE_WAIT':
    case 'QUERY_PROBE':
    case 'QUERY_ENDSTOPS':
    case 'PAUSE':
    case 'RESUME':
    case 'CANCEL_PRINT':
    case 'M220':
    case 'M221':
    case 'BED_MESH_PROFILE':
    case 'SET_VELOCITY_LIMIT':
    case 'SET_IDLE_TIMEOUT':
    case 'EXCLUDE_OBJECT_DEFINE':
    case 'EXCLUDE_OBJECT':
    case 'SET_PRESSURE_ADVANCE':
    case 'SET_INPUT_SHAPER':
    case 'SET_RETRACTION':
    case 'SET_HEATER_TEMPERATURE':
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
      nextState = { ...nextState, homedAxes: [] };
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
    case 'BED_MESH_CLEAR':
    case 'BED_MESH_OUTPUT':
    case 'BED_MESH_MAP':
    case 'ACCEPT':
    case 'ABORT':
    case 'TESTZ':
    case 'GET_POSITION':
    case 'PID_CALIBRATE':
      eventSummary = command.command;
      break;
    case 'BED_MESH_CALIBRATE':
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
      warnings.push(`Unsupported command ${command.command} was displayed but not fully simulated.`);
      break;
  }

  return {
    nextState,
    warnings,
    eventSummary,
  };
}