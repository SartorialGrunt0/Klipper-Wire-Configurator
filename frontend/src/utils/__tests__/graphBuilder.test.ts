import { describe, expect, it } from 'vitest';
import { buildGraphFromConfig, buildProjectGraph } from '@/utils/graphBuilder';
import type { ConfigFile, ConfigSection, ConfigParam, SectionSchema } from '@/types/config';

type Call = { method: string; args: unknown[] };

function makeMockStore() {
  const calls: Call[] = [];
  let idCounter = 0;
  const store = {
    calls,
    addHardwareNode: (...args: unknown[]) => {
      calls.push({ method: 'addHardwareNode', args });
      return `hw_${++idCounter}`;
    },
    addSubComponentNode: (...args: unknown[]) => {
      calls.push({ method: 'addSubComponentNode', args });
      return `sub_${++idCounter}`;
    },
    addFeatureNode: (...args: unknown[]) => {
      calls.push({ method: 'addFeatureNode', args });
      return `feat_${++idCounter}`;
    },
    addGroupNode: (...args: unknown[]) => {
      calls.push({ method: 'addGroupNode', args });
      return `group_${++idCounter}`;
    },
    addCommunicationEdge: (...args: unknown[]) => {
      calls.push({ method: 'addCommunicationEdge', args });
      return `edge_${++idCounter}`;
    },
    addConfigurationEdge: (...args: unknown[]) => {
      calls.push({ method: 'addConfigurationEdge', args });
      return `edge_${++idCounter}`;
    },
    updateNodeData: (...args: unknown[]) => {
      calls.push({ method: 'updateNodeData', args });
    },
    toggleHardwareCollapse: (...args: unknown[]) => {
      calls.push({ method: 'toggleHardwareCollapse', args });
    },
    autoArrange: () => {
      calls.push({ method: 'autoArrange', args: [] });
    },
  };
  return store;
}

function param(key: string, value: string, extra: Partial<ConfigParam> = {}): ConfigParam {
  return { key, value, is_commented_out: false, comment: '', separator: ':', ...extra };
}

function section(overrides: Partial<ConfigSection>): ConfigSection {
  return {
    section_type: 'mcu',
    section_name: '',
    full_header: 'mcu',
    line_number: 1,
    params: [],
    header_comments: [],
    trailing_comments: [],
    is_commented_out: false,
    ...overrides,
  };
}

function config(sections: ConfigSection[], overrides: Partial<ConfigFile> = {}): ConfigFile {
  return {
    filename: 'printer.cfg',
    sections,
    includes: [],
    header_comments: [],
    raw_text: '',
    ...overrides,
  };
}

function schema(type: string): SectionSchema {
  return {
    section_type: type,
    display_name: type === 'mcu' ? 'MCU' : type === 'extruder' ? 'Extruder' : 'Bed Mesh',
    category: 'sub_component',
    component_group: type,
    is_named: false,
    description: '',
    max_instances: 1,
    requires: [],
    params: [],
  };
}

const SCHEMAS: Record<string, SectionSchema> = {
  mcu: schema('mcu'),
  extruder: schema('extruder'),
  bed_mesh: schema('bed_mesh'),
};

