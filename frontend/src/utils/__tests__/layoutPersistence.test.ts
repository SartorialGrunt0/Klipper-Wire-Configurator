import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConfigFile, ConfigSection } from '@/types/config';
import {
  applySavedEdgeLayout,
  applySavedNodePositions,
  buildLayoutPayload,
  computeLogicalKey,
  normalizeSavedLayout,
  type SavedLayout,
} from '../layoutPersistence';

/**
 * Layout persistence tests — the contract for card positions and wire
 * routing surviving page refreshes AND in-session graph rebuilds.
 *
 * Uses the REAL graph store + REAL project builder; "page refresh" is
 * simulated with vi.resetModules(), which resets the module-level
 * node/edge id counters the same way a browser reload does.
 */

// ── Fixtures ─────────────────────────────────────────────────────────

const sec = (
  section_type: string,
  full_header: string,
  section_name = '',
): ConfigSection => ({
  section_type,
  section_name,
  full_header,
  line_number: 1,
  params: [],
  header_comments: [],
  trailing_comments: [],
  is_commented_out: false,
});

const TRIDENT_CONFIGS: Record<string, ConfigFile> = {
  'printer.cfg': {
    filename: 'printer.cfg',
    sections: [
      sec('mcu', 'mcu'),
      sec('mcu', 'mcu EBBCan', 'EBBCan'),
      sec('include', 'include hotkey.cfg'),
    ],
    includes: ['hotkey.cfg'],
    header_comments: [],
    raw_text: '',
  },
  'hotkey.cfg': {
    filename: 'hotkey.cfg',
    sections: [
      sec('fan', 'fan'),
      sec('bed_mesh', 'bed_mesh'),
    ],
    includes: [],
    header_comments: [],
    raw_text: '',
  },
};

const SCHEMAS = {
  mcu: { section_type: 'mcu', display_name: 'MCU', category: 'sub_component', component_group: 'mcu', is_named: true, description: '', max_instances: 5, requires: [], params: [] },
  fan: { section_type: 'fan', display_name: 'Fan', category: 'sub_component', component_group: 'fan', is_named: false, description: '', max_instances: 1, requires: [], params: [] },
  bed_mesh: { section_type: 'bed_mesh', display_name: 'Bed Mesh', category: 'feature', component_group: 'bed_mesh', is_named: false, description: '', max_instances: 1, requires: [], params: [] },
  output_pin: { section_type: 'output_pin', display_name: 'Output Pin', category: 'sub_component', component_group: 'other', is_named: false, description: '', max_instances: 99, requires: [], params: [] },
} as never;

/** Add a section to hotkey.cfg BEFORE the fan (shifts the node id
 *  sequence for every card built after it — the classic trigger). */
function tridentWithOutputPinBefore(): Record<string, ConfigFile> {
  return {
    ...TRIDENT_CONFIGS,
    'hotkey.cfg': {
      ...TRIDENT_CONFIGS['hotkey.cfg'],
      sections: [
        sec('output_pin', 'output_pin'),
        ...TRIDENT_CONFIGS['hotkey.cfg'].sections,
      ],
    },
  };
}

function threeOutputPinsBefore(): Record<string, ConfigFile> {
  return {
    ...TRIDENT_CONFIGS,
    'hotkey.cfg': {
      ...TRIDENT_CONFIGS['hotkey.cfg'],
      sections: [
        sec('output_pin', 'output_pin'),
        sec('output_pin', 'output_pin: led'),
        sec('output_pin', 'output_pin: aux'),
        ...TRIDENT_CONFIGS['hotkey.cfg'].sections,
      ],
    },
  };
}

/**
 * A NEW board whose config file comes FIRST in build order — hardware
 * boards are created in file-iteration order (SBC first, then MCUs per
 * file), so this shifts the id of every hardware node after it. Edge
 * endpoints reference hardware nodes, so this is what exercises wire
 * endpoint remapping across a refresh.
 */
function tridentWithExtraBoardFirst(): Record<string, ConfigFile> {
  return {
    'can2.cfg': {
      filename: 'can2.cfg',
      sections: [sec('mcu', 'mcu can2', 'can2')],
      includes: [],
      header_comments: [],
      raw_text: '',
    },
    ...TRIDENT_CONFIGS,
  };
}

