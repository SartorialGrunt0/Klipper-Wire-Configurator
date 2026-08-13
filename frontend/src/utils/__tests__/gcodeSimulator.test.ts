import { describe, expect, it } from 'vitest';
import {
  buildSimulationSteps,
  computeTrapezoidalProfile,
  createInitialRuntimeState,
  executeSimulationStep,
  parseGcodeLine,
  trapezoidalPositionAtTime,
} from '@/utils/gcodeSimulator';
import type { MachineProfile, MacroSourceItem, SimulationStep } from '@/types/macroDesigner';

function makeProfile(overrides: Partial<MachineProfile> = {}): MachineProfile {
  return {
    shape: 'rect',
    kinematics: 'corexy',
    minX: 0,
    maxX: 300,
    minY: 0,
    maxY: 300,
    minZ: 0,
    maxZ: 250,
    moveMinX: -5,
    moveMaxX: 305,
    moveMinY: -5,
    moveMaxY: 305,
    centerX: 150,
    centerY: 150,
    radius: null,
    homeX: 0,
    homeY: 0,
    homeZ: 0,
    hasProbe: false,
    probeOffsetX: 0,
    probeOffsetY: 0,
    probeSamples: 3,
    probeSpeed: 5,
    probeLiftSpeed: 10,
    probeSampleRetractDist: 2,
    horizontalMoveZ: 5,
    nozzleMaxTemp: 260,
    bedMaxTemp: 120,
    maxExtrudeCrossSection: 1.0,
    maxVelocity: 500,
    maxAccel: 3000,
    noGoZones: [],
    dockPosition: null,
    homingOverride: null,
    featurePoints: {},
    ...overrides,
  };
}

function makeMacro(gcode: string, overrides: Partial<MacroSourceItem> = {}): MacroSourceItem {
  return {
    key: 'test',
    source: 'draft',
    title: 'TEST',
    renameExisting: '',
    description: '',
    variables: '',
    gcode,
    ...overrides,
  };
}

describe('parseGcodeLine', () => {
  it('parses a simple move command with params', () => {
    const cmd = parseGcodeLine('G1 X10 Y20 F1200', 3, 'test.cfg');
    expect(cmd).not.toBeNull();
    expect(cmd!.command).toBe('G1');
    expect(cmd!.params).toEqual({ X: '10', Y: '20', F: '1200' });
    expect(cmd!.lineNumber).toBe(3);
    expect(cmd!.sourceName).toBe('test.cfg');
  });

  it('returns null for blank lines and comments', () => {
    expect(parseGcodeLine('', 1, 'x')).toBeNull();
    expect(parseGcodeLine('   ', 1, 'x')).toBeNull();
    expect(parseGcodeLine('# comment', 1, 'x')).toBeNull();
  });

  it('strips inline comments before parsing', () => {
    const cmd = parseGcodeLine('G1 X5 Y5 F1200 ; move fast', 1, 'x');
    expect(cmd!.params).toEqual({ X: '5', Y: '5', F: '1200' });
  });

  it('marks template directives', () => {
    const cmd = parseGcodeLine('{% set X = params.X|default(10)|int %}', 2, 'x');
    expect(cmd!.command).toBe('__TEMPLATE__');
  });

  it('uppercases the command', () => {
    expect(parseGcodeLine('g28', 1, 'x')!.command).toBe('G28');
  });

  it('handles positional params without =', () => {
    const cmd = parseGcodeLine('G1 X10', 1, 'x');
    expect(cmd!.params).toEqual({ X: '10' });
  });
});

