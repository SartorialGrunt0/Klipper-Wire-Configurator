import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/api', () => ({
  parseConfigText: vi.fn(async (text: string, file: string) => ({
    config: {
      filename: file,
      raw_text: text,
      sections: text.split('\n').flatMap((line, i) => {
        const m = line.match(/^\[([^\]]+)\]/);
        if (!m) return [];
        const [type, ...rest] = m[1].trim().split(/\s+/);
        const name = rest.join(' ');
        const fullHeader = name ? `${type} ${name}` : type;
        return [{
          section_type: type,
          section_name: name,
          full_header: fullHeader,
          line_number: i + 1,
          params: [],
          header_comments: [],
          trailing_comments: [],
          is_commented_out: false,
        }];
      }),
      includes: text.split('\n').flatMap((line) => {
        const m = line.match(/^\[include\s+([^\]]+)\]/);
        return m ? [m[1].trim()] : [];
      }),
      header_comments: [],
    },
  })),
  exportConfig: vi.fn(async (cf: { raw_text?: string }) => cf.raw_text ?? ''),
  validateConfig: vi.fn(async () => ({ has_errors: false, has_warnings: false, errors: [] })),
  validateProject: vi.fn(async () => ({})),
  loadNativeLayout: vi.fn(async () => ({ layout: null })),
  saveNativeLayout: vi.fn(async () => undefined),
}));

import type { ConfigFile } from '@/types/config';
import type { AppNode } from '@/types/graph';
import { rebuildProjectGraph, syncGraphForFile } from '@/services/graphSync';
import { applyStagedEdits } from '@/services/changeSetReview';
import { ledgerFor, undoRun } from '@/services/reviewEngine';
import { useChangeSetStore } from '@/stores/changeSetStore';
import { useConfigStore } from '@/stores/configStore';
import { useGraphStore } from '@/stores/graphStore';

/**
 * Graph sync for model-level writes (Sir, 2026-10-11): an AI edit that adds
 * a section lands in the config MODEL via applyStagedEdits, and a keep is a
 * pure frame fold — neither path ever called syncGraphWithConfig (its only
 * caller was the text editor's real-user-edit branch), so the new section
 * had no card until a hand edit or a full rebuild rescued it. These tests
 * pin the reported scenario: stage `[gcode_arcs]` → a feature card exists.
 */

const L = (...lines: string[]) => lines.join('\n');

const cfgFromFile = (filename: string, text: string): ConfigFile => {
  const parsed = { sections: [] as ConfigFile['sections'], includes: [] as string[] };
  text.split('\n').forEach((line, i) => {
    const m = line.match(/^\[([^\]]+)\]/);
    if (!m) return;
    const [type, ...rest] = m[1].trim().split(/\s+/);
    const name = rest.join(' ');
    parsed.sections.push({
      section_type: type,
      section_name: type === 'include' ? '' : name,
      full_header: name ? `${type} ${name}` : type,
      line_number: i + 1,
      params: [],
      header_comments: [],
      trailing_comments: [],
      is_commented_out: false,
    });
    if (type === 'include' && name) parsed.includes.push(name);
  });
  return {
    filename,
    sections: parsed.sections,
    includes: parsed.includes,
    header_comments: [],
    raw_text: text,
  };
};

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
      isPrimary: true,
      ...overrides,
    },
  } as AppNode;
}

/** Seed the store + a minimal graph (mainboard + SBC) for a printer.cfg. */
function seedPrinterWithGraph(text: string) {
  const file = cfgFromFile('printer.cfg', text);
  useConfigStore.setState({
    configFiles: { 'printer.cfg': file },
    liveTexts: {},
    originalTexts: {},
    activeFile: 'printer.cfg',
    isDirty: false,
  });
  useGraphStore.setState({
    nodes: [
      makeHwNode('sbc', { hardwareType: 'sbc', configFile: 'printer.cfg', mcuName: 'host_mcu', isPrimary: false }),
      makeHwNode('mainboard', {}),
    ],
    edges: [],
    selectedNodeId: null,
  });
  return file;
}

const sectionCards = (header: string) =>
  useGraphStore.getState().nodes.filter((n) => {
    const d = n.data as Record<string, unknown>;
    return (n.type === 'subComponent' || n.type === 'feature') && d.sectionHeader === header;
  });

beforeEach(() => {
  vi.clearAllMocks();
  useChangeSetStore.getState().clear();
  useGraphStore.setState({ nodes: [], edges: [], selectedNodeId: null });
  useConfigStore.setState({
    configFiles: {},
    liveTexts: {},
    originalTexts: {},
    activeFile: 'printer.cfg',
    isDirty: false,
    validation: {},
  });
});