// ── Refresh simulation ───────────────────────────────────────────────

interface FreshModules {
  graph: typeof import('@/stores/graphStore').useGraphStore;
  buildProjectGraph: typeof import('@/utils/graphBuilder').buildProjectGraph;
  config: typeof import('@/stores/configStore').useConfigStore;
}

async function freshModules(): Promise<FreshModules> {
  vi.resetModules();
  const graphMod = await import('@/stores/graphStore');
  const builderMod = await import('@/utils/graphBuilder');
  const configMod = await import('@/stores/configStore');
  return {
    graph: graphMod.useGraphStore,
    buildProjectGraph: builderMod.buildProjectGraph,
    config: configMod.useConfigStore,
  };
}

/** Simulate the user arranging cards: give every node a distinct position. */
function arrangeAll(m: FreshModules): void {
  const g = m.graph.getState();
  g.setNodes(g.nodes.map((n, i) => ({
    ...n,
    position: { x: 1000 + i * 50, y: 500 + i * 30 },
  }) as never) as never);
}

/**
 * Positions keyed by content identity (logical key; node id for keyless
 * nodes like customGroup). Label-keying collides — a two-MCU build has two
 * "MCU" cards.
 */
function keyedPositions(nodes: Array<{ id: string; position: { x: number; y: number }; type: string; data: Record<string, unknown> }>): Map<string, { x: number; y: number }> {
  const out = new Map<string, { x: number; y: number }>();
  for (const n of nodes) {
    out.set(computeLogicalKey(n) ?? n.id, { ...n.position });
  }
  return out;
}

/** Every pre-existing card (by identity) must own its saved position after
 *  the rebuild; new cards must not squat on a saved spot. */
function checkPositionsRestored(
  beforeNodes: Array<{ id: string; position: { x: number; y: number }; type: string; data: Record<string, unknown> }>,
  afterNodes: Array<{ id: string; position: { x: number; y: number }; type: string; data: Record<string, unknown> }>,
): void {
  const before = keyedPositions(beforeNodes);
  const after = keyedPositions(afterNodes);
  const problems: string[] = [];
  for (const [key, pos] of before) {
    const got = after.get(key);
    if (!got) continue; // card removed — allowed
    if (JSON.stringify(got) !== JSON.stringify(pos)) {
      problems.push(`card ${key}: saved ${JSON.stringify(pos)}, got ${JSON.stringify(got)}`);
    }
  }
  // New cards (absent from the save) must not claim a saved position
  const savedPos = new Set([...before.values()].map((p) => JSON.stringify(p)));
  for (const [key, pos] of after) {
    if (before.has(key)) continue;
    if (savedPos.has(JSON.stringify(pos))) {
      problems.push(`new card ${key} squatting on a saved position ${JSON.stringify(pos)}`);
    }
  }
  expect(problems, problems.join('\n')).toEqual([]);
}

beforeEach(() => {
  vi.resetModules();
});

// ── computeLogicalKey ────────────────────────────────────────────────

describe('computeLogicalKey', () => {
  it('derives stable keys per node type', () => {
    expect(computeLogicalKey({
      type: 'hardware',
      data: { hardwareType: 'sbc', configFile: '', mcuName: '' },
    })).toBe('sbc|singleton');

    expect(computeLogicalKey({
      type: 'hardware',
      data: { hardwareType: 'toolhead', configFile: 'ebbcan.cfg', mcuName: 'EBBCan' },
    })).toBe('hw|toolhead|ebbcan.cfg|EBBCan');

    expect(computeLogicalKey({
      type: 'feature',
      data: { configFile: 'hotkey.cfg', sectionHeader: 'bed_mesh', sectionLineNumber: 12 },
    })).toBe('sec|hotkey.cfg|bed_mesh#12');

    expect(computeLogicalKey({
      type: 'group',
      data: {
        configFile: 'hotkey.cfg',
        componentGroup: 'other',
        isFeature: false,
        children: [
          { sectionHeader: 'output_pin: aux', sectionLineNumber: 3 },
          { sectionHeader: 'output_pin', sectionLineNumber: 1 },
        ],
      },
    })).toBe('grp|hotkey.cfg|other|c|output_pin#1,output_pin: aux#3');

    // Child order must not change the group identity
    const reversed = computeLogicalKey({
      type: 'group',
      data: {
        configFile: 'hotkey.cfg',
        componentGroup: 'other',
        isFeature: false,
        children: [
          { sectionHeader: 'output_pin', sectionLineNumber: 1 },
          { sectionHeader: 'output_pin: aux', sectionLineNumber: 3 },
        ],
      },
    });
    expect(reversed).toBe('grp|hotkey.cfg|other|c|output_pin#1,output_pin: aux#3');

    expect(computeLogicalKey({
      type: 'customGroup',
      data: { label: 'My Group' },
    })).toBeNull();
  });

  it('distinguishes two boards in the same multi-MCU file by mcuName', () => {
    const a = computeLogicalKey({
      type: 'hardware',
      data: { hardwareType: 'mainboard', configFile: 'printer.cfg', mcuName: '' },
    });
    const b = computeLogicalKey({
      type: 'hardware',
      data: { hardwareType: 'toolhead', configFile: 'printer.cfg', mcuName: 'EBBCan' },
    });
    expect(a).not.toBe(b);
  });
});