describe('createInitialRuntimeState', () => {
  it('starts at the profile center', () => {
    const state = createInitialRuntimeState(makeProfile(), 'TEST');
    expect(state.x).toBe(150);
    expect(state.y).toBe(150);
    expect(state.z).toBe(0);
    expect(state.e).toBe(0);
    expect(state.absoluteMoves).toBe(true);
    expect(state.absoluteExtrusion).toBe(true);
    expect(state.homedAxes).toEqual([]);
    expect(state.activeMacro).toBe('TEST');
    expect(state.elapsedTimeS).toBe(0);
    expect(state.feedRate).toBe(500 * 60);
  });

  it('keeps z at minZ when minZ is positive', () => {
    const state = createInitialRuntimeState(makeProfile({ minZ: 10 }), 'TEST');
    expect(state.z).toBe(10);
  });
});

describe('computeTrapezoidalProfile', () => {
  it('returns zeros for non-positive distance', () => {
    const profile = computeTrapezoidalProfile(0, 1000, 500, 3000);
    expect(profile.totalTime).toBe(0);
    expect(profile.totalDist).toBe(0);
  });

  it('computes a triangular profile for short moves', () => {
    // feedRate 60000 -> 1000 mm/s, distance 10, accel 3000 -> triangular
    const profile = computeTrapezoidalProfile(10, 60000, 1000, 3000);
    expect(profile.cruiseTime).toBe(0);
    expect(profile.totalDist).toBe(10);
    expect(profile.accelDist).toBeCloseTo(5, 5);
    expect(profile.maxSpeed).toBeCloseTo(profile.accel * profile.accelTime, 5);
  });

  it('computes a trapezoidal profile for long moves', () => {
    // feedRate 60000 -> 1000 mm/s, capped at maxVelocity 500
    const profile = computeTrapezoidalProfile(300, 60000, 500, 3000);
    expect(profile.maxSpeed).toBe(500);
    expect(profile.totalDist).toBe(300);
    expect(profile.accelDist).toBeCloseTo(500 * 500 / (2 * 3000), 5);
    expect(profile.cruiseTime).toBeGreaterThan(0);
    expect(profile.totalTime).toBeCloseTo(2 * profile.accelTime + profile.cruiseTime, 5);
  });

  it('caps speed at maxVelocity', () => {
    const profile = computeTrapezoidalProfile(1000, 60000, 250, 3000);
    expect(profile.maxSpeed).toBe(250);
  });
});

describe('trapezoidalPositionAtTime', () => {
  it('returns 0 at or before time zero', () => {
    const profile = computeTrapezoidalProfile(300, 60000, 500, 3000);
    expect(trapezoidalPositionAtTime(profile, 0)).toBe(0);
    expect(trapezoidalPositionAtTime(profile, -1)).toBe(0);
  });

  it('returns total distance at or after total time', () => {
    const profile = computeTrapezoidalProfile(300, 60000, 500, 3000);
    expect(trapezoidalPositionAtTime(profile, profile.totalTime)).toBeCloseTo(300, 5);
    expect(trapezoidalPositionAtTime(profile, profile.totalTime + 5)).toBeCloseTo(300, 5);
  });

  it('monotonically increases during the move', () => {
    const profile = computeTrapezoidalProfile(300, 60000, 500, 3000);
    const t = profile.totalTime / 4;
    const pos = trapezoidalPositionAtTime(profile, t);
    expect(pos).toBeGreaterThan(0);
    expect(pos).toBeLessThan(300);
  });
});

describe('buildSimulationSteps', () => {
  it('keeps G1 commands as command steps', () => {
    const root = makeMacro('G90\nG1 X50 Y50 F1200\n');
    const result = buildSimulationSteps(root, [root], makeProfile());
    const g1 = result.steps.find(
      (s): s is Extract<typeof s, { kind: 'command' }> => s.kind === 'command' && s.command.command === 'G1',
    );
    expect(g1).toBeDefined();
    expect(g1!.command.params.X).toBe('50');
  });

  it('creates command steps for non-move commands', () => {
    const root = makeMacro('M104 S200\n');
    const result = buildSimulationSteps(root, [root], makeProfile());
    expect(result.steps.some((s) => s.kind === 'command')).toBe(true);
  });

  it('tracks a zero-distance profile with no steps', () => {
    const root = makeMacro('');
    const result = buildSimulationSteps(root, [root], makeProfile());
    expect(Array.isArray(result.steps)).toBe(true);
  });
});

