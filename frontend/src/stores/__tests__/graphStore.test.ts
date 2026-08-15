import { beforeEach, describe, expect, it } from 'vitest';
import type { Connection } from '@xyflow/react';
import type { AppNode, AppEdge } from '@/types/graph';
import { useGraphStore } from '@/stores/graphStore';
import { useConfigStore } from '@/stores/configStore';

function makeHwNode(id: string, overrides: Record<string, unknown> = {}): AppNode {
  return {
    id,
    type: 'hardware',
    position: { x: 0, y: 0 },
    data: {
      label: id,
      hardwareType: 'mainboard',
      configFile: 'printer.cfg',
      mcuName: '',
      sections: [],
      hasErrors: false,
      ...overrides,
    },
  } as AppNode;
}

function makeChildNode(id: string, parentId: string, sectionHeader: string, configFile = 'printer.cfg'): AppNode {
  return {
    id,
    type: 'subComponent',
    position: { x: 0, y: 0 },
    parentId,
    data: {
      label: sectionHeader,
      sectionType: sectionHeader.split(' ')[0],
      sectionHeader,
      sectionLineNumber: 1,
      componentGroup: 'other',
      section: {
        section_type: sectionHeader.split(' ')[0], section_name: '', full_header: sectionHeader,
        line_number: 1, params: [], header_comments: [], trailing_comments: [], is_commented_out: false,
      },
      parentHardwareId: parentId,
      configFile,
      hasErrors: false,
    },
  } as AppNode;
}

function makeEdge(id: string, source: string, target: string): AppEdge {
  return {
    id,
    source,
    target,
    data: { edgeType: 'communication', commType: 'usb' },
    type: 'communication',
  } as AppEdge;
}

beforeEach(() => {
  useGraphStore.setState({
    nodes: [],
    edges: [],
    selectedNodeId: null,
    dragHoverHardwareId: null,
    selectedEdgeId: null,
    fitViewTrigger: 0,
  });
  useConfigStore.setState({
    configFiles: {},
    activeFile: 'printer.cfg',
    validation: {},
    schemas: {},
    selectedSection: null,
    originalTexts: {},
    isDirty: false,
    textParseErrors: {},
  });
});