// ── normalizeSavedLayout / buildLayoutPayload ────────────────────────

describe('saved layout (de)serialization', () => {
  it('normalizes legacy shapes (full nodes / endpoint-less edges)', () => {
    const raw = {
      graphNodes: [
        // legacy native save: FULL node objects (no logicalKey)
        {
          id: 'node_1',
          position: { x: 10, y: 20 },
          type: 'feature',
          data: { configFile: 'hotkey.cfg', sectionHeader: 'bed_mesh', sectionLineNumber: 12 },
        },
        // current compact save
        { id: 'node_2', position: { x: 30, y: 40 }, logicalKey: 'sbc|singleton' },
        // malformed entries — dropped, never thrown
        null,
        { id: 'node_3' },
        { position: { x: 1, y: 2 } },
      ],
      graphEdges: [
        { id: 'edge_1', data: { edgeType: 'communication' }, sourceHandle: 'top' },
        { id: 'edge_2', source: 'node_1', target: 'node_3', data: { edgeType: 'configuration' } },
        'garbage',
      ],
      macroDesigner: null,
    };
    const norm = normalizeSavedLayout(raw);
    expect(norm.graphNodes).toHaveLength(2);
    // logical key computed from the legacy full-node data
    expect(norm.graphNodes[0].logicalKey).toBe('sec|hotkey.cfg|bed_mesh#12');
    expect(norm.graphNodes[1].logicalKey).toBe('sbc|singleton');
    expect(norm.graphEdges[0]).toMatchObject({ id: 'edge_1', sourceHandle: 'top' });
    expect(norm.graphEdges[0].source).toBeUndefined();
    expect(norm.graphEdges[1]).toMatchObject({ source: 'node_1', target: 'node_3' });
  });

  it('round-trips buildLayoutPayload through normalizeSavedLayout', () => {
    const nodes = [
      {
        id: 'node_1', type: 'hardware' as never, position: { x: 1, y: 2 },
        data: { hardwareType: 'sbc', configFile: '', mcuName: '' } as never,
      },
    ] as never[];
    const edges = [{ id: 'edge_1', source: 'node_1', target: 'node_2', data: { edgeType: 'communication' } }] as never[];
    const payload = buildLayoutPayload(nodes, edges, null);
    const norm = normalizeSavedLayout(payload);
    expect(norm.graphNodes[0]).toEqual({ id: 'node_1', position: { x: 1, y: 2 }, logicalKey: 'sbc|singleton' });
    expect(norm.graphEdges[0]).toMatchObject({
      id: 'edge_1', source: 'node_1', target: 'node_2',
    });
  });
});

// ── Refresh scenarios (the original bug) ─────────────────────────────