describe('buildProjectGraph', () => {
  it('is a no-op for empty configs', () => {
    const store = makeMockStore();
    buildProjectGraph({}, store, SCHEMAS);
    expect(store.calls).toHaveLength(0);
  });

  it('creates an SBC node plus a primary mainboard', () => {
    const store = makeMockStore();
    buildProjectGraph(
      { 'printer.cfg': config([section({})]) },
      store,
      SCHEMAS,
    );

    const hwCalls = store.calls.filter((c) => c.method === 'addHardwareNode');
    expect(hwCalls).toHaveLength(2);
    // One SBC (virtual host_mcu) + one unnamed mainboard.
    const types = hwCalls.map((c) => c.args[0]);
    expect(types).toContain('sbc');
    expect(types).toContain('mainboard');
  });

  it('classifies a named EBB MCU as a toolhead', () => {
    const store = makeMockStore();
    buildProjectGraph(
      {
        'printer.cfg': config([
          section({ section_name: 'EBBCan', full_header: 'mcu EBBCan', params: [param('canbus_uuid', 'abc')] }),
        ]),
      },
      store,
      SCHEMAS,
    );
    const hwCalls = store.calls.filter((c) => c.method === 'addHardwareNode');
    const toolhead = hwCalls.find((c) => c.args[0] === 'toolhead');
    expect(toolhead).toBeDefined();
    expect(toolhead!.args[1]).toBe('EBBCan');
  });

  it('detects canbus communication from canbus_uuid', () => {
    const store = makeMockStore();
    buildProjectGraph(
      {
        'printer.cfg': config([
          section({ section_name: 'EBBCan', full_header: 'mcu EBBCan', params: [param('canbus_uuid', 'abc')] }),
        ]),
      },
      store,
      SCHEMAS,
    );
    const commEdges = store.calls.filter((c) => c.method === 'addCommunicationEdge');
    expect(commEdges.length).toBeGreaterThan(0);
    expect(commEdges[0].args[2]).toBe('canbus');
  });

  it('creates sub-component nodes for non-MCU sections', () => {
    const store = makeMockStore();
    buildProjectGraph(
      {
        'printer.cfg': config([
          section({}),
          section({ section_type: 'extruder', full_header: 'extruder', params: [param('heater_pin', 'PA0')] }),
        ]),
      },
      store,
      SCHEMAS,
    );
    const subCalls = store.calls.filter((c) => c.method === 'addSubComponentNode');
    const extruder = subCalls.find((c) => c.args[1] === 'extruder');
    expect(extruder).toBeDefined();
  });

  it('creates feature nodes for feature sections', () => {
    const store = makeMockStore();
    buildProjectGraph(
      {
        'printer.cfg': config([
          section({}),
          section({ section_type: 'bed_mesh', full_header: 'bed_mesh' }),
        ]),
      },
      store,
      SCHEMAS,
    );
    const featCalls = store.calls.filter((c) => c.method === 'addFeatureNode');
    expect(featCalls.some((c) => c.args[1] === 'bed_mesh')).toBe(true);
  });

  it('skips include sections when building cards', () => {
    const store = makeMockStore();
    buildProjectGraph(
      {
        'printer.cfg': config([
          section({}),
          section({
            section_type: 'include',
            section_name: 'other.cfg',
            full_header: 'include other.cfg',
          }),
        ]),
      },
      store,
      SCHEMAS,
    );
    const subCalls = store.calls.filter((c) => c.method === 'addSubComponentNode');
    expect(subCalls.some((c) => c.args[1] === 'include')).toBe(false);
  });

  it('marks sections with validation errors', () => {
    const store = makeMockStore();
    buildProjectGraph(
      {
        'printer.cfg': config([
          section({}),
          section({ section_type: 'extruder', full_header: 'extruder' }),
        ]),
      },
      store,
      SCHEMAS,
      {
        'printer.cfg': {
          has_errors: true,
          has_warnings: false,
          errors: [{ severity: 'error', section: 'extruder', param: '', message: 'x', line_number: 2 }],
        },
      },
    );
    const errUpdates = store.calls.filter(
      (c) => c.method === 'updateNodeData' && (c.args[1] as Record<string, unknown>).hasErrors === true,
    );
    expect(errUpdates.length).toBeGreaterThan(0);
  });

  it('filters files with no recognized sections', () => {
    const store = makeMockStore();
    buildProjectGraph(
      {
        'printer.cfg': config([section({})]),
        'moonraker.conf': config(
          [section({ section_type: 'moonraker', full_header: 'moonraker' })],
          { filename: 'moonraker.conf' },
        ),
      },
      store,
      SCHEMAS,
    );
    // Only printer.cfg's MCU should produce hardware nodes; the unrecognized
    // file should not create extra mainboards.
    const hwCalls = store.calls.filter((c) => c.method === 'addHardwareNode');
    expect(hwCalls.length).toBeLessThanOrEqual(3); // sbc + mainboard (+ nothing for moonraker)
  });

  it('collapses hardware nodes and auto-arranges at the end', () => {
    const store = makeMockStore();
    buildProjectGraph({ 'printer.cfg': config([section({})]) }, store, SCHEMAS);
    const collapseCalls = store.calls.filter((c) => c.method === 'toggleHardwareCollapse');
    expect(collapseCalls.length).toBeGreaterThan(0);
    expect(store.calls[store.calls.length - 1].method).toBe('autoArrange');
  });
});

describe('buildGraphFromConfig', () => {
  it('delegates to buildProjectGraph with a single-file map', () => {
    const store = makeMockStore();
    buildGraphFromConfig(config([section({})]), store, SCHEMAS);
    expect(store.calls.some((c) => c.method === 'addHardwareNode')).toBe(true);
    expect(store.calls.some((c) => c.method === 'autoArrange')).toBe(true);
  });
});