describe('syncGraphForFile', () => {
  it('a new FEATURE section in a synced file gets a card (the gcode_arcs bug)', () => {
    seedPrinterWithGraph(L('[mcu]', 'serial: /dev/ttyUSB0', '', '[printer]', 'kinematics: cartesian'));
    expect(sectionCards('gcode_arcs')).toHaveLength(0);

    // The model gains [gcode_arcs] exactly the way applyStagedEdits does it.
    useConfigStore.getState().updateConfigFile('printer.cfg',
      cfgFromFile('printer.cfg', L('[mcu]', 'serial: /dev/ttyUSB0', '', '[printer]', 'kinematics: cartesian', '', '[gcode_arcs]', 'resolution: 1.0')));
    syncGraphForFile('printer.cfg');

    const cards = sectionCards('gcode_arcs');
    expect(cards).toHaveLength(1);
    expect(cards[0].type).toBe('feature');
    // The card belongs to the mainboard, and no hardware node was invented.
    expect(cards[0].parentId).toBe('mainboard');
    expect(useGraphStore.getState().nodes.filter((n) => n.type === 'hardware')).toHaveLength(2);
  });

  it('a new SUB-COMPONENT section also gets a card', () => {
    seedPrinterWithGraph(L('[mcu]', 'serial: /dev/ttyUSB0', '', '[printer]', 'kinematics: cartesian'));
    useConfigStore.getState().updateConfigFile('printer.cfg',
      cfgFromFile('printer.cfg', L('[mcu]', 'serial: /dev/ttyUSB0', '', '[printer]', 'kinematics: cartesian', '', '[heater_generic chamber]', 'heater: heater_bed')));
    syncGraphForFile('printer.cfg');
    expect(sectionCards('heater_generic chamber')).toHaveLength(1);
  });

  it('is idempotent — syncing twice never duplicates the card', () => {
    seedPrinterWithGraph(L('[mcu]', 'serial: /dev/ttyUSB0'));
    useConfigStore.getState().updateConfigFile('printer.cfg',
      cfgFromFile('printer.cfg', L('[mcu]', 'serial: /dev/ttyUSB0', '', '[gcode_arcs]', 'resolution: 1.0')));
    syncGraphForFile('printer.cfg');
    syncGraphForFile('printer.cfg');
    expect(sectionCards('gcode_arcs')).toHaveLength(1);
  });

  it('a file with NO hardware node of its own takes the full-rebuild path', () => {
    seedPrinterWithGraph(L('[mcu]', 'serial: /dev/ttyUSB0'));
    const before = useGraphStore.getState().nodes.length;
    // A brand-new file that carries its own [mcu] — sync cannot place it.
    const created = cfgFromFile('toolhead.cfg', L('[mcu EBBCan]', 'canbus_uuid: abc'));
    useConfigStore.setState({ configFiles: { ...useConfigStore.getState().configFiles, 'toolhead.cfg': created } });
    syncGraphForFile('toolhead.cfg');
    const nodes = useGraphStore.getState().nodes;
    expect(nodes.filter((n) => n.type === 'hardware' && (n.data as Record<string, unknown>).configFile === 'toolhead.cfg')).toHaveLength(1);
    expect(before).toBeLessThan(nodes.length);
  });
});

