import { describe, expect, it } from 'vitest';
import { planApprovedEditApply } from '../approvalApply';
import type { PendingConfigEdit } from '../../services/api';

const edit = (file: string, op: string, newText: string): PendingConfigEdit => ({
  file, op, summary: `${op} ${file}`, newText,
});

describe('planApprovedEditApply', () => {
  it('plans a single upsert', () => {
    const plan = planApprovedEditApply([edit('printer.cfg', 'set_param', '[a]\n')]);
    expect(plan.upserts).toEqual([{ file: 'printer.cfg', newText: '[a]\n' }]);
    expect(plan.deletes).toEqual([]);
  });

  it('last edit for a file wins', () => {
    const plan = planApprovedEditApply([
      edit('printer.cfg', 'set_param', 'first'),
      edit('printer.cfg', 'set_param', 'second'),
    ]);
    expect(plan.upserts).toEqual([{ file: 'printer.cfg', newText: 'second' }]);
  });

  it('delete_file wins over an earlier upsert for the same file', () => {
    const plan = planApprovedEditApply([
      edit('macros.cfg', 'set_param', '[x]\n'),
      edit('macros.cfg', 'delete_file', ''),
    ]);
    expect(plan.upserts).toEqual([]);
    expect(plan.deletes).toEqual(['macros.cfg']);
  });

  it('upsert after delete for the same file wins', () => {
    const plan = planApprovedEditApply([
      edit('macros.cfg', 'delete_file', ''),
      edit('macros.cfg', 'new_file', '[y]\n'),
    ]);
    expect(plan.deletes).toEqual([]);
    expect(plan.upserts).toEqual([{ file: 'macros.cfg', newText: '[y]\n' }]);
  });

  it('multi-file chains keep every file once', () => {
    const plan = planApprovedEditApply([
      edit('printer.cfg', 'set_param', 'p2'),
      edit('macros.cfg', 'new_file', 'm1'),
      edit('printer.cfg', 'set_param', 'p3'),
    ]);
    expect(plan.deletes).toEqual([]);
    expect(plan.upserts).toEqual([
      { file: 'printer.cfg', newText: 'p3' },
      { file: 'macros.cfg', newText: 'm1' },
    ]);
  });

  it('ignores malformed entries and empty input', () => {
    const plan = planApprovedEditApply([
      null as unknown as PendingConfigEdit,
      { file: '', op: 'set_param', summary: '', newText: 'x' },
      { file: 'printer.cfg', op: 'set_param', summary: '' } as unknown as PendingConfigEdit,
    ]);
    expect(plan.upserts).toEqual([]);
    expect(plan.deletes).toEqual([]);
    expect(planApprovedEditApply([])).toEqual({ upserts: [], deletes: [] });
    expect(planApprovedEditApply(undefined as unknown as PendingConfigEdit[])).toEqual({ upserts: [], deletes: [] });
  });
});