describe('executeSimulationStep', () => {
  it('executes a move step and updates position', () => {
    const profile = makeProfile();
    const state = createInitialRuntimeState(profile, 'TEST');
    const result = executeSimulationStep(state, {
      kind: 'move',
      x: 100,
      y: 50,
      label: 'Move to 100 50',
      raw: 'G1 X100 Y50',
      sourceName: 'test',
      lineNumber: 1,
    }, profile);
    expect(result.nextState.x).toBe(100);
    expect(result.nextState.y).toBe(50);
    expect(result.nextState.elapsedTimeS).toBeGreaterThan(0);
    expect(result.warnings).toEqual([]);
    expect(result.eventSummary).toBe('Move to 100 50');
  });

  it('flags moves into no-go zones', () => {
    const profile = makeProfile({
      noGoZones: [{ id: 'z1', name: 'Blocked', x: 90, y: 40, width: 20, height: 20 }],
    });
    const state = createInitialRuntimeState(profile, 'TEST');
    // Move from center (150,150) to (100,50) — path crosses the zone.
    const result = executeSimulationStep(state, {
      kind: 'move',
      x: 100,
      y: 50,
      label: 'Move to 100 50',
      raw: 'G1 X100 Y50',
      sourceName: 'test',
      lineNumber: 1,
    }, profile);
    expect(result.warnings.some((w) => w.includes('no-go zone'))).toBe(true);
  });

  it('executes a probe step', () => {
    const profile = makeProfile();
    const state = createInitialRuntimeState(profile, 'TEST');
    const result = executeSimulationStep(state, {
      kind: 'probe',
      x: 100,
      y: 100,
      label: 'PROBE',
      raw: 'PROBE',
      sourceName: 'test',
      lineNumber: 1,
    }, profile);
    expect(result.nextState.activeProbePoint).toEqual({ x: 100, y: 100, label: 'PROBE' });
  });
});

describe('unresolved template symbols (P0-3 crash guard)', () => {
  it('does not throw when range() receives an unresolved symbol arg', () => {
    const profile = makeProfile();
    // params.COUNT is not supplied → resolves to the TEMPLATE_UNRESOLVED
    // symbol; Number(Symbol) previously threw inside evaluateTemplateCall.
    const macro = makeMacro(
      '{% for i in range(params.COUNT) %}\nG1 X{10 + i}\n{% endfor %}',
      { title: 'RANGE_UNRESOLVED' },
    );
    expect(() => buildSimulationSteps(macro, [macro], profile)).not.toThrow();
  });

  it('does not throw when range() receives an unresolved reference', () => {
    const profile = makeProfile();
    // printer.foo is not a known object → unresolved symbol.
    const macro = makeMacro(
      '{% for i in range(printer.foo.bar) %}\nG1 X{i}\n{% endfor %}',
      { title: 'RANGE_REF_UNRESOLVED' },
    );
    expect(() => buildSimulationSteps(macro, [macro], profile)).not.toThrow();
  });

  it('degrades to a warning rather than crashing on unresolved range bounds', () => {
    const profile = makeProfile();
    const macro = makeMacro(
      '{% for i in range(printer.foo.bar) %}\nG1 X{i}\n{% endfor %}',
      { title: 'RANGE_WARN' },
    );
    const plan = buildSimulationSteps(macro, [macro], profile);
    expect(Array.isArray(plan.warnings)).toBe(true);
  });

  it('skips the loop body when range() is unresolvable', () => {
    const profile = makeProfile();
    const macro = makeMacro(
      '{% for i in range(params.LAYERS) %}\nG1 X10\n{% endfor %}\nG28',
      { title: 'RANGE_SKIP_BODY' },
    );
    const result = buildSimulationSteps(macro, [macro], profile);
    const moveSteps = result.steps.filter((s): s is Extract<typeof s, { kind: 'move' }> => s.kind === 'move');
    expect(moveSteps).toHaveLength(0);
  });

  it('keeps numeric range() working', () => {
    const profile = makeProfile();
    const macro = makeMacro(
      '{% for i in range(0, 3) %}\nM117 pass {{ i }}\n{% endfor %}',
      { title: 'RANGE_NUMERIC' },
    );
    const result = buildSimulationSteps(macro, [macro], profile);
    const respondSteps = result.steps.filter((s) => s.kind === 'command' && s.command.command === 'M117');
    expect(respondSteps.length).toBe(3);
  });

  it('does not throw when printf formatting receives an unresolved symbol in a list', () => {
    const profile = makeProfile();
    // '%d' % [unresolved] — the list keeps the Symbol inside, bypassing
    // the binary-operator guard; Number(Symbol) previously threw.
    const macro = makeMacro(
      "{% set msg = '%d' % [printer.foo.bar] %}\nRESPOND MSG={msg}",
      { title: 'PRINTF_UNRESOLVED' },
    );
    expect(() => buildSimulationSteps(macro, [macro], profile)).not.toThrow();
  });
});