describe('graphStore node operations', () => {
  it('addNode appends a node', () => {
    useGraphStore.getState().addNode(makeHwNode('n1'));
    const nodes = useGraphStore.getState().nodes;
    expect(nodes).toHaveLength(1);
    expect(nodes[0].id).toBe('n1');
  });

  it('updateNodeData merges data', () => {
    useGraphStore.getState().addNode(makeHwNode('n1', { mcuName: 'EBBCan' }));
    useGraphStore.getState().updateNodeData('n1', { hasErrors: true });
    const node = useGraphStore.getState().nodes[0];
    expect(node.data.mcuName).toBe('EBBCan');
    expect(node.data.hasErrors).toBe(true);
  });

  it('removeNode removes the node and its edges', () => {
    useGraphStore.getState().addNode(makeHwNode('n1'));
    useGraphStore.getState().addNode(makeHwNode('n2'));
    useGraphStore.getState().addEdge(makeEdge('e1', 'n1', 'n2'));
    useGraphStore.getState().removeNode('n1');
    const state = useGraphStore.getState();
    expect(state.nodes.map((n) => n.id)).toEqual(['n2']);
    expect(state.edges).toHaveLength(0);
  });

  it('removeNode removes child nodes too', () => {
    useGraphStore.getState().addNode(makeHwNode('hw1'));
    useGraphStore.getState().addNode({
      id: 'child1',
      type: 'subComponent',
      position: { x: 0, y: 0 },
      parentId: 'hw1',
      data: {
        label: 'stepper_x',
        sectionType: 'stepper_x',
        sectionHeader: 'stepper_x',
        componentGroup: 'stepper',
        section: {
          section_type: 'stepper_x', section_name: '', full_header: 'stepper_x',
          line_number: 1, params: [], header_comments: [], trailing_comments: [], is_commented_out: false,
        },
        parentHardwareId: 'hw1',
        configFile: 'printer.cfg',
        hasErrors: false,
      },
    } as AppNode);
    useGraphStore.getState().removeNode('hw1');
    expect(useGraphStore.getState().nodes).toHaveLength(0);
  });

  it('removeNode hardware preserves a config file shared with another board', () => {
    // Two boards reference the same multi-MCU file (e.g. printer.cfg with two [mcu] sections)
    useConfigStore.getState().setConfigFile('printer.cfg', {
      filename: 'printer.cfg',
      sections: [
        {
          section_type: 'mcu', section_name: 'mainboard', full_header: 'mcu mainboard',
          line_number: 1, params: [], header_comments: [], trailing_comments: [], is_commented_out: false,
        },
        {
          section_type: 'mcu', section_name: 'ebbtool', full_header: 'mcu ebbtool',
          line_number: 2, params: [], header_comments: [], trailing_comments: [], is_commented_out: false,
        },
      ],
      includes: [],
      header_comments: [],
      raw_text: '',
    });
    useGraphStore.getState().addNode(makeHwNode('hw1', { configFile: 'printer.cfg', mcuName: 'mainboard' }));
    useGraphStore.getState().addNode(makeHwNode('hw2', { configFile: 'printer.cfg', mcuName: 'ebbtool' }));

    // Delete only the first board
    useGraphStore.getState().removeNode('hw1');

    // The file must survive (hw2 still references it) with hw2's section intact
    const cf = useConfigStore.getState().configFiles['printer.cfg'];
    expect(cf).toBeDefined();
    expect(cf.sections.some((s) => s.full_header === 'mcu ebbtool')).toBe(true);
  });

  it('removeNode hardware deletes the file when no other board references it', () => {
    useConfigStore.getState().setConfigFile('solo.cfg', {
      filename: 'solo.cfg',
      sections: [{
        section_type: 'mcu', section_name: 'solo', full_header: 'mcu solo',
        line_number: 1, params: [], header_comments: [], trailing_comments: [], is_commented_out: false,
      }],
      includes: [],
      header_comments: [],
      raw_text: '',
    });
    useGraphStore.getState().addNode(makeHwNode('hw1', { configFile: 'solo.cfg', mcuName: 'solo' }));

    useGraphStore.getState().removeNode('hw1');

    expect(useConfigStore.getState().configFiles['solo.cfg']).toBeUndefined();
  });

  it('setSelectedNode updates selection', () => {
    useGraphStore.getState().addNode(makeHwNode('n1'));
    useGraphStore.getState().setSelectedNode('n1');
    expect(useGraphStore.getState().selectedNodeId).toBe('n1');
    useGraphStore.getState().setSelectedNode(null);
    expect(useGraphStore.getState().selectedNodeId).toBeNull();
  });

  it('duplicateNode adds a new node with offset position', () => {
    useGraphStore.getState().addNode(makeHwNode('n1'));
    useGraphStore.getState().duplicateNode('n1');
    const nodes = useGraphStore.getState().nodes;
    expect(nodes).toHaveLength(2);
    const dup = nodes.find((n) => n.id !== 'n1')!;
    expect(dup.position.x).toBe(40);
    expect(dup.position.y).toBe(40);
  });

  it('duplicateNode of unknown id is a no-op', () => {
    useGraphStore.getState().duplicateNode('missing');
    expect(useGraphStore.getState().nodes).toHaveLength(0);
  });

  it('duplicateNode hardware rewrites pin prefixes and drops printer/include sections', () => {
    // Source board: mcu mainboard + stepper_x with a prefixed pin + printer + include
    useConfigStore.getState().setConfigFile('mainboard.cfg', {
      filename: 'mainboard.cfg',
      sections: [
        {
          section_type: 'mcu', section_name: 'mainboard', full_header: 'mcu mainboard',
          line_number: 1, params: [{ key: 'serial', value: '/dev/ttyACM0', is_commented_out: false, comment: '', separator: ':' }],
          header_comments: [], trailing_comments: [], is_commented_out: false,
        },
        {
          section_type: 'stepper_x', section_name: '', full_header: 'stepper_x',
          line_number: 2, params: [{ key: 'step_pin', value: 'mainboard:PA0', is_commented_out: false, comment: '', separator: ':' }],
          header_comments: [], trailing_comments: [], is_commented_out: false,
        },
        {
          section_type: 'printer', section_name: '', full_header: 'printer',
          line_number: 3, params: [], header_comments: [], trailing_comments: [], is_commented_out: false,
        },
        {
          section_type: 'include', section_name: '', full_header: 'include macros.cfg',
          line_number: 4, params: [], header_comments: [], trailing_comments: [], is_commented_out: false,
        },
      ],
      includes: ['macros.cfg'],
      header_comments: [],
      raw_text: '',
    });
    useGraphStore.getState().addNode(makeHwNode('hw1', { mcuName: 'mainboard', configFile: 'mainboard.cfg' }));

    useGraphStore.getState().duplicateNode('hw1');

    const state = useGraphStore.getState();
    const dup = state.nodes.find((n) => n.id !== 'hw1')!;
    const dupData = dup.data as Record<string, unknown>;
    const newFile = dupData.configFile as string;
    const newMcu = dupData.mcuName as string;

    // New MCU name is unique and the clone's file exists
    expect(newMcu).toBe('mainboard_2');
    const newCf = useConfigStore.getState().configFiles[newFile];
    expect(newCf).toBeDefined();

    const mcuSec = newCf.sections.find((s) => s.section_type === 'mcu');
    expect(mcuSec?.full_header).toBe('mcu mainboard_2');

    // Pin prefix rewritten to the NEW mcu name — no stale mainboard: refs
    const stepper = newCf.sections.find((s) => s.full_header === 'stepper_x');
    expect(stepper?.params[0].value).toBe('mainboard_2:PA0');

    // [printer] must NOT be duplicated into the clone file
    expect(newCf.sections.some((s) => s.section_type === 'printer')).toBe(false);
    // [include] sections are deliberately dropped
    expect(newCf.sections.some((s) => s.section_type === 'include')).toBe(false);
  });
});