describe('applyStagedEdits keeps the graph current', () => {
  it("staging an AI edit that adds [gcode_arcs] creates its card WITHOUT a hand edit", async () => {
    seedPrinterWithGraph(L('[mcu]', 'serial: /dev/ttyUSB0', '', '[printer]', 'kinematics: cartesian'));
    const newText = L('[mcu]', 'serial: /dev/ttyUSB0', '', '[printer]', 'kinematics: cartesian', '', '[gcode_arcs]', 'resolution: 1.0');
    const failed = await applyStagedEdits([{ file: 'printer.cfg', op: 'update', summary: '', newText }]);
    expect(failed).toEqual([]);
    const cards = sectionCards('gcode_arcs');
    expect(cards).toHaveLength(1);
    expect(cards[0].type).toBe('feature');
  });

  it('deleting a file through a staged edit drops its cards, keeping the rest of the graph', async () => {
    const printer = cfgFromFile('printer.cfg', L('[mcu]', 'serial: /dev/ttyUSB0', '', '[include extras.cfg]'));
    const extras = cfgFromFile('extras.cfg', L('[mcu EBBCan]', 'canbus_uuid: abc', '', '[neopixel myled]', 'pin: PB0'));
    useConfigStore.setState({
      configFiles: { 'printer.cfg': printer, 'extras.cfg': extras },
      activeFile: 'printer.cfg',
    });
    useGraphStore.setState({
      nodes: [
        makeHwNode('mainboard', {}),
        makeHwNode('ebbcan', { hardwareType: 'toolhead', configFile: 'extras.cfg', mcuName: 'EBBCan', isPrimary: false }),
        {
          id: 'ledcard',
          type: 'subComponent',
          position: { x: 0, y: 0 },
          parentId: 'ebbcan',
          data: {
            label: 'neopixel', sectionType: 'neopixel', sectionHeader: 'neopixel myled',
            sectionLineNumber: 4, componentGroup: 'led', configFile: 'extras.cfg',
            section: extras.sections[1], hasErrors: false,
          },
        } as unknown as AppNode,
      ],
      edges: [],
    });

    const failed = await applyStagedEdits([{ file: 'extras.cfg', op: 'delete_file', summary: '', newText: '' }]);
    expect(failed).toEqual([]);

    const nodes = useGraphStore.getState().nodes;
    const stillOwning = (f: string) => nodes.filter((n) => (n.data as Record<string, unknown>).configFile === f);
    expect(stillOwning('extras.cfg')).toHaveLength(0);
    expect(nodes.filter((n) => n.type === 'hardware' && (n.data as Record<string, unknown>).configFile === 'printer.cfg').length).toBeGreaterThanOrEqual(1);
    expect(useConfigStore.getState().configFiles['extras.cfg']).toBeUndefined();
  });

  it('deleting the LAST config file empties the graph instead of leaving stale cards', async () => {
    seedPrinterWithGraph(L('[mcu]', 'serial: /dev/ttyUSB0', '', '[gcode_arcs]', 'resolution: 1.0'));
    const failed = await applyStagedEdits([{ file: 'printer.cfg', op: 'delete_file', summary: '', newText: '' }]);
    expect(failed).toEqual([]);
    expect(useGraphStore.getState().nodes).toHaveLength(0);
  });

  it('an empty-content config with an existing hardware node syncs incrementally, never rebuilding', async () => {
    // The hardware node for the file exists, so the sync must take the
    // per-file path: no clearGraph, no rebuild, nothing hand-placed is lost.
    seedPrinterWithGraph('');
    const custom: AppNode = {
      id: 'custom-hw',
      type: 'hardware',
      position: { x: 0, y: 0 },
      data: { label: 'hand node', hardwareType: 'mainboard', configFile: 'printer.cfg', mcuName: '', sections: [], hasErrors: false, isPrimary: true },
    } as unknown as AppNode;
    useGraphStore.setState({ nodes: [custom], edges: [] });

    const failed = await applyStagedEdits([{ file: 'printer.cfg', op: 'update', summary: '', newText: 'X' }]);
    expect(failed).toEqual([]);
    // The model took the text...
    expect(useConfigStore.getState().configFiles['printer.cfg'].raw_text).toBe('X');
    // ...and the graph survived intact (nothing recognized → no rebuild).
    expect(useGraphStore.getState().nodes.map((n) => n.id)).toEqual(['custom-hw']);
  });
});

describe('undoing a review-created file removes its graph cards', () => {
  it('the created file was rebuilt away; the rest of the project survives', async () => {
    const printer = cfgFromFile('printer.cfg', L('[mcu]', 'serial: /dev/ttyUSB0'));
    const extras = cfgFromFile('extras.cfg', L('[gcode_macro NEWCARD]', 'gcode:', '  G28'));
    useConfigStore.setState({
      configFiles: { 'printer.cfg': printer, 'extras.cfg': extras },
      liveTexts: { 'extras.cfg': extras.raw_text ?? '' },
      activeFile: 'printer.cfg',
    });
    // The review sees extras.cfg as CREATED (frame null): its whole body is one run.
    useChangeSetStore.setState({ reviewFrames: { 'extras.cfg': null } });
    // The staging already reached the graph — extras has its own cards.
    useGraphStore.setState({
      nodes: [
        makeHwNode('mainboard', {}),
        makeHwNode('extrashw', { hardwareType: 'expander', configFile: 'extras.cfg', mcuName: 'x', isPrimary: false }),
        {
          id: 'macrocard',
          type: 'feature',
          position: { x: 0, y: 0 },
          parentId: 'extrashw',
          data: {
            label: 'gcode_macro', sectionType: 'gcode_macro', sectionHeader: 'gcode_macro NEWCARD',
            sectionLineNumber: 1, componentGroup: 'gcode_macro', configFile: 'extras.cfg',
            section: extras.sections[0], hasErrors: false,
          },
        } as unknown as AppNode,
      ],
      edges: [],
    });

    const [run] = ledgerFor('extras.cfg');
    expect(run).toBeDefined();
    await undoRun('extras.cfg', run.key);

    expect(useConfigStore.getState().configFiles['extras.cfg']).toBeUndefined();
    const nodes = useGraphStore.getState().nodes;
    expect(nodes.filter((n) => (n.data as Record<string, unknown>).configFile === 'extras.cfg')).toHaveLength(0);
    expect(nodes.some((n) => n.type === 'hardware' && (n.data as Record<string, unknown>).configFile === 'printer.cfg')).toBe(true);
  });
});

describe('rebuildProjectGraph', () => {
  it('replaces the whole graph from the current config store', () => {
    seedPrinterWithGraph(L('[mcu]', 'serial: /dev/ttyUSB0'));
    // Stale junk that no config justifies.
    useGraphStore.getState().addNode(makeHwNode('ghost', { configFile: 'gone.cfg', isPrimary: false }));
    rebuildProjectGraph();
    const nodes = useGraphStore.getState().nodes;
    expect(nodes.some((n) => n.id === 'ghost')).toBe(false);
    expect(nodes.length).toBeGreaterThan(0);
  });
});