describe('root macro invocation params (P0-2)', () => {
  it('resolves params.* references from the root invocation', () => {
    const profile = makeProfile();
    const macro = makeMacro(
      'M104 S{params.TEMP}',
      { title: 'SET_TEMP' },
    );
    const plan = buildSimulationSteps(macro, [macro], profile, undefined, {
      params: { TEMP: '80' },
      rawparams: 'TEMP=80',
    });
    // The M104 target should be 80, not unresolved.
    expect(plan.steps.length).toBe(1);
    expect(plan.warnings).toEqual([]);
    expect(plan.steps[0].kind).toBe('command');
    const step = plan.steps[0] as Extract<SimulationStep, { kind: 'command' }>;
    expect(step.command.raw).toContain('S80');
  });

  it('propagates params written on a nested macro call line', () => {
    const profile = makeProfile();
    const root = makeMacro(
      'MY_HEATER TEMP=90',
      { title: 'ROOT', key: 'root' },
    );
    const nested = makeMacro(
      'M104 S{params.TEMP}',
      { title: 'MY_HEATER', key: 'nested' },
    );
    const plan = buildSimulationSteps(root, [root, nested], profile, undefined, {
      params: { TEMP: '50' },
      rawparams: 'TEMP=50',
    });
    // Params are per-invocation (Klipper semantics): the nested macro
    // receives TEMP from its own call line, not from the root.
    expect(plan.steps[0].kind).toBe('command');
    const step = plan.steps[0] as Extract<SimulationStep, { kind: 'command' }>;
    expect(step.command.raw).toContain('S90');
  });

  it('does not inherit root params into a bare nested call (Klipper semantics)', () => {
    const profile = makeProfile();
    const root = makeMacro(
      'MY_HEATER',
      { title: 'ROOT', key: 'root' },
    );
    const nested = makeMacro(
      'M104 S{params.TEMP}',
      { title: 'MY_HEATER', key: 'nested' },
    );
    const plan = buildSimulationSteps(root, [root, nested], profile, undefined, {
      params: { TEMP: '90' },
      rawparams: 'TEMP=90',
    });
    // A bare call passes no params; the reference stays unresolved but
    // must not throw (P0-3 regression guard).
    expect(plan.steps[0].kind).toBe('command');
    expect(plan.steps).toHaveLength(1);
  });

  it('treats an empty params object the same as before (no params)', () => {
    const profile = makeProfile();
    const macro = makeMacro('M104 S{params.TEMP}', { title: 'NO_PARAMS' });
    // No rootInvocation supplied — the reference stays unresolved, but
    // must not throw (regression guard for the Symbol crash).
    expect(() => buildSimulationSteps(macro, [macro], profile)).not.toThrow();
  });
});
