import { describe, it, expect } from 'vitest';
import { buildConfigTree, ancestorIds, defaultExpansion, type ConfigTreeInput } from '../configTree';
import { ALL_VISIBLE } from '../validationVisibility';
import type { ValidationError } from '../../types/config';

const err = (severity: ValidationError['severity'], section = '', message = 'msg'): ValidationError => ({
  severity,
  section,
  param: '',
  message,
  line_number: 1,
});

function input(overrides: Partial<ConfigTreeInput> = {}): ConfigTreeInput {
  return {
    filenames: ['printer.cfg'],
    texts: { 'printer.cfg': '[stepper_x]\nmicrosteps: 16\n' },
    activeFile: 'printer.cfg',
    validation: {},
    visibility: ALL_VISIBLE,
    ...overrides,
  };
}

const filesOf = (nodes: ReturnType<typeof buildConfigTree>) =>
  nodes.filter((n) => n.kind === 'file').map((n) => n.label);

describe('buildConfigTree — files and folders', () => {
  it('has no folder nodes for a flat project', () => {
    const tree = buildConfigTree(input({ filenames: ['printer.cfg', 'macros.cfg'] }));
    expect(tree.every((node) => node.kind === 'file')).toBe(true);
    expect(filesOf(tree)).toEqual(['macros.cfg', 'printer.cfg']);
  });

  it('groups a nested project into folders, folders first', () => {
    const tree = buildConfigTree(
      input({ filenames: ['printer.cfg', 'macros/start.cfg', 'macros/end.cfg'] }),
    );
    expect(tree.map((node) => node.kind)).toEqual(['folder', 'file']);
    expect(tree[0].label).toBe('macros');
    expect(filesOf(tree[0].children)).toEqual(['end.cfg', 'start.cfg']);
  });

  it('keeps deeper nesting', () => {
    const tree = buildConfigTree(input({ filenames: ['a/b/c.cfg'] }));
    expect(tree[0].label).toBe('a');
    expect(tree[0].children[0].label).toBe('b');
    expect(tree[0].children[0].children[0].label).toBe('c.cfg');
    expect(tree[0].children[0].children[0].file).toBe('a/b/c.cfg');
  });

  it('keeps same-named files in different folders distinct', () => {
    const tree = buildConfigTree(input({ filenames: ['a/macros.cfg', 'b/macros.cfg'] }));
    const ids = tree.flatMap((folder) => folder.children.map((file) => file.id));
    expect(new Set(ids).size).toBe(2);
  });

  it('gives every node a unique id', () => {
    const tree = buildConfigTree(
      input({
        filenames: ['printer.cfg', 'macros/start.cfg'],
        texts: { 'printer.cfg': '[a]\nx: 1\n[b]\ny: 2' },
      }),
    );
    const ids: string[] = [];
    const walk = (nodes: ReturnType<typeof buildConfigTree>) => {
      for (const node of nodes) {
        ids.push(node.id);
        walk(node.children);
      }
    };
    walk(tree);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('buildConfigTree — sections and params', () => {
  it('carries section line numbers and their params', () => {
    const tree = buildConfigTree(input());
    const file = tree[0];
    expect(file.children[0].label).toBe('stepper_x');
    expect(file.children[0].line).toBe(1);
    expect(file.children[0].children).toEqual([
      expect.objectContaining({ kind: 'param', label: 'microsteps', line: 2, file: 'printer.cfg' }),
    ]);
  });

  it('marks commented sections', () => {
    const tree = buildConfigTree(input({ texts: { 'printer.cfg': '#[probe]\nz_offset: 1' } }));
    expect(tree[0].children[0].isCommented).toBe(true);
    expect(tree[0].children[0].children).toEqual([]);
  });

  it('handles a file with no text (not yet loaded)', () => {
    const tree = buildConfigTree(input({ filenames: ['printer.cfg', 'extra.cfg'], texts: {} }));
    const extra = tree.find((node) => node.label === 'extra.cfg')!;
    expect(extra.children).toEqual([]);
  });
});

describe('buildConfigTree — severity dots', () => {
  it('marks a file with its worst visible finding', () => {
    const tree = buildConfigTree(
      input({ validation: { 'printer.cfg': { errors: [err('warning'), err('error')] } } }),
    );
    expect(tree[0].severity).toBe('error');
  });

  it('marks sections by their own findings', () => {
    const tree = buildConfigTree(
      input({
        texts: { 'printer.cfg': '[stepper_x]\nx: 1\n[extruder]\ny: 2' },
        validation: { 'printer.cfg': { errors: [err('warning', 'extruder')] } },
      }),
    );
    expect(tree[0].children[0].severity).toBeNull();
    expect(tree[0].children[1].severity).toBe('warning');
  });

  it('leaves clean files and sections unmarked', () => {
    expect(buildConfigTree(input())[0].severity).toBeNull();
  });

  it('ignores info findings — those only appear on the line gutter', () => {
    const tree = buildConfigTree(
      input({
        texts: { 'printer.cfg': '[stepper_x]\nx: 1\n[extruder]\ny: 2' },
        validation: {
          'printer.cfg': { errors: [err('info'), err('info', 'extruder'), err('warning', 'stepper_x')] },
        },
      }),
    );
    expect(tree[0].severity).toBe('warning');
    expect(tree[0].children[0].severity).toBe('warning');
    expect(tree[0].children[1].severity).toBeNull();
  });

  it('respects the validation visibility settings', () => {
    const hidden = { enabled: true, showError: true, showWarning: false, showInfo: false };
    const tree = buildConfigTree(
      input({
        validation: { 'printer.cfg': { errors: [err('warning')] } },
        visibility: hidden,
      }),
    );
    expect(tree[0].severity).toBeNull();
  });
});

describe('ancestorIds / defaultExpansion', () => {
  const tree = buildConfigTree(input({ filenames: ['printer.cfg', 'a/b/other.cfg'] }));

  it('returns the folder chain for a nested file', () => {
    expect(ancestorIds(tree, 'a/b/other.cfg')).toEqual(['folder:a', 'folder:a/b']);
  });

  it('returns nothing for a top-level file', () => {
    expect(ancestorIds(tree, 'printer.cfg')).toEqual([]);
  });

  it('returns nothing for an unknown file', () => {
    expect(ancestorIds(tree, 'nope.cfg')).toEqual([]);
  });

  it('expands the folders on the way to the active file, and only those', () => {
    const expansion = defaultExpansion(tree, 'a/b/other.cfg');
    expect(expansion).toEqual({ 'folder:a': true, 'folder:a/b': true });
  });

  it('leaves the active file itself folded — its sections open on request', () => {
    const expansion = defaultExpansion(tree, 'printer.cfg');
    expect(expansion).toEqual({});
    expect(defaultExpansion(tree, 'a/b/other.cfg')).not.toHaveProperty('file:a/b/other.cfg');
  });
});
