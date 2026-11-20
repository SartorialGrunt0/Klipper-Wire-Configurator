// PR #43 C-03: touched rows must be grounded in the read OUTPUT, never in
// the call arguments. A requested-but-nonexistent section is echoed back in
// the arguments of a 'not found' answer; trusting the arguments let the
// ledger claim 'you read section X' for a section that was never returned.
import { describe, expect, it } from 'vitest';

import { buildWorkLedger } from '../chatWorkLedger';
import type { ChatMessage } from '../../stores/aiStore';

function readMessage(args: unknown, output: string): ChatMessage {
  return {
    role: 'assistant',
    content: '',
    toolCalls: [{
      name: 'read_user_config',
      arguments: JSON.stringify(args),
      output,
    }],
  } as unknown as ChatMessage;
}

function ledgerWith(call: ChatMessage) {
  return buildWorkLedger(
    [
      { role: 'user', content: 'check it' } as unknown as ChatMessage,
      call,
      // The ledger measures turns SINCE the read (offset >= 1): a later
      // user message is what makes this read 'previous turn'.
      { role: 'user', content: 'and now?' } as unknown as ChatMessage,
    ],
    [],
  );
}

describe('touched rows are grounded in the returned content (C-03)', () => {
  it('drops a requested section that the output does not contain', () => {
    const rows = ledgerWith(readMessage(
      { filename: 'printer.cfg', section: '[gcode_macro FOO]' },
      "# printer.cfg\nSection 'gcode_macro FOO' was not found in printer.cfg",
    ));
    // The file WAS reached (header present) so a file-level row is honest…
    expect(rows).toHaveLength(1);
    expect(rows[0].section).toBe('');
    expect(rows[0].verdict).toBe('touched');
    // …but no section row may claim grounding on the absent section.
    expect(rows.some((r) => r.section.toLowerCase().includes('foo'))).toBe(false);
  });

  it('touches the section when its header IS in the output', () => {
    const rows = ledgerWith(readMessage(
      { filename: 'printer.cfg', section: '[gcode_macro FOO]' },
      '# printer.cfg\n[gcode_macro FOO]\ngcode:\n  M117 hi\n',
    ));
    expect(rows).toHaveLength(1);
    expect(rows[0].section).toBe('gcode_macro FOO');
    expect(rows[0].verdict).toBe('touched');
  });

  it('batch section lists keep only the headers that came back', () => {
    const rows = ledgerWith(readMessage(
      { filename: 'printer.cfg', sections: ['[a]', '[b]'] },
      '# printer.cfg\n[a]\nk: 1\n',
    ));
    const sections = rows.map((r) => r.section);
    expect(sections).toContain('a');
    expect(sections).not.toContain('b');
  });
});
