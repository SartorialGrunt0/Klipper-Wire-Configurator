import { describe, it, expect } from 'vitest';
import { buildReferenceIndex, searchReference, hitHeadings } from '../referenceSearch';
import { extractHeadings } from '../referenceDoc';

const DOC = [
  '# Configuration reference',
  '',
  'Intro line about max_accel.',
  '',
  '## [stepper_x]',
  '',
  '```ini',
  '[stepper_x]',
  'max_accel: 3000',
  '```',
  '',
  '### Parameters',
  '',
  '| `microsteps` | The number of microsteps. |',
  '',
  '## [extruder]',
  '',
  'Also uses max_accel.',
  '',
  '## [stepper_x]',
  '',
  'A second stepper_x section.',
].join('\n');

describe('buildReferenceIndex', () => {
  const headings = extractHeadings(DOC);
  const index = buildReferenceIndex(DOC, headings);

  it('indexes every line once, in order', () => {
    expect(index).toHaveLength(DOC.split('\n').length);
    expect(index[0].line).toBe(1);
    expect(index[index.length - 1].line).toBe(DOC.split('\n').length);
  });

  it('attributes lines to their enclosing heading, heading line included', () => {
    const stepperLine = index.find((entry) => entry.text.startsWith('## [stepper_x]'));
    expect(stepperLine?.heading).toBe('[stepper_x]');
    expect(stepperLine?.headingId).toBe('stepper-x');
    // The intro sits under the h1, so it is attributed to it.
    expect(index.find((entry) => entry.text === 'Intro line about max_accel.')?.headingId).toBe(
      'configuration-reference',
    );
    // Before any heading at all there is nothing to attribute to.
    expect(buildReferenceIndex('loose text\n## [a]', extractHeadings('## [a]'))[0].headingId).toBe('');
  });

  it('keeps fenced code lines attributed to the section they sit in', () => {
    expect(index.find((entry) => entry.text === 'max_accel: 3000')?.headingId).toBe('stepper-x');
  });

  it('handles repeated headings with the renderer’s dedupe ids', () => {
    const last = index.find((entry) => entry.text === 'A second stepper_x section.');
    expect(last?.headingId).toBe('stepper-x-2');
    expect(last?.heading).toBe('[stepper_x]');
  });

  it('tracks sub-headings independently', () => {
    expect(index.find((entry) => entry.text.includes('microsteps') && entry.text.includes('|'))?.headingId).toBe(
      'parameters',
    );
  });

  it('returns an empty index for empty input', () => {
    expect(buildReferenceIndex('', [])).toEqual([{ line: 1, text: '', heading: '', headingId: '' }]);
  });

  it('normalises CRLF', () => {
    const crlf = buildReferenceIndex('## [a]\r\nvalue: 1\r\n', extractHeadings('## [a]\r\nvalue: 1\r\n'));
    expect(crlf.map((entry) => entry.text)).toEqual(['## [a]', 'value: 1', '']);
  });

  it('survives a heading array shorter than the document (defensive)', () => {
    const short = buildReferenceIndex(DOC, extractHeadings('## [a]'));
    expect(short).toHaveLength(DOC.split('\n').length);
  });
});

describe('searchReference', () => {
  const index = buildReferenceIndex(DOC, extractHeadings(DOC));

  it('finds hits case-insensitively with offsets', () => {
    const hits = searchReference(index, 'max_accel');
    expect(hits.map((hit) => hit.line)).toEqual([3, 9, 18]);
    expect(hits[0].matchStart).toBe(17);
    expect(hits[0].matchEnd).toBe(26);
  });

  it('reports every occurrence on a line', () => {
    const hits = searchReference(buildReferenceIndex('a b a b a', []), 'a');
    expect(hits).toHaveLength(3);
  });

  it('carries the heading so the UI can label and jump', () => {
    const hit = searchReference(index, 'microsteps')[0];
    expect(hit.heading).toBe('Parameters');
    expect(hit.headingId).toBe('parameters');
  });

  it('matches inside fenced code blocks too', () => {
    expect(searchReference(index, 'max_accel: 3000')).toHaveLength(1);
  });

  it('caps the number of hits', () => {
    const long = buildReferenceIndex(Array.from({ length: 50 }, () => 'x').join('\n'), []);
    expect(searchReference(long, 'x', 10)).toHaveLength(10);
  });

  it('returns nothing for an empty or whitespace query', () => {
    expect(searchReference(index, '')).toEqual([]);
    expect(searchReference(index, '   ')).toEqual([]);
  });

  it('returns nothing when nothing matches', () => {
    expect(searchReference(index, 'zzzz')).toEqual([]);
  });

  it('treats the query as literal text', () => {
    expect(searchReference(index, 'max.accel')).toEqual([]);
  });
});

describe('hitHeadings', () => {
  it('lists distinct headings in document order', () => {
    const index = buildReferenceIndex(DOC, extractHeadings(DOC));
    const hits = searchReference(index, 'stepper_x');
    expect(hitHeadings(hits).map((h) => h.id)).toEqual(['stepper-x', 'stepper-x-2']);
  });

  it('omits hits with no enclosing heading', () => {
    const headless = buildReferenceIndex('loose text', []);
    expect(hitHeadings(searchReference(headless, 'loose'))).toEqual([]);
  });
});