describe('refresh persistence (real store + builder, module-counter reset)', () => {
  it('plain refresh: every card keeps its position', async () => {
    const m1 = await freshModules();
    m1.graph.getState().clearGraph();
    m1.buildProjectGraph(TRIDENT_CONFIGS, m1.graph.getState(), SCHEMAS);
    arrangeAll(m1);
    const before = m1.graph.getState().nodes.map((n) => ({ ...n, data: { ...n.data } }));
    const saved = buildLayoutPayload(m1.graph.getState().nodes, m1.graph.getState().edges, null);

    // page refresh → module counters reset
    const m2 = await freshModules();
    m2.graph.getState().clearGraph();
    m2.buildProjectGraph(TRIDENT_CONFIGS, m2.graph.getState(), SCHEMAS);
    const g2 = m2.graph.getState();
    g2.setNodes(applySavedNodePositions(g2.nodes, saved.graphNodes) as never);
    // Re-read state — the g2 snapshot is stale after setNodes
    checkPositionsRestored(before, m2.graph.getState().nodes);
  });

  it('add section to earlier-sorted file, then refresh: every pre-existing card keeps ITS OWN position', async () => {
    const m1 = await freshModules();
    m1.graph.getState().clearGraph();
    m1.buildProjectGraph(TRIDENT_CONFIGS, m1.graph.getState(), SCHEMAS);
    arrangeAll(m1);
    const before = m1.graph.getState().nodes.map((n) => ({ ...n, data: { ...n.data } }));
    const saved = buildLayoutPayload(m1.graph.getState().nodes, m1.graph.getState().edges, null);

    // user adds [output_pin] to hotkey.cfg BEFORE fan/bed_mesh → the
    // rebuilt id sequence shifts (this is the original repro: cards
    // silently fell back to auto-arranged positions)
    const m2 = await freshModules();
    m2.graph.getState().clearGraph();
    m2.buildProjectGraph(tridentWithOutputPinBefore(), m2.graph.getState(), SCHEMAS);
    const g2 = m2.graph.getState();
    g2.setNodes(applySavedNodePositions(g2.nodes, saved.graphNodes) as never);
    checkPositionsRestored(before, m2.graph.getState().nodes);
  });

  it('legacy save (id + position only, no logicalKey) survives the shift via id fallback OR key-less no-op', async () => {
    // A save written by the OLD browser code: {id, position} only.
    // After the id shift, no keyed match exists — ids don't line up, so
    // cards keep auto-arranged positions instead of the WRONG card's
    // position (never worse than before; new-format saves match by key).
    const m1 = await freshModules();
    m1.graph.getState().clearGraph();
    m1.buildProjectGraph(TRIDENT_CONFIGS, m1.graph.getState(), SCHEMAS);
    const legacy = m1.graph.getState().nodes.map((n) => ({ id: n.id, position: n.position }));

    const m2 = await freshModules();
    m2.graph.getState().clearGraph();
    m2.buildProjectGraph(tridentWithOutputPinBefore(), m2.graph.getState(), SCHEMAS);
    const g2 = m2.graph.getState();
    g2.setNodes(applySavedNodePositions(g2.nodes, legacy as never) as never);

    // The critical safety property: where a legacy id still names the SAME
    // card in both rebuilds, the restored position must be that card's own
    // saved position (never a foreign card's). Legacy + shifted ids simply
    // leave later cards auto-arranged — same as today's exact-id restore.
    const g2fresh = m2.graph.getState();
    const byKeyAfter = keyedPositions(g2fresh.nodes);
    const savedById = new Map(legacy.map((s) => [s.id, s.position]));
    const m1nodeById = new Map(m1.graph.getState().nodes.map((n) => [n.id, n]));
    const g2nodeById = new Map(g2fresh.nodes.map((n) => [n.id, n]));
    for (const [id, pos] of savedById) {
      const oldNode = m1nodeById.get(id);
      const newNode = g2nodeById.get(id);
      if (!oldNode || !newNode) continue;
      const oldKey = computeLogicalKey(oldNode);
      const newKey = computeLogicalKey(newNode);
      if (!newKey || oldKey !== newKey) continue; // card identity changed at this id
      const applied = byKeyAfter.get(newKey);
      if (applied && JSON.stringify(applied) !== JSON.stringify(pos)) {
        throw new Error(`id ${id}: card ${newKey} got a foreign position`);
      }
    }
    expect(g2fresh.nodes.length).toBeGreaterThan(0);
  });

  it('group-threshold collapse (3+ sections) does not poison other cards', async () => {
    const m1 = await freshModules();
    m1.graph.getState().clearGraph();
    m1.buildProjectGraph(TRIDENT_CONFIGS, m1.graph.getState(), SCHEMAS);
    arrangeAll(m1);
    const before = m1.graph.getState().nodes.map((n) => ({ ...n, data: { ...n.data } }));
    const saved = buildLayoutPayload(m1.graph.getState().nodes, m1.graph.getState().edges, null);

    const m2 = await freshModules();
    m2.graph.getState().clearGraph();
    m2.buildProjectGraph(threeOutputPinsBefore(), m2.graph.getState(), SCHEMAS);
    const g2 = m2.graph.getState();
    g2.setNodes(applySavedNodePositions(g2.nodes, saved.graphNodes) as never);
    const g2fresh = m2.graph.getState();

    // The three output_pins collapsed into one group card under EBBCan
    const hotkeyGroups = g2fresh.nodes.filter((n) => (n.data as Record<string, unknown>).configFile === 'hotkey.cfg' && n.type === 'group');
    expect(hotkeyGroups.length).toBeGreaterThanOrEqual(1);

    // Every surviving card keeps its own saved position; the new group
    // card must not squat on a saved spot (checkPositionsRestored also
    // asserts the squatting direction)
    checkPositionsRestored(before, g2fresh.nodes);
  });
});

