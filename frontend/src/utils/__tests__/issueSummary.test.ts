import { describe, it, expect } from 'vitest';
import {
  worstSeverity,
  lineSeverities,
  summariseIssues,
  filterIssuesBySeverity,
  HOVER_MESSAGE_CAP,
  type IssueLike,
} from '../issueSummary';

const issue = (line: number, severity: IssueLike['severity'], text = 'msg'): IssueLike => ({
  line,
  severity,
  text,
});

describe('worstSeverity', () => {
  it('prefers error over warning over info regardless of order', () => {
    expect(worstSeverity(['info', 'warning', 'error'])).toBe('error');
    expect(worstSeverity(['error', 'warning', 'info'])).toBe('error');
    expect(worstSeverity(['info', 'warning'])).toBe('warning');
    expect(worstSeverity(['info'])).toBe('info');
  });

  it('returns null for no findings', () => {
    expect(worstSeverity([])).toBeNull();
  });
});

describe('lineSeverities', () => {
  it('maps each line to its worst severity', () => {
    const map = lineSeverities([issue(3, 'info'), issue(3, 'error'), issue(7, 'warning')]);
    expect(map.get(3)).toBe('error');
    expect(map.get(7)).toBe('warning');
    expect(map.size).toBe(2);
  });

  it('drops file-level findings (line 0) that have no line to colour', () => {
    expect(lineSeverities([issue(0, 'error')]).size).toBe(0);
  });
});

describe('summariseIssues', () => {
  it('returns one entry per present severity, worst first', () => {
    const summaries = summariseIssues([issue(1, 'info'), issue(2, 'error'), issue(3, 'warning')]);
    expect(summaries.map((s) => s.severity)).toEqual(['error', 'warning', 'info']);
  });

  it('omits severities with no findings', () => {
    expect(summariseIssues([issue(4, 'warning')]).map((s) => s.severity)).toEqual(['warning']);
  });

  it('returns nothing for no findings', () => {
    expect(summariseIssues([])).toEqual([]);
  });

  it('counts findings, not lines', () => {
    const summaries = summariseIssues([issue(5, 'error'), issue(5, 'error', 'other'), issue(9, 'error')]);
    expect(summaries[0].count).toBe(3);
  });

  it('lists distinct lines ascending and excludes file-level findings', () => {
    const summaries = summariseIssues([issue(9, 'error'), issue(0, 'error'), issue(5, 'error'), issue(5, 'error')]);
    expect(summaries[0].lines).toEqual([5, 9]);
    expect(summaries[0].count).toBe(4);
  });

  it('builds a hover title with the heading and per-line messages', () => {
    const summaries = summariseIssues([issue(12, 'error', 'Unknown option max_accell')]);
    expect(summaries[0].title).toBe('1 error\nLine 12: Unknown option max_accell');
  });

  it('pluralises the heading', () => {
    expect(summariseIssues([issue(1, 'warning'), issue(2, 'warning')])[0].title.split('\n')[0]).toBe('2 warnings');
  });

  it('de-duplicates identical messages and keeps the first line seen', () => {
    const summaries = summariseIssues([
      issue(3, 'info', 'duplicate section'),
      issue(40, 'info', 'duplicate section'),
    ]);
    expect(summaries[0].count).toBe(2);
    expect(summaries[0].messages).toEqual(['duplicate section']);
    expect(summaries[0].title).toBe('2 infos\nLine 3: duplicate section');
  });

  it('shows a file-level finding message without a line prefix', () => {
    expect(summariseIssues([issue(0, 'warning', 'missing include')])[0].title).toBe(
      '1 warning\nmissing include',
    );
  });

  it('caps the hover list and reports the overflow', () => {
    const many = Array.from({ length: HOVER_MESSAGE_CAP + 5 }, (_, i) => issue(i + 1, 'error', `msg ${i}`));
    const summary = summariseIssues(many)[0];
    expect(summary.messages).toHaveLength(HOVER_MESSAGE_CAP);
    expect(summary.overflow).toBe(5);
    expect(summary.title).toContain('…and 5 more');
    expect(summary.count).toBe(HOVER_MESSAGE_CAP + 5);
  });

  it('does not report overflow at exactly the cap', () => {
    const many = Array.from({ length: HOVER_MESSAGE_CAP }, (_, i) => issue(i + 1, 'error', `msg ${i}`));
    const summary = summariseIssues(many)[0];
    expect(summary.overflow).toBe(0);
    expect(summary.title).not.toContain('more');
  });
});

describe('filterIssuesBySeverity', () => {
  const issues = [issue(1, 'error'), issue(2, 'warning'), issue(3, 'info')];

  it('keeps only the enabled severities', () => {
    expect(filterIssuesBySeverity(issues, new Set(['error'])).map((i) => i.line)).toEqual([1]);
    expect(filterIssuesBySeverity(issues, new Set(['error', 'info'])).map((i) => i.line)).toEqual([1, 3]);
  });

  it('returns nothing when everything is switched off', () => {
    expect(filterIssuesBySeverity(issues, new Set())).toEqual([]);
  });

  it('preserves extra fields on the input objects', () => {
    const rich = [{ ...issue(1, 'error'), code: 'unknown_param' }];
    expect(filterIssuesBySeverity(rich, new Set(['error']))[0].code).toBe('unknown_param');
  });
});