describe('graphStore edge operations', () => {
  it('addEdge and removeEdge', () => {
    useGraphStore.getState().addNode(makeHwNode('n1'));
    useGraphStore.getState().addNode(makeHwNode('n2'));
    useGraphStore.getState().addEdge(makeEdge('e1', 'n1', 'n2'));
    expect(useGraphStore.getState().edges).toHaveLength(1);

    useGraphStore.getState().removeEdge('e1');
    expect(useGraphStore.getState().edges).toHaveLength(0);
  });

  it('updateEdgeData merges data', () => {
    useGraphStore.getState().addNode(makeHwNode('n1'));
    useGraphStore.getState().addNode(makeHwNode('n2'));
    useGraphStore.getState().addEdge(makeEdge('e1', 'n1', 'n2'));
    useGraphStore.getState().updateEdgeData('e1', { commType: 'canbus' });
    const edge = useGraphStore.getState().edges[0];
    expect((edge.data as Record<string, unknown>).commType).toBe('canbus');
  });

  it('setSelectedEdge updates edge selection', () => {
    useGraphStore.getState().setSelectedEdge('e1');
    expect(useGraphStore.getState().selectedEdgeId).toBe('e1');
    useGraphStore.getState().setSelectedEdge(null);
    expect(useGraphStore.getState().selectedEdgeId).toBeNull();
  });
});

describe('graphStore bulk + clear', () => {
  it('setNodes and setEdges replace the graph', () => {
    useGraphStore.getState().setNodes([makeHwNode('a'), makeHwNode('b')]);
    useGraphStore.getState().setEdges([makeEdge('e1', 'a', 'b')]);
    expect(useGraphStore.getState().nodes).toHaveLength(2);
    expect(useGraphStore.getState().edges).toHaveLength(1);
  });

  it('clearGraph empties everything', () => {
    useGraphStore.getState().setNodes([makeHwNode('a')]);
    useGraphStore.getState().setEdges([makeEdge('e1', 'a', 'b')]);
    useGraphStore.getState().clearGraph();
    const state = useGraphStore.getState();
    expect(state.nodes).toHaveLength(0);
    expect(state.edges).toHaveLength(0);
    expect(state.selectedNodeId).toBeNull();
  });

  it('onNodesChange applies remove changes', () => {
    useGraphStore.getState().setNodes([makeHwNode('a'), makeHwNode('b')]);
    useGraphStore.getState().onNodesChange([{ type: 'remove', id: 'a' }]);
    expect(useGraphStore.getState().nodes.map((n) => n.id)).toEqual(['b']);
  });

  it('onNodesChange remove deletes the config section and pushes undo history', () => {
    // Set up a sub-component node backed by a config section
    useConfigStore.getState().setConfigFile('printer.cfg', {
      filename: 'printer.cfg',
      sections: [{
        section_type: 'stepper_x',
        section_name: '',
        full_header: 'stepper_x',
        line_number: 3,
        params: [],
        header_comments: [],
        trailing_comments: [],
        is_commented_out: false,
      }],
      includes: [],
      header_comments: [],
      raw_text: '',
    });
    useGraphStore.getState().addNode({
      id: 'sc1',
      type: 'subComponent',
      position: { x: 0, y: 0 },
      parentId: 'hw1',
      data: {
        label: 'stepper_x',
        sectionType: 'stepper_x',
        sectionHeader: 'stepper_x',
        sectionLineNumber: 3,
        componentGroup: 'stepper',
        section: {
          section_type: 'stepper_x', section_name: '', full_header: 'stepper_x',
          line_number: 3, params: [], header_comments: [], trailing_comments: [], is_commented_out: false,
        },
        parentHardwareId: 'hw1',
        configFile: 'printer.cfg',
        hasErrors: false,
      },
    } as AppNode);

    // Pressing Delete dispatches a remove change through onNodesChange
    useGraphStore.getState().onNodesChange([{ type: 'remove', id: 'sc1' }]);

    const state = useGraphStore.getState();
    expect(state.nodes).toHaveLength(0);
    // Config section must be gone too — no orphan resurrection on next sync
    expect(useConfigStore.getState().configFiles['printer.cfg'].sections).toHaveLength(0);
    expect(state.canUndo).toBe(true);

    // Undo restores both the node and the section
    state.undo();
    const restored = useGraphStore.getState();
    expect(restored.nodes).toHaveLength(1);
    expect(useConfigStore.getState().configFiles['printer.cfg'].sections).toHaveLength(1);
  });

  it('Delete-key cascade (edges then nodes) restores edges on a single undo', () => {
    // ReactFlow's deleteElements fires edge removes BEFORE node removes in the
    // same synchronous batch. Both must collapse into ONE history entry so a
    // single Ctrl+Z restores the node AND its connection lines.
    // Drain any pre-existing history FIRST (adds don't push history, but
    // earlier tests' removals do — undoing those would wipe our fixtures).
    while (useGraphStore.getState().canUndo) useGraphStore.getState().undo();

    useGraphStore.getState().addNode(makeHwNode('hw1', { configFile: 'a.cfg' }));
    useGraphStore.getState().addNode(makeHwNode('hw2', { configFile: 'b.cfg' }));
    useGraphStore.getState().addEdge(makeEdge('e1', 'hw1', 'hw2'));
    useGraphStore.getState().addEdge(makeEdge('e2', 'hw1', 'hw1'));

    // Simulate deleteElements order: edge remove changes first, then node removes
    useGraphStore.getState().onEdgesChange([{ type: 'remove', id: 'e1' }, { type: 'remove', id: 'e2' }]);
    useGraphStore.getState().onNodesChange([{ type: 'remove', id: 'hw1' }]);

    const state = useGraphStore.getState();
    expect(state.nodes.map((n) => n.id)).toEqual(['hw2']);
    expect(state.edges).toHaveLength(0);
    expect(state.canUndo).toBe(true);

    // ONE undo must restore hw1 AND both edges (the edge push captured the
    // full pre-delete state; the node push was deduped)
    state.undo();
    const restored = useGraphStore.getState();
    expect(restored.nodes.map((n) => n.id).sort()).toEqual(['hw1', 'hw2']);
    expect(restored.edges.map((e) => e.id).sort()).toEqual(['e1', 'e2']);
  });
});

