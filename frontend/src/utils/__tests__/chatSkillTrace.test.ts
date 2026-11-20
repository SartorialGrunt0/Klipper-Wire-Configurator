import { describe, expect, it } from 'vitest';
import { loadedSkillNames } from '../chatSkillTrace';
import type { ChatMessage } from '../../stores/aiStore';

/** Build a ChatMessage carrying an executed tool call trace. */
const msgWithCalls = (
  ...calls: Array<{ name: string; arguments: string }>
): ChatMessage => ({
  role: 'assistant',
  content: '',
  toolCalls: calls.map((c) => ({ ...c, output: '' })),
});

describe('loadedSkillNames', () => {
  it('names config-editing when load_skill(config-editing) ran', () => {
    expect(
      loadedSkillNames([
        msgWithCalls({ name: 'load_skill', arguments: '{"name":"config-editing"}' }),
      ]),
    ).toEqual(['config-editing']);
  });

  it('maps an empty-name load_skill to config-editing (backend parity)', () => {
    expect(loadedSkillNames([msgWithCalls({ name: 'load_skill', arguments: '{}' })])).toEqual([
      'config-editing',
    ]);
  });

  it('names printer-memory alone — knowledge loads never imply the edit skill', () => {
    expect(
      loadedSkillNames([
        msgWithCalls({ name: 'load_skill', arguments: '{"name":"printer-memory"}' }),
      ]),
    ).toEqual(['printer-memory']);
  });

  it('names BOTH skills in a two-skill trace, without duplicates', () => {
    expect(
      loadedSkillNames([
        msgWithCalls({ name: 'load_skill', arguments: '{"name":"macro-authoring"}' }),
        msgWithCalls({ name: 'load_skill', arguments: '{"name":"config-editing"}' }),
        msgWithCalls({ name: 'load_skill', arguments: '{"name":"macro-authoring"}' }),
      ]),
    ).toEqual(['macro-authoring', 'config-editing']);
  });

  it('names macro-authoring alone for a pure knowledge conversation', () => {
    expect(
      loadedSkillNames([
        msgWithCalls({ name: 'simulate_macro', arguments: '{"macro":"BLINK"}' }),
        msgWithCalls({ name: 'load_skill', arguments: '{"name":"macro-authoring"}' }),
      ]),
    ).toEqual(['macro-authoring']);
  });

  it('scans mixed traces across multiple messages, not just the last one', () => {
    const msgs: ChatMessage[] = [
      msgWithCalls({ name: 'load_skill', arguments: '{"name":"config-editing"}' }),
      { role: 'user', content: 'now toggle the LED' },
      msgWithCalls({ name: 'read_user_config', arguments: '{"file":"printer.cfg"}' }),
      msgWithCalls({ name: 'load_skill', arguments: '{"name":"macro-authoring"}' }),
    ];
    expect(loadedSkillNames(msgs)).toEqual(['config-editing', 'macro-authoring']);
  });

  it('returns [] without any load_skill call', () => {
    const msgs: ChatMessage[] = [
      { role: 'user', content: 'hello' },
      msgWithCalls({ name: 'config_edit', arguments: '{"op":"set_param"}' }),
    ];
    expect(loadedSkillNames(msgs)).toEqual([]);
  });

  it('treats an unparseable arguments string on load_skill as an edit load (fail-open)', () => {
    expect(loadedSkillNames([msgWithCalls({ name: 'load_skill', arguments: '{"name":"conf' })])).toEqual(
      ['config-editing'],
    );
  });
});
