/**
 * Macro Designer probe — run the frontend gcode simulator on a macro
 * from the command line, without opening the UI.
 *
 * Usage (from frontend/):
 *   MACRO_GCODE='{% set t = params.TEMP|default(60) %}' npx vitest run src/utils/__tests__/macroProbe.test.ts
 *   MACRO_TITLE=PRINT_START MACRO_GCODE='M104 S{params.TEMP}' MACRO_PARAMS='TEMP=80' npx vitest run src/utils/__tests__/macroProbe.test.ts
 *
 * Prints the plan as JSON to stdout: steps (moves/probes/commands),
 * warnings, and the final simulated toolhead state. This is the same
 * engine the Macro Designer dialog uses (buildSimulationSteps), so a
 * repro here is a repro in the UI. Pass the macro as a single string;
 * use \n for newlines. MACRO_PARAMS accepts Klipper-style space
 * separated KEY=VALUE pairs applied to the root macro invocation.
 */
import { describe, it } from 'vitest';
import {
  buildSimulationSteps,
  createInitialRuntimeState,
  executeSimulationStep,
  parseParams,
} from '@/utils/gcodeSimulator';
import type { MachineProfile } from '@/types/macroDesigner';

const gcode = process.env.MACRO_GCODE || '';
const title = process.env.MACRO_TITLE || 'PROBE';
const rootParams = parseParams((process.env.MACRO_PARAMS || '').trim().split(/\s+/));

function makeProfile(): MachineProfile {
  return {
    shape: 'rect',
    kinematics: 'corexy',
    minX: 0, maxX: 300, minY: 0, maxY: 300, minZ: 0, maxZ: 250,
    moveMinX: -5, moveMaxX: 305, moveMinY: -5, moveMaxY: 305,
    centerX: 150, centerY: 150, radius: null,
    homeX: 0, homeY: 0, homeZ: 0,
    hasProbe: false, probeOffsetX: 0, probeOffsetY: 0,
    probeSamples: 3, probeSpeed: 5, probeLiftSpeed: 10, probeSampleRetractDist: 2,
    horizontalMoveZ: 5, nozzleMaxTemp: 260, bedMaxTemp: 120,
    maxExtrudeCrossSection: 1.0, maxVelocity: 500, maxAccel: 3000,
    noGoZones: [], dockPosition: null, homingOverride: null, featurePoints: {},
  };
}

describe('macro designer probe', () => {
  it('simulates the provided macro and prints the plan', () => {
    if (!gcode) {
      console.log('No MACRO_GCODE env var set — skipping probe. Usage: MACRO_GCODE="G28\\nG1 X100" npx vitest run src/utils/__tests__/macroProbe.test.ts');
      return;
    }
    const profile = makeProfile();
    const root = {
      key: 'probe',
      source: 'draft' as const,
      title,
      renameExisting: '',
      description: '',
      variables: '',
      gcode,
    };

    const plan = buildSimulationSteps(root, [root], profile, undefined, {
      params: rootParams,
      rawparams: (process.env.MACRO_PARAMS || '').trim(),
    });

    let state = createInitialRuntimeState(profile, title);
    const trace: Array<{ kind: string; summary: string; warnings: string[] }> = [];
    for (const step of plan.steps) {
      const result = executeSimulationStep(state, step, profile);
      state = result.nextState;
      trace.push({ kind: step.kind, summary: result.eventSummary, warnings: result.warnings });
    }

    const report = {
      macro: title,
      stepCount: plan.steps.length,
      warnings: plan.warnings,
      trace,
      finalState: {
        x: Math.round(state.x * 100) / 100,
        y: Math.round(state.y * 100) / 100,
        z: Math.round(state.z * 100) / 100,
        e: Math.round(state.e * 100) / 100,
        feedRate: state.feedRate,
        homedAxes: state.homedAxes,
        elapsedTimeS: Math.round(state.elapsedTimeS * 100) / 100,
      },
    };
    console.log(`\n===== MACRO SIM PROBE: ${title} =====`);
    console.log(JSON.stringify(report, null, 2));
  });
});