describe('graphStore undo/redo', () => {
  it('pushHistory then undo restores prior state', () => {
    useGraphStore.getState().addNode(makeHwNode('n1'));
    useGraphStore.getState().pushHistory();
    useGraphStore.getState().addNode(makeHwNode('n2'));
    expect(useGraphStore.getState().nodes).toHaveLength(2);
    expect(useGraphStore.getState().canUndo).toBe(true);

    useGraphStore.getState().undo();
    expect(useGraphStore.getState().nodes.map((n) => n.id)).toEqual(['n1']);
    expect(useGraphStore.getState().canRedo).toBe(true);

    useGraphStore.getState().redo();
    expect(useGraphStore.getState().nodes).toHaveLength(2);
  });

  it('undo with empty history is a no-op', () => {
    // The undo stack is module-level; drain any entries left by earlier tests.
    while (useGraphStore.getState().canUndo) {
      useGraphStore.getState().undo();
    }
    useGraphStore.getState().undo();
    expect(useGraphStore.getState().nodes).toHaveLength(0);
  });

  it('pushHistory before a sidebar config mutation makes it undoable', () => {
    // Simulates the Phase 3 pattern: MCU rename / suppress toggle / primary
    // toggle push history at handler start, then mutate configFiles + node data.
    useConfigStore.getState().setConfigFile('printer.cfg', {
      filename: 'printer.cfg',
      sections: [
        { section_type: 'mcu', section_name: 'mainboard', full_header: 'mcu mainboard', line_number: 1, params: [{ key: 'serial', value: '/dev/ttyACM0', comment: '', is_commented_out: false }], header_comments: [], trailing_comments: [], is_commented_out: false },
        { section_type: 'stepper_x', section_name: '', full_header: 'stepper_x', line_number: 2, params: [{ key: 'step_pin', value: 'mainboard:PA0', comment: '', is_commented_out: false }], header_comments: [], trailing_comments: [], is_commented_out: false },
      ],
      includes: [],
      header_comments: [],
      raw_text: '',
    });
    useConfigStore.getState().markClean();
    useGraphStore.getState().addNode(makeHwNode('mainboard', { mcuName: 'mainboard' }));
    useGraphStore.getState().pushHistory();

    // MCU rename: header [mcu mainboard] → [mcu], pins re-prefixed
    const cf = useConfigStore.getState().configFiles['printer.cfg'];
    useConfigStore.getState().updateConfigFile('printer.cfg', {
      ...cf,
      sections: cf.sections.map((s) =>
        s.full_header === 'mcu mainboard'
          ? { ...s, section_name: '', full_header: 'mcu' }
          : s.full_header === 'stepper_x'
            ? { ...s, params: s.params.map((p) => ({ ...p, value: 'PA0' })) }
            : s,
      ),
    });
    useGraphStore.getState().updateNodeData('mainboard', { mcuName: '' } as Partial<AppNode['data']>);
    expect(useConfigStore.getState().isDirty).toBe(true);

    // Undo restores config content AND node data
    useGraphStore.getState().undo();
    const restored = useConfigStore.getState().configFiles['printer.cfg'];
    expect(restored.sections[0].full_header).toBe('mcu mainboard');
    expect(restored.sections[1].params[0].value).toBe('mainboard:PA0');
    expect(useGraphStore.getState().nodes[0].data.mcuName).toBe('mainboard');
  });

  it('suppress toggle is undoable (config section + node flag restored)', () => {
    useConfigStore.getState().setConfigFile('printer.cfg', {
      filename: 'printer.cfg',
      sections: [
        { section_type: 'fan', section_name: '', full_header: 'fan', line_number: 1, params: [{ key: 'pin', value: 'PA1', comment: '', is_commented_out: false }], header_comments: [], trailing_comments: [], is_commented_out: false },
      ],
      includes: [],
      header_comments: [],
      raw_text: '',
    });
    useConfigStore.getState().markClean();
    useGraphStore.getState().addNode(makeChildNode('fan1', 'hw1', 'fan'));
    useGraphStore.getState().pushHistory();

    // Suppress: comment all params + set node flag
    const cf = useConfigStore.getState().configFiles['printer.cfg'];
    useConfigStore.getState().updateConfigFile('printer.cfg', {
      ...cf,
      sections: cf.sections.map((s) => ({ ...s, is_commented_out: true, params: s.params.map((p) => ({ ...p, is_commented_out: true })) })),
    });
    useGraphStore.getState().updateNodeData('fan1', { isSuppressed: true } as Partial<AppNode['data']>);

    useGraphStore.getState().undo();
    const restored = useConfigStore.getState().configFiles['printer.cfg'];
    expect(restored.sections[0].is_commented_out).toBe(false);
    expect(restored.sections[0].params[0].is_commented_out).toBe(false);
    // Node flag restored to its pre-toggle state (absent → undefined)
    expect(useGraphStore.getState().nodes[0].data.isSuppressed).toBeUndefined();
  });
});

