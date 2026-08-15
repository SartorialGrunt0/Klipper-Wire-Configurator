import { beforeEach, describe, expect, it } from 'vitest';
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
});
