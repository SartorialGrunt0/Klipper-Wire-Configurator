import { describe, expect, it } from 'vitest';
import {
  buildSimulationSteps,
  createInitialRuntimeState,
  executeSimulationStep,
} from '@/utils/gcodeSimulator';
import type { MachineProfile, MacroSourceItem, SimulationStep } from '@/types/macroDesigner';

/**
 * Scenario-level integration tests for the Macro Designer simulator.
 *
 * Unit tests cover individual functions; these cover realistic
 * multi-macro flows end-to-end through the same pipeline the dialog
 * uses (buildSimulationSteps → executeSimulationStep), with a
 * Trident-like profile (300x300 corexy, probe, bed mesh).
 */

function makeProfile(overrides: Partial<MachineProfile> = {}): MachineProfile {
  return {
    shape: 'rect',
    kinematics: 'corexy',
    minX: 0, maxX: 300, minY: 0, maxY: 300, minZ: 0, maxZ: 250,
    moveMinX: -5, moveMaxX: 305, moveMinY: -5, moveMaxY: 305,
    centerX: 150, centerY: 150, radius: null,
    homeX: 0, homeY: 0, homeZ: 0,
    hasProbe: true, probeOffsetX: 0, probeOffsetY: 0,
    probeSamples: 3, probeSpeed: 5, probeLiftSpeed: 10, probeSampleRetractDist: 2,
    horizontalMoveZ: 5, nozzleMaxTemp: 260, bedMaxTemp: 120,
    maxExtrudeCrossSection: 1.0, maxVelocity: 500, maxAccel: 3000,
    noGoZones: [], dockPosition: null, homingOverride: null, featurePoints: {},
    ...overrides,
  };
}

function makeMacro(gcode: string, title: string, key: string): MacroSourceItem {
  return {
    key, source: 'draft', title, renameExisting: '', description: '', variables: '', gcode,
  };
}

function runSimulation(
  root: MacroSourceItem,
  allMacros: MacroSourceItem[],
  profile: MachineProfile,
  params: Record<string, string> = {},
  rawparams = '',
) {
  const plan = buildSimulationSteps(root, allMacros, profile, undefined, { params, rawparams });
  let state = createInitialRuntimeState(profile, root.title);
  const trace: string[] = [];
  const stepWarnings: string[] = [];
  for (const step of plan.steps) {
    const result = executeSimulationStep(state, step, profile);
    state = result.nextState;
    trace.push(result.eventSummary);
    stepWarnings.push(...result.warnings);
  }
  return { plan, state, trace, stepWarnings };
}

function commandRaw(step: SimulationStep): string | null {
  return step.kind === 'command' ? step.command.raw : null;
}

function g1Commands(plan: { steps: SimulationStep[] }): string[] {
  return plan.steps
    .filter((step) => step.kind === 'command' && step.command.command === 'G1')
    .map((step) => (step as Extract<SimulationStep, { kind: 'command' }>).command.raw);
}