// ── Wire routing across a rebuild ────────────────────────────────────

describe('edge routing restoration across id shift', () => {
  it('remaps saved wire endpoints through logical keys after the id sequence shifts', async () => {
    const m1 = await freshModules();
    m1.graph.getState().clearGraph();
    m1.buildProjectGraph(TRIDENT_CONFIGS, m1.graph.getState(), SCHEMAS);

    // User routes the SBC↔EBBCan communication wire (the builder may
    // already have created it — use it; otherwise draw one) and bends it
    const g1 = m1.graph.getState();
    const sbc = g1.nodes.find((n) => (n.data as Record<string, unknown>).hardwareType === 'sbc')!;
    const ebbc = g1.nodes.find((n) => (n.data as Record<string, unknown>).mcuName === 'EBBCan' && n.type === 'hardware')!;
    const existing = g1.edges.find((e) =>
      (e.data as Record<string, unknown>).edgeType === 'communication'
      && ((e.source === sbc.id && e.target === ebbc.id) || (e.source === ebbc.id && e.target === sbc.id)));
    const edgeId = existing?.id ?? m1.graph.getState().addCommunicationEdge(sbc.id, ebbc.id, 'canbus');
    m1.graph.getState().updateEdgeData(edgeId, { customMiddlePoints: [{ x: 77, y: 88 }] } as never);
    // Connection sides (what the user picks when drawing)
    m1.graph.getState().setEdges(
      m1.graph.getState().edges.map((e) =>
        e.id === edgeId ? { ...e, sourceHandle: 'top', targetHandle: 'bottom' } : e) as never);
    arrangeAll(m1);

    // Re-read state (zustand snapshots are immutable — the g1 above is stale)
    const g1fresh = m1.graph.getState();
    const saved = buildLayoutPayload(g1fresh.nodes, g1fresh.edges, null) as SavedLayout;
    const savedEdge = saved.graphEdges.find((e) => e.id === edgeId)!;
    expect(savedEdge.source).toBe(sbc.id);
    expect(savedEdge.target).toBe(ebbc.id);

    // Refresh + a new board created before the existing ones → the
    // hardware node ids shift
    const m2 = await freshModules();
    m2.graph.getState().clearGraph();
    m2.buildProjectGraph(tridentWithExtraBoardFirst(), m2.graph.getState(), SCHEMAS);
    const g2 = m2.graph.getState();

    // EBBCan's hardware id differs from the saved one (SBC stays first)
    const newEbbc = g2.nodes.find((n) => n.type === 'hardware' && (n.data as Record<string, unknown>).mcuName === 'EBBCan')!;
    expect(newEbbc.id).not.toBe(ebbc.id);
    void newEbbc;

    g2.setEdges(applySavedEdgeLayout(g2.edges, saved.graphEdges, g2.nodes, saved.graphNodes) as never);

    // The rebuilt SBC→EBBCan wire (new endpoint ids) must carry the saved
    // routing + handles (re-read state — the g2 snapshot is stale)
    const g2fresh = m2.graph.getState();
    const newSbc = g2fresh.nodes.find((n) => (n.data as Record<string, unknown>).hardwareType === 'sbc')!;
    const newEbbc2 = g2fresh.nodes.find((n) => n.type === 'hardware' && (n.data as Record<string, unknown>).mcuName === 'EBBCan')!;
    const routed = g2fresh.edges.find((e) =>
      (e.data as Record<string, unknown>).edgeType === 'communication'
      && e.source === newSbc.id && e.target === newEbbc2.id);
    expect(routed).toBeDefined();
    const d = routed!.data as Record<string, unknown>;
    expect(d.customMiddlePoints).toEqual([{ x: 77, y: 88 }]);
    expect(routed!.sourceHandle).toBe('top');
    expect(routed!.targetHandle).toBe('bottom');
  });
});

