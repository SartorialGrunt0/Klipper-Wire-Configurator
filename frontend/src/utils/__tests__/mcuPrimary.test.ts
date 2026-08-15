import { describe, it, expect } from 'vitest';
import {
  demotedConfigFilename,
  mcuHeaderFor,
  renameMcuSections,
  applyMcuRenameToFiles,
  planPrimarySwap,
  type PlanNode,
} from '../mcuPrimary';
import type { ConfigFile } from '../../types/config';

function makeFile(filename: string, sections: ConfigFile['sections']): ConfigFile {
  return { filename, sections, includes: [], header_comments: [] };
}

function mcuSection(name: string, extraParams: Array<{ key: string; value: string }> = []): ConfigFile['sections'][number] {
  return {
    section_type: 'mcu',
    section_name: name,
    full_header: name ? `mcu ${name}` : 'mcu',
    line_number: 1,
    params: [
      { key: 'serial', value: '/dev/ttyACM0', is_commented_out: false, comment: '', separator: ':' },
      ...extraParams.map((p) => ({ ...p, is_commented_out: false, comment: '', separator: ':' })),
    ],
    header_comments: [],
    trailing_comments: [],
    is_commented_out: false,
  };
}

describe('demotedConfigFilename', () => {
  it('lowercases and underscores the mcu name', () => {
    expect(demotedConfigFilename('Main Board')).toBe('main_board.cfg');
  });

  it('handles single-word names', () => {
    expect(demotedConfigFilename('toolhead')).toBe('toolhead.cfg');
  });
});

describe('mcuHeaderFor', () => {
  it('returns bare [mcu] for empty name (primary)', () => {
    expect(mcuHeaderFor('')).toBe('mcu');
  });

  it('returns [mcu name] for named mcus', () => {
    expect(mcuHeaderFor('toolhead')).toBe('mcu toolhead');
  });
});

describe('renameMcuSections', () => {
  it('renames the mcu section header and rewrites pin prefixes', () => {
    const sections = [
      mcuSection('mainboard'),
      {
        section_type: 'stepper_x', section_name: '', full_header: 'stepper_x', line_number: 2,
        params: [{ key: 'step_pin', value: 'mainboard:PA0', is_commented_out: false, comment: '', separator: ':' }],
        header_comments: [], trailing_comments: [], is_commented_out: false,
      },
    ];
    const out = renameMcuSections(sections, 'mainboard', 'toolhead');
    expect(out[0].full_header).toBe('mcu toolhead');
    expect(out[0].section_name).toBe('toolhead');
    expect(out[1].params[0].value).toBe('toolhead:PA0');
  });

  it('promoting to primary strips the mcu name', () => {
    const sections = [mcuSection('toolhead')];
    const out = renameMcuSections(sections, 'toolhead', '');
    expect(out[0].full_header).toBe('mcu');
    expect(out[0].section_name).toBe('');
  });

  it('leaves unrelated sections untouched', () => {
    const sections = [mcuSection('toolhead'), mcuSection('expander')];
    const out = renameMcuSections(sections, 'toolhead', '');
    expect(out[1].full_header).toBe('mcu expander');
    expect(out[1].section_name).toBe('expander');
  });
});

describe('applyMcuRenameToFiles', () => {
  it('updates the target file and each listed child file, leaving others untouched', () => {
    const files: Record<string, ConfigFile> = {
      'printer.cfg': makeFile('printer.cfg', [
        mcuSection('mainboard'),
        {
          section_type: 'stepper_x', section_name: '', full_header: 'stepper_x', line_number: 2,
          params: [{ key: 'step_pin', value: 'mainboard:PA0', is_commented_out: false, comment: '', separator: ':' }],
          header_comments: [], trailing_comments: [], is_commented_out: false,
        },
      ]),
      'toolhead_board.cfg': makeFile('toolhead_board.cfg', [
        mcuSection('toolhead'),
        {
          section_type: 'extruder', section_name: '', full_header: 'extruder', line_number: 2,
          params: [{ key: 'step_pin', value: 'mainboard:PB0', is_commented_out: false, comment: '', separator: ':' }],
          header_comments: [], trailing_comments: [], is_commented_out: false,
        },
      ]),
      'other.cfg': makeFile('other.cfg', [mcuSection('expander')]),
    };

    const out = applyMcuRenameToFiles(files, 'printer.cfg', ['toolhead_board.cfg'], 'mainboard', 'spider', {});
    expect(out['printer.cfg'].sections[0].full_header).toBe('mcu spider');
    expect(out['printer.cfg'].sections[1].params[0].value).toBe('spider:PA0');
    expect(out['toolhead_board.cfg'].sections[1].params[0].value).toBe('spider:PB0');
    // Unlisted file is untouched
    expect(out['other.cfg'].sections[0].full_header).toBe('mcu expander');
    // Original record is not mutated
    expect(files['printer.cfg'].sections[0].full_header).toBe('mcu mainboard');
  });
});