describe('graphStore auto-arrange', () => {
  it('centers a single node', () => {
    useGraphStore.getState().addNode(makeHwNode('only'));
    useGraphStore.getState().autoArrange();
    const node = useGraphStore.getState().nodes[0];
    expect(node.position.x).toBeGreaterThan(0);
    expect(node.position.y).toBeGreaterThan(0);
  });

  it('spreads multiple hardware nodes apart', () => {
    useGraphStore.getState().addNode(makeHwNode('a', { hardwareType: 'sbc', configFile: 'printer.cfg' }));
    useGraphStore.getState().addNode(makeHwNode('b', { configFile: 'b.cfg' }));
    useGraphStore.getState().addNode(makeHwNode('c', { configFile: 'c.cfg' }));
    useGraphStore.getState().autoArrange();
    const nodes = useGraphStore.getState().nodes;
    const positions = nodes.map((n) => `${n.position.x},${n.position.y}`);
    expect(new Set(positions).size).toBe(3);
  });

  it('no-op when the graph is empty', () => {
    useGraphStore.getState().autoArrange();
    expect(useGraphStore.getState().nodes).toHaveLength(0);
  });

  it('standalone sub-component is flagged isStandalone, not orphan', () => {
    useGraphStore.getState().addSubComponentNode(null as unknown as string, 'fan', 'Fan', 'fan', 'printer.cfg');
    const node = useGraphStore.getState().nodes[0];
    expect(node.type).toBe('subComponent');
    expect((node.data as Record<string, unknown>).isStandalone).toBe(true);
    expect((node.data as Record<string, unknown>).parentHardwareId).toBeNull();
  });

  it('standalone feature is flagged isStandalone, not orphan', () => {
    useGraphStore.getState().addFeatureNode(null as unknown as string, 'gcode_macro', 'Macro', 'gcode_macro X', 'printer.cfg');
    const node = useGraphStore.getState().nodes[0];
    expect(node.type).toBe('feature');
    expect((node.data as Record<string, unknown>).isStandalone).toBe(true);
    expect((node.data as Record<string, unknown>).parentId).toBeNull();
  });
});

  it('removes the board sections but keeps the file when a virtual SBC references it', () => {
    useConfigStore.getState().setConfigFile('printer.cfg', {
      filename: 'printer.cfg',
      sections: [
        { section_type: 'mcu', section_name: '', full_header: 'mcu', line_number: 1, params: [], header_comments: [], trailing_comments: [], is_commented_out: false },
        { section_type: 'printer', section_name: '', full_header: 'printer', line_number: 2, params: [], header_comments: [], trailing_comments: [], is_commented_out: false },
        { section_type: 'stepper_x', section_name: '', full_header: 'stepper_x', line_number: 3, params: [], header_comments: [], trailing_comments: [], is_commented_out: false },
        { section_type: 'heater_bed', section_name: '', full_header: 'heater_bed', line_number: 4, params: [], header_comments: [], trailing_comments: [], is_commented_out: false },
      ],
      includes: [],
      header_comments: [],
      raw_text: '',
    });
    // Mainboard + virtual SBC both reference printer.cfg
    useGraphStore.getState().addNode(makeHwNode('mainboard', { configFile: 'printer.cfg', mcuName: '' }));
    useGraphStore.getState().addNode(makeHwNode('sbc', { configFile: 'printer.cfg', mcuName: 'host_mcu', hardwareType: 'sbc' }));
    // Child nodes (what graphBuilder creates for each section) — correct line numbers
    useGraphStore.getState().addNode(makeChildNode('c-mcu', 'mainboard', 'mcu', 'printer.cfg'));
    useGraphStore.getState().addNode(makeChildNode('c-printer', 'mainboard', 'printer', 'printer.cfg'));
    useGraphStore.getState().addNode(makeChildNode('c-stepper', 'mainboard', 'stepper_x', 'printer.cfg'));
    useGraphStore.getState().addNode(makeChildNode('c-heater', 'mainboard', 'heater_bed', 'printer.cfg'));
    // Fix their line numbers to match the config
    const cfg = useConfigStore.getState().configFiles['printer.cfg'];
    const byHeader = new Map(cfg.sections.map((s) => [s.full_header, s.line_number]));
    for (const n of useGraphStore.getState().nodes) {
      if (n.type === 'subComponent') {
        const hdr = (n.data as Record<string, unknown>).sectionHeader as string;
        useGraphStore.getState().updateNodeData(n.id, { sectionLineNumber: byHeader.get(hdr) });
      }
    }

    useGraphStore.getState().removeNode('mainboard');

    const after = useConfigStore.getState().configFiles['printer.cfg'];
    // File survives (SBC references it) but all mainboard sections are gone
    expect(after).toBeDefined();
    expect(after.sections.map((s) => s.full_header)).toEqual([]);
  });

  it('removes sections even when child line numbers are STALE (config edited since graph build)', () => {
    useConfigStore.getState().setConfigFile('printer.cfg', {
      filename: 'printer.cfg',
      sections: [
        { section_type: 'mcu', section_name: '', full_header: 'mcu', line_number: 1, params: [], header_comments: [], trailing_comments: [], is_commented_out: false },
        { section_type: 'printer', section_name: '', full_header: 'printer', line_number: 2, params: [], header_comments: [], trailing_comments: [], is_commented_out: false },
        { section_type: 'stepper_x', section_name: '', full_header: 'stepper_x', line_number: 3, params: [], header_comments: [], trailing_comments: [], is_commented_out: false },
      ],
      includes: [],
      header_comments: [],
      raw_text: '',
    });
    useGraphStore.getState().addNode(makeHwNode('mainboard', { configFile: 'printer.cfg' }));
    useGraphStore.getState().addNode(makeHwNode('sbc', { configFile: 'printer.cfg', mcuName: 'host_mcu', hardwareType: 'sbc' }));
    // Children carry STALE line numbers (1) — config has them at 1,2,3
    useGraphStore.getState().addNode(makeChildNode('c-mcu', 'mainboard', 'mcu'));
    useGraphStore.getState().addNode(makeChildNode('c-printer', 'mainboard', 'printer'));
    useGraphStore.getState().addNode(makeChildNode('c-stepper', 'mainboard', 'stepper_x'));

    useGraphStore.getState().removeNode('mainboard');

    const after = useConfigStore.getState().configFiles['printer.cfg'];
    expect(after).toBeDefined();
    // Even with stale line numbers, all three sections must be removed — a
    // silent no-op here is what makes deletes vanish from the diff.
    expect(after.sections.map((s) => s.full_header)).toEqual([]);
  });

  it('delete leaves NO sections when hardware has no children (all sections are children)', () => {
    useConfigStore.getState().setConfigFile('printer.cfg', {
      filename: 'printer.cfg',
      sections: [
        { section_type: 'mcu', section_name: '', full_header: 'mcu', line_number: 1, params: [], header_comments: [], trailing_comments: [], is_commented_out: false },
      ],
      includes: [],
      header_comments: [],
      raw_text: '',
    });
    useGraphStore.getState().addNode(makeHwNode('mainboard', { configFile: 'printer.cfg' }));
    useGraphStore.getState().addNode(makeHwNode('sbc', { configFile: 'printer.cfg', mcuName: 'host_mcu', hardwareType: 'sbc' }));
    useGraphStore.getState().addNode(makeChildNode('c-mcu', 'mainboard', 'mcu'));

    useGraphStore.getState().removeNode('mainboard');

    const cf = useConfigStore.getState().configFiles['printer.cfg'];
    expect(cf).toBeDefined();
    expect(cf.sections).toHaveLength(0);
  });