// ── In-session rebuild (the clobber bug) ─────────────────────────────

describe('in-session full rebuild (reference-add / import / revert)', () => {
  it('full rebuild after adding a reference config preserves existing cards + positions', async () => {
    const m = await freshModules();
    // Seed the config store the way startup would (updateConfigFile path
    // is what TextEditor uses for the new reference file)
    m.config.getState().loadConfigs(TRIDENT_CONFIGS as never);
    m.graph.getState().clearGraph();
    m.buildProjectGraph(TRIDENT_CONFIGS, m.graph.getState(), SCHEMAS);
    arrangeAll(m);
    const before = m.graph.getState().nodes.map((n) => ({ ...n, data: { ...n.data } }));
    const saved = buildLayoutPayload(m.graph.getState().nodes, m.graph.getState().edges, null);
    const beforeCount = m.graph.getState().nodes.length;

    // The FIXED reference-add path: updateConfigFile(new file) + clearGraph
    // + buildProjectGraph over ALL files (NOT syncGraphWithConfig, which
    // can't recreate deleted hardware nodes)
    const referenceFile: ConfigFile = {
      filename: 'reference.cfg',
      // Real reference configs carry their own [mcu] section — that's what
      // turns the file into a board in the graph
      sections: [
        sec('mcu', 'mcu refmcu', 'refmcu'),
        sec('output_pin', 'output_pin: ref'),
      ],
      includes: [],
      header_comments: [],
      raw_text: '',
    };
    m.config.getState().updateConfigFile('reference.cfg', referenceFile as never);
    const g = m.graph.getState();
    g.clearGraph();
    const cs = m.config.getState();
    m.buildProjectGraph(cs.configFiles, g, SCHEMAS, cs.validation);
    // Then re-apply the saved layout (restoreLayoutAfterRebuild in the app)
    const g2 = m.graph.getState();
    g2.setNodes(applySavedNodePositions(g2.nodes, saved.graphNodes) as never);
    g2.setEdges(applySavedEdgeLayout(g2.edges, saved.graphEdges, g2.nodes, saved.graphNodes) as never);
    // Re-read state — the g2 snapshot is stale after setNodes/setEdges
    const g2fresh = m.graph.getState();

    // Nothing was wiped: every pre-existing card is back with its saved
    // position (and new cards don't squat on saved spots)
    checkPositionsRestored(before, g2fresh.nodes);
    // …and the new file's board is present
    expect(g2fresh.nodes.length).toBeGreaterThan(beforeCount);
    expect(g2fresh.nodes.some((n) => n.type === 'hardware' && (n.data as Record<string, unknown>).mcuName === 'refmcu')).toBe(true);
  });

  it('documents why the OLD reference-add path emptied the canvas', async () => {
    const m = await freshModules();
    m.config.getState().loadConfigs(TRIDENT_CONFIGS as never);
    m.graph.getState().clearGraph();
    m.buildProjectGraph(TRIDENT_CONFIGS, m.graph.getState(), SCHEMAS);
    expect(m.graph.getState().nodes.length).toBeGreaterThan(0);

    // OLD path: clearGraph + syncGraphWithConfig(newFile)
    m.graph.getState().clearGraph();
    m.graph.getState().syncGraphWithConfig('printer.cfg');
    expect(m.graph.getState().nodes.length).toBe(0);
  });
});