describe('planPrimarySwap', () => {
  const nodes = [
    { id: 'mainboard', parentId: null, data: { configFile: 'printer.cfg' } },
    { id: 'toolhead', parentId: null, data: { configFile: 'toolhead_board.cfg' } },
    // children of the old primary
    { id: 'c1', parentId: 'mainboard', data: { configFile: 'printer.cfg' } },
    { id: 'c2', parentId: 'toolhead', data: { configFile: 'toolhead_board.cfg' } },
  ];

  it('renames old primary file to {name}.cfg and new primary file to printer.cfg, with child updates', () => {
    const plan = planPrimarySwap({
      oldPrimaryId: 'mainboard',
      oldMcuName: 'mainboard',
      newPrimaryId: 'toolhead',
      newConfigFile: 'toolhead_board.cfg',
      nodes,
    });
    expect(plan.renames).toEqual([
      { from: 'printer.cfg', to: 'mainboard.cfg' },
      { from: 'toolhead_board.cfg', to: 'printer.cfg' },
    ]);
    expect(plan.nodeUpdates).toContainEqual({ nodeId: 'mainboard', configFile: 'mainboard.cfg' });
    expect(plan.nodeUpdates).toContainEqual({ nodeId: 'c1', configFile: 'mainboard.cfg' });
    expect(plan.nodeUpdates).toContainEqual({ nodeId: 'toolhead', configFile: 'printer.cfg' });
    expect(plan.nodeUpdates).toContainEqual({ nodeId: 'c2', configFile: 'printer.cfg' });
  });

  it('skips the old-primary rename when there is no old primary', () => {
    const plan = planPrimarySwap({
      oldPrimaryId: null,
      oldMcuName: '',
      newPrimaryId: 'toolhead',
      newConfigFile: 'toolhead_board.cfg',
      nodes,
    });
    expect(plan.renames).toEqual([{ from: 'toolhead_board.cfg', to: 'printer.cfg' }]);
  });

  it('skips the new-primary rename when it is already printer.cfg', () => {
    const plan = planPrimarySwap({
      oldPrimaryId: null,
      oldMcuName: '',
      newPrimaryId: 'mainboard',
      newConfigFile: 'printer.cfg',
      nodes,
    });
    expect(plan.renames).toEqual([]);
    expect(plan.nodeUpdates).toEqual([]);
  });

  it('repoints group children whose configFile matches a renamed file', () => {
    // Group nodes carry their own configFile AND a children array where each
    // child also records its configFile. Both must be repointed when the file
    // is renamed, or clicking a group child resolves against a stale filename
    // and the sidebar shows nothing.
    const groupNode = {
      id: 'group1',
      type: 'group',
      parentId: 'mainboard',
      data: {
        configFile: 'printer.cfg',
        children: [
          { sectionHeader: 'bed_mesh', configFile: 'printer.cfg' },
          { sectionHeader: 'z_tilt', configFile: 'printer.cfg' },
        ],
      },
    };
    const plan = planPrimarySwap({
      oldPrimaryId: 'mainboard',
      oldMcuName: 'mainboard',
      newPrimaryId: 'toolhead',
      newConfigFile: 'toolhead_board.cfg',
      nodes: [...nodes, groupNode as unknown as PlanNode],
    });
    expect(plan.renames).toContainEqual({ from: 'printer.cfg', to: 'mainboard.cfg' });
    // The group node itself gets repointed…
    expect(plan.nodeUpdates).toContainEqual({ nodeId: 'group1', configFile: 'mainboard.cfg' });
    // …AND each child inside it.
    expect(plan.groupChildRenames).toContainEqual({ nodeId: 'group1', from: 'printer.cfg', to: 'mainboard.cfg' });
  });

  it('repoints ANY node referencing a renamed file, including standalone nodes', () => {
    // A standalone (parentless) sub-component may reference printer.cfg even
    // though it is not a child of the old primary — it must still be repointed.
    const standalone = {
      id: 'standalone1',
      type: 'subComponent',
      parentId: null,
      data: { configFile: 'printer.cfg', sectionHeader: 'probe' },
    };
    const plan = planPrimarySwap({
      oldPrimaryId: 'mainboard',
      oldMcuName: 'mainboard',
      newPrimaryId: 'toolhead',
      newConfigFile: 'toolhead_board.cfg',
      nodes: [...nodes, standalone as unknown as PlanNode],
    });
    expect(plan.nodeUpdates).toContainEqual({ nodeId: 'standalone1', configFile: 'mainboard.cfg' });
  });
});
