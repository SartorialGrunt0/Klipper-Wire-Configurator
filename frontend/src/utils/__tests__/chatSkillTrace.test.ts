import { describe, expect, it } from 'vitest';
import { hasEditSkillLoad } from '../chatSkillTrace';
import type { ChatMessage } from '../../stores/aiStore';

/** Build a ChatMessage carrying an executed tool call trace. */
const msgWithCalls = (
  ...calls: Array<{ name: string; arguments: string }>
): ChatMessage => ({
  role: 'assistant',
  content: '',
  toolCalls: calls.map((c) => ({ ...c, output: '' })),
});

describe('hasEditSkillLoad', () => {
  it('returns true when load_skill(config-editing) ran', () => {
    expect(
      hasEditSkillLoad([
        msgWithCalls({ name: 'load_skill', arguments: '{"name":"config-editing"}' }),
      ]),
    ).toBe(true);
  });

  it('returns true for an empty-name load_skill (backend parity: empty defaults to the edit skill)', () => {
    expect(hasEditSkillLoad([msgWithCalls({ name: 'load_skill', arguments: '{}' })])).toBe(true);
  });

  it('returns false when only the printer-memory skill was loaded', () => {
    expect(
      hasEditSkillLoad([
        msgWithCalls({ name: 'load_skill', arguments: '{"name":"printer-memory"}' }),
      ]),
    ).toBe(false);
  });

  it('returns true on a mixed trace where the edit skill loaded among other calls', () => {
    expect(
      hasEditSkillLoad([
        msgWithCalls({ name: 'read_user_config', arguments: '{"file":"printer.cfg"}' }),
        msgWithCalls({ name: 'load_skill', arguments: '{"name":"printer-memory"}' }),
        msgWithCalls({ name: 'load_skill', arguments: '{"name":"config-editing"}' }),
      ]),
    ).toBe(true);
  });

  it('returns false for messages without any toolCalls', () => {
    expect(
      hasEditSkillLoad([
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi' },
      ]),
    ).toBe(false);
  });

  it('returns false for an empty toolCalls array', () => {
    expect(hasEditSkillLoad([{ role: 'assistant', content: '', toolCalls: [] }])).toBe(false);
  });

  it('returns false when non-skill tools ran but load_skill never did', () => {
    expect(
      hasEditSkillLoad([
        msgWithCalls({ name: 'config_edit', arguments: '{"op":"set_param"}' }),
        msgWithCalls({ name: 'validate_klipper_config', arguments: '{}' }),
      ]),
    ).toBe(false);
  });

  it('treats an unparseable arguments string on load_skill as an edit load (fail-open)', () => {
    expect(hasEditSkillLoad([msgWithCalls({ name: 'load_skill', arguments: '{"name":"conf' })])).toBe(
      true,
    );
  });

  it('scans across multiple messages, not just the last one', () => {
    expect(
      hasEditSkillLoad([
        msgWithCalls({ name: 'load_skill', arguments: '{"name":"config-editing"}' }),
        { role: 'user', content: 'now toggle the LED' },
        { role: 'assistant', content: 'done' },
      ]),
    ).toBe(true);
  });
});