describe('graphStore configuration edge redraw/delete', () => {
  function setupToolheadMainboard() {
    useConfigStore.getState().setConfigFile('printer.cfg', {
      filename: 'printer.cfg',
      sections: [
        { section_type: 'include', section_name: 'toolhead_board.cfg', full_header: 'include toolhead_board.cfg', line_number: 1, params: [], header_comments: [], trailing_comments: [], is_commented_out: false },
        { section_type: 'mcu', section_name: '', full_header: 'mcu', line_number: 2, params: [], header_comments: [], trailing_comments: [], is_commented_out: false },
        { section_type: 'printer', section_name: '', full_header: 'printer', line_number: 3, params: [], header_comments: [], trailing_comments: [], is_commented_out: false },
      ],
      includes: ['toolhead_board.cfg'],
      header_comments: [],
      raw_text: '[include toolhead_board.cfg]\n[mcu]\nserial: /dev/ttyACM0\n[printer]\nkinematics: cartesian\n',
    });
    useConfigStore.getState().setConfigFile('toolhead_board.cfg', {
      filename: 'toolhead_board.cfg',
      sections: [
        { section_type: 'mcu', section_name: 'toolhead', full_header: 'mcu toolhead', line_number: 1, params: [], header_comments: [], trailing_comments: [], is_commented_out: false },
      ],
      includes: [],
      header_comments: [],
      raw_text: '[mcu toolhead]\nserial: /dev/serial/by-id/ebbtool\n',
    });
    useConfigStore.getState().markClean();
    useGraphStore.getState().addNode(makeHwNode('mainboard', { configFile: 'printer.cfg' }));
    useGraphStore.getState().addNode(makeHwNode('toolhead', { configFile: 'toolhead_board.cfg' }));
    // Pre-existing configuration edge (built by graphBuilder on import)
    return useGraphStore.getState().addConfigurationEdge('toolhead', 'mainboard', 'toolhead');
  }

  it('redrawing a configuration edge between an already-connected pair does not mark dirty', () => {
    setupToolheadMainboard();
    expect(useConfigStore.getState().isDirty).toBe(false);

    // User redraws the line toolhead → mainboard (same pair, same direction)
    useGraphStore.getState().onConnect({ source: 'toolhead', target: 'mainboard', sourceHandle: null, targetHandle: null });

    // Config untouched: include still active, not dirty, diff would be blank
    expect(useConfigStore.getState().isDirty).toBe(false);
    const cf = useConfigStore.getState().configFiles['printer.cfg'];
    expect(cf.includes).toEqual(['toolhead_board.cfg']);
    expect(cf.sections[0].is_commented_out).toBe(false);
    // Edge was replaced (new id), still one configuration edge
    const edges = useGraphStore.getState().edges;
    expect(edges).toHaveLength(1);
    const redrawnSamePair = edges[0];
    expect(redrawnSamePair?.data?.edgeType).toBe('configuration');
  });

  it('redrawing in the OPPOSITE direction then deleting still comments out the include', () => {
    setupToolheadMainboard();
    const originalEdgeId = useGraphStore.getState().edges[0].id;

    // User redraws the line the other way: mainboard → toolhead
    useGraphStore.getState().onConnect({ source: 'mainboard', target: 'toolhead', sourceHandle: null, targetHandle: null });
    expect(useConfigStore.getState().isDirty).toBe(false);
    const redrawnEdgeId = useGraphStore.getState().edges[0].id;
    expect(redrawnEdgeId).not.toBe(originalEdgeId);
    const redrawn = useGraphStore.getState().edges[0];
    // Direction is normalized: the edge always points FROM the included
    // (non-primary) node TO the including (primary) node, regardless of
    // draw direction — so the redrawn edge still reads toolhead → mainboard.
    expect(redrawn?.source).toBe('toolhead');
    expect(redrawn?.target).toBe('mainboard');

    // Now delete the line — include must be commented out in printer.cfg
    // (the file that owns the include), regardless of edge direction.
    useGraphStore.getState().onEdgesChange([{ type: 'remove', id: redrawnEdgeId }]);
    const cf = useConfigStore.getState().configFiles['printer.cfg'];
    expect(cf.includes).toEqual([]);
    expect(cf.sections[0].is_commented_out).toBe(true);
    expect(useConfigStore.getState().isDirty).toBe(true);
  });

  it('repointConfigEdge swaps the include to the new pair', () => {
    // printer.cfg (primary mainboard) + toolhead_board.cfg, plus a second
    // non-primary file so re-pointing changes the included file.
    useConfigStore.getState().setConfigFile('printer.cfg', {
      filename: 'printer.cfg',
      sections: [
        { section_type: 'include', section_name: 'toolhead_board.cfg', full_header: 'include toolhead_board.cfg', line_number: 1, params: [], header_comments: [], trailing_comments: [], is_commented_out: false },
        { section_type: 'mcu', section_name: '', full_header: 'mcu', line_number: 2, params: [], header_comments: [], trailing_comments: [], is_commented_out: false },
      ],
      includes: ['toolhead_board.cfg'],
      header_comments: [],
      raw_text: '[include toolhead_board.cfg]\n[mcu]\n',
    });
    useConfigStore.getState().setConfigFile('toolhead_board.cfg', {
      filename: 'toolhead_board.cfg',
      sections: [
        { section_type: 'mcu', section_name: 'toolhead', full_header: 'mcu toolhead', line_number: 1, params: [], header_comments: [], trailing_comments: [], is_commented_out: false },
      ],
      includes: [],
      header_comments: [],
      raw_text: '[mcu toolhead]\n',
    });
    useConfigStore.getState().setConfigFile('expander.cfg', {
      filename: 'expander.cfg',
      sections: [
        { section_type: 'mcu', section_name: 'expander', full_header: 'mcu expander', line_number: 1, params: [], header_comments: [], trailing_comments: [], is_commented_out: false },
      ],
      includes: [],
      header_comments: [],
      raw_text: '[mcu expander]\n',
    });
    useConfigStore.getState().markClean();
    useGraphStore.getState().addNode(makeHwNode('mainboard', { configFile: 'printer.cfg', isPrimary: true }));
    useGraphStore.getState().addNode(makeHwNode('toolhead', { configFile: 'toolhead_board.cfg' }));
    useGraphStore.getState().addNode(makeHwNode('expander', { configFile: 'expander.cfg' }));
    const edgeId = useGraphStore.getState().addConfigurationEdge('toolhead', 'mainboard', 'toolhead');

    // Re-point the edge: toolhead → expander (neither primary, so target
    // includes source: expander.cfg gains [include toolhead_board.cfg] and
    // printer.cfg's include is commented out).
    useGraphStore.getState().repointConfigEdge(edgeId, 'toolhead', 'expander');

    const edge = useGraphStore.getState().edges.find((e) => e.id === edgeId);
    expect(edge?.source).toBe('toolhead');
    expect(edge?.target).toBe('expander');

    const printerCfg = useConfigStore.getState().configFiles['printer.cfg'];
    expect(printerCfg.includes).toEqual([]);
    expect(printerCfg.sections[0].is_commented_out).toBe(true);

    const expanderCfg = useConfigStore.getState().configFiles['expander.cfg'];
    expect(expanderCfg.includes).toEqual(['toolhead_board.cfg']);
    expect(useConfigStore.getState().isDirty).toBe(true);

    // Undo restores the original edge + include state
    useGraphStore.getState().undo();
    expect(useGraphStore.getState().edges.find((e) => e.id === edgeId)?.target).toBe('mainboard');
    expect(useConfigStore.getState().configFiles['printer.cfg'].includes).toEqual(['toolhead_board.cfg']);
  });

  it('deleting an edge drawn toolhead → mainboard still comments out the include', () => {
    const edgeId = setupToolheadMainboard();

    useGraphStore.getState().onEdgesChange([{ type: 'remove', id: edgeId }]);
    const cf = useConfigStore.getState().configFiles['printer.cfg'];
    expect(cf.includes).toEqual([]);
    expect(cf.sections[0].is_commented_out).toBe(true);
  });

  it('syncGraphWithConfig does not create a phantom config edge to the SBC when printer.cfg hosts both MCUs', () => {
    // printer.cfg contains [mcu] for the primary mainboard AND [mcu host_mcu]
    // for the SBC — graphBuilder inserts the SBC node first, so the old
    // configFile-first lookup attached include edges to the SBC.
    const makeCfg = (filename: string, includes: string[]) => ({
      filename,
      sections: [
        { section_type: 'include', section_name: 'toolhead_board.cfg', full_header: 'include toolhead_board.cfg', line_number: 1, params: [], header_comments: [], trailing_comments: [], is_commented_out: false },
        { section_type: 'mcu', section_name: 'mainboard', full_header: 'mcu mainboard', line_number: 2, params: [], header_comments: [], trailing_comments: [], is_commented_out: false },
        { section_type: 'mcu', section_name: 'host_mcu', full_header: 'mcu host_mcu', line_number: 3, params: [], header_comments: [], trailing_comments: [], is_commented_out: false },
      ],
      includes,
      header_comments: [],
      raw_text: '',
    });
    useConfigStore.getState().setConfigFile('printer.cfg', makeCfg('printer.cfg', ['toolhead_board.cfg']));
    useConfigStore.getState().setConfigFile('toolhead_board.cfg', makeCfg('toolhead_board.cfg', []));
    useGraphStore.setState({
      nodes: [
        // SBC first — this used to win the `find(configFile)` lookup
        makeHwNode('sbc', { hardwareType: 'sbc', configFile: 'printer.cfg', mcuName: 'host_mcu', isPrimary: false }),
        makeHwNode('mainboard', { hardwareType: 'mainboard', configFile: 'printer.cfg', mcuName: 'mainboard', isPrimary: true }),
        makeHwNode('toolhead', { hardwareType: 'toolhead', configFile: 'toolhead_board.cfg', mcuName: 'ebbtool', isPrimary: false }),
      ],
      edges: [],
    });

    useGraphStore.getState().syncGraphWithConfig('printer.cfg');

    const edges = useGraphStore.getState().edges;
    const configEdges = edges.filter((e) => (e.data as Record<string, unknown>)?.edgeType === 'configuration');
    // Exactly one config edge, between the toolhead and the PRIMARY mainboard —
    // never attached to the SBC node.
    expect(configEdges).toHaveLength(1);
    expect(configEdges[0].source).toBe('toolhead');
    expect(configEdges[0].target).toBe('mainboard');

    // Running sync again (e.g. after a text edit) must not duplicate it
    useGraphStore.getState().syncGraphWithConfig('printer.cfg');
    expect(useGraphStore.getState().edges.filter((e) => (e.data as Record<string, unknown>)?.edgeType === 'configuration')).toHaveLength(1);
  });

  it('snapChildrenToColumns respects expanded group heights (variable slots)', () => {
    // Parent with two feature-group children. One group is selected (expanded)
    // with 3 children, so its slot height is variable: TILE_HEADER_HEIGHT +
    // 3*GROUP_ITEM_HEIGHT + GROUP_BODY_PADDING + TILE_GAP = 36+66+12+4 = 118.
    // The other group is a compact tile (slot = CHILD_SLOT_HEIGHT = 40).
    const hw = makeHwNode('hw1', { configFile: 'printer.cfg', mcuName: 'mainboard' });
    const bigGroup: AppNode = {
      id: 'bigGroup',
      type: 'group',
      position: { x: 12, y: 110 },
      parentId: 'hw1',
      data: {
        label: 'Features',
        componentGroup: 'other',
        isFeature: true,
        sectionHeader: 'features',
        configFile: 'printer.cfg',
        children: [{ sectionHeader: 'bed_mesh' }, { sectionHeader: 'z_tilt' }, { sectionHeader: 'skew' }],
        hasErrors: false,
      },
    } as unknown as AppNode;
    const smallGroup: AppNode = {
      id: 'smallGroup',
      type: 'group',
      position: { x: 12, y: 230 },
      parentId: 'hw1',
      data: {
        label: 'Macros',
        componentGroup: 'other',
        isFeature: true,
        sectionHeader: 'macros',
        configFile: 'printer.cfg',
        children: [],
        hasErrors: false,
      },
    } as unknown as AppNode;

    useGraphStore.setState({ nodes: [hw, bigGroup, smallGroup], edges: [] });
    useGraphStore.getState().setSelectedNode('bigGroup');

    // Drag the small group below the big one; it must snap BELOW the big
    // group's expanded height (110 + 118 = 228), not to a fixed slot.
    useGraphStore.getState().snapChildrenToColumns('hw1', 'smallGroup', 400);

    const snappedSmall = useGraphStore.getState().nodes.find((n) => n.id === 'smallGroup');
    const snappedBig = useGraphStore.getState().nodes.find((n) => n.id === 'bigGroup');
    expect(snappedBig?.position.y).toBe(110);
    expect(snappedSmall?.position.y).toBeGreaterThanOrEqual(110 + 118);
    // Big group keeps its expanded height slot (variable), not CHILD_SLOT_HEIGHT
    expect(snappedSmall!.position.y).not.toBe(110 + 40);
  });
});