describe('macro designer scenarios', () => {
  it('PRINT_START with params: heat, home, prime, move to start', () => {
    const profile = makeProfile();
    const macros = [
      makeMacro(
        [
          '{% set bed_temp = params.BED|default(60) %}',
          '{% set nozzle_temp = params.TEMP|default(200) %}',
          'M140 S{bed_temp}',
          'M104 S{nozzle_temp}',
          'G28',
          'G1 X150 Y150 Z5 F3000',
          'G92 E0',
          'G1 E5 F600',
          'G1 Z0.3 F300',
        ].join('\n'),
        'PRINT_START',
        'print_start',
      ),
    ];

    const { plan, state, trace } = runSimulation(
      macros[0], macros, profile, { BED: '70', TEMP: '210' }, 'BED=70 TEMP=210',
    );

    expect(plan.warnings).toEqual([]);
    expect(trace).toContain('Set bed target 70C');
    expect(trace).toContain('Set nozzle target 210C');
    expect(trace).toContain('Home axes');
    // Final toolhead: primed then dropped to Z0.3.
    expect(state.x).toBe(150);
    expect(state.y).toBe(150);
    expect(state.z).toBeCloseTo(0.3, 5);
    expect(state.e).toBeGreaterThan(0);
  });

  it('PRINT_START without params falls back to defaults (no crash)', () => {
    const profile = makeProfile();
    const macros = [
      makeMacro(
        'M140 S{params.BED|default(60)}\nM104 S{params.TEMP|default(200)}\nG28',
        'PRINT_START',
        'print_start',
      ),
    ];

    const { plan, trace } = runSimulation(macros[0], macros, profile);

    expect(plan.warnings).toEqual([]);
    expect(trace).toContain('Set bed target 60C');
    expect(trace).toContain('Set nozzle target 200C');
  });

  it('nested macro call with params on the call line', () => {
    const profile = makeProfile();
    const macros = [
      makeMacro('_HEAT TEMP=95\nG28', 'PRINT_START', 'print_start'),
      makeMacro('M104 S{params.TEMP}', '_HEAT', 'heat'),
    ];

    const { plan, trace } = runSimulation(macros[0], macros, profile);

    expect(plan.warnings).toEqual([]);
    expect(trace).toContain('Set nozzle target 95C');
    expect(plan.steps.some((step) => commandRaw(step)?.includes('S95'))).toBe(true);
  });

  it('loop over resolved range produces repeated steps', () => {
    const profile = makeProfile();
    const macros = [
      makeMacro(
        '{% for i in range(3) %}\nG1 X{10 + i * 50} Y50 F1200\n{% endfor %}',
        'SWEEP',
        'sweep',
      ),
    ];

    const { plan, state } = runSimulation(macros[0], macros, profile);

    expect(plan.warnings).toEqual([]);
    // 3 G1 commands: X10, X60, X110 (G1 expands as command steps).
    expect(g1Commands(plan)).toHaveLength(3);
    expect(g1Commands(plan)[2]).toContain('X110');
    expect(state.x).toBeCloseTo(110, 5);
  });

  it('unresolved range bound degrades to warnings, not a crash', () => {
    const profile = makeProfile();
    const macros = [
      makeMacro(
        '{% for i in range(params.COUNT) %}\nG1 X{10 + i * 50} Y50\n{% endfor %}',
        'SWEEP',
        'sweep',
      ),
    ];

    const { plan } = runSimulation(macros[0], macros, profile);

    // No crash; the loop body is skipped because the bound is unresolved.
    expect(plan.steps).toHaveLength(0);
  });

  it('no-go zone move produces a warning but still executes', () => {
    const profile = makeProfile({
      noGoZones: [{ id: 'z1', name: 'Blocked', x: 80, y: 30, width: 40, height: 40 }],
    });
    const macros = [
      makeMacro('G28\nG1 X100 Y50 F1200', 'MOVE', 'move'),
    ];

    const { plan, state, trace, stepWarnings } = runSimulation(macros[0], macros, profile);

    // Zone warnings are per-execution-step (applyLinearMove), not
    // planning-time warnings.
    expect(stepWarnings.length).toBeGreaterThan(0);
    expect(stepWarnings.some((w) => w.toLowerCase().includes('no-go'))).toBe(true);
    expect(state.x).toBeCloseTo(100, 5);
    expect(trace).toContain('Home axes');
  });

  it('probe point is recorded on a probe move', () => {
    const profile = makeProfile();
    const macros = [
      makeMacro('PROBE\nPROBE\nPROBE', 'MESH', 'mesh'),
    ];

    const { plan, state } = runSimulation(macros[0], macros, profile);

    // 3 PROBE commands × 3 samples each = 9 probe sample steps.
    expect(plan.steps.filter((step) => step.kind === 'probe')).toHaveLength(9);
    expect(state.activeProbePoint).not.toBeNull();
  });
});
