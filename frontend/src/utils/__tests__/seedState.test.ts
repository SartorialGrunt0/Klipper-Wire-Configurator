import { describe, expect, it } from 'vitest';
import {
  buildSimulationSteps,
  createInitialRuntimeState,
  executeSimulationStep,
  executeStandaloneCommand,
} from '@/utils/gcodeSimulator';
import type { MachineProfile, MacroSourceItem } from '@/types/macroDesigner';

/**
 * Verifies the seeded-machine-state flow: user seeds commands (G28, M104)
 * through the execution output box, then runs a macro that assumes that
 * state — without needing its own homing/heating lines.
 */
function makeProfile(): MachineProfile {
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
  };
}

function makeMacro(gcode: string, title: string, key: string): MacroSourceItem {
  return { key, source: 'draft', title, renameExisting: '', description: '', variables: '', gcode };
}

describe('seeded machine state flow', () => {
  it('dead printer refuses G1 until the user seeds G28', () => {
    const profile = makeProfile();
    const macro = makeMacro('G1 X100 Y50 F3000', 'MOVE', 'move');

    // No seed: refused.
    const state0 = createInitialRuntimeState(profile, macro.title);
    const refused = executeStandaloneCommand('G1 X100 Y50 F3000', state0, profile);
    expect(refused.warnings.some((w) => w.toLowerCase().includes('homed'))).toBe(true);
    expect(refused.nextState.x).toBe(profile.centerX);

    // Seed G28 through the box, then the same command works.
    const seeded = executeStandaloneCommand('G28', state0, profile);
    expect(seeded.warnings).toEqual([]);
    const accepted = executeStandaloneCommand('G1 X100 Y50 F3000', seeded.nextState, profile);
    expect(accepted.warnings).toEqual([]);
    expect(accepted.nextState.x).toBeCloseTo(100, 5);
  });

  it('seeded state carries through buildSimulationSteps as the macro start', () => {
    const profile = makeProfile();
    const macro = makeMacro('G1 X80 Y90 F3000', 'SEEDED_MOVE', 'seeded_move');

    const seeded = executeStandaloneCommand('G28', createInitialRuntimeState(profile, macro.title), profile);
    const plan = buildSimulationSteps(macro, [macro], profile, undefined, { params: {}, rawparams: '' }, seeded.nextState);
    let state = seeded.nextState;
    const stepWarnings: string[] = [];
    for (const step of plan.steps) {
      const result = executeSimulationStep(state, step, profile);
      state = result.nextState;
      stepWarnings.push(...result.warnings);
    }
    expect(stepWarnings).toEqual([]);
    expect(state.x).toBeCloseTo(80, 5);
    expect(state.y).toBeCloseTo(90, 5);
  });

  it('seeded temp target is visible to later M104-less macros', () => {
    const profile = makeProfile();
    const macro = makeMacro('RESPOND MSG={printer.heater_bed.target}', 'READ_BED', 'read_bed');

    const seeded = executeStandaloneCommand('M140 S70', createInitialRuntimeState(profile, macro.title), profile);
    expect(seeded.warnings).toEqual([]);
    expect(seeded.nextState.bed.target).toBe(70);

    const plan = buildSimulationSteps(macro, [macro], profile, undefined, { params: {}, rawparams: '' }, seeded.nextState);
    let state = seeded.nextState;
    const trace: string[] = [];
    for (const step of plan.steps) {
      const result = executeSimulationStep(state, step, profile);
      state = result.nextState;
      trace.push(result.eventSummary);
    }
    expect(trace.some((entry) => entry.includes('70'))).toBe(true);
  });
});
