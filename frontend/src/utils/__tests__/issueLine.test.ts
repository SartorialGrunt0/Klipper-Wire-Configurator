import { describe, it, expect } from 'vitest';
import { resolveIssueLine } from '../issueLine';
import type { ValidationError } from '../../types/config';

function err(overrides: Partial<ValidationError> = {}): ValidationError {
  return {
    severity: 'warning',
    section: '',
    param: '',
    message: '',
    line_number: 0,
    ...overrides,
  };
}

const TEXT = [
  '[stepper_x]',
  '# step pin with comment',
  'step_pin: PB0',
  'dir_pin: !PB1',
  '',
  '[stepper_y]',
  'step_pin: PB2',
];

describe('resolveIssueLine', () => {
  it('prefers the backend line_number over any heuristic when it is set', () => {
    const e = err({ line_number: 7, section: 'stepper_x', param: 'step_pin' });
    expect(resolveIssueLine(e, TEXT)).toBe(7);
  });

  it('uses the backend line_number even when the heuristic would find a different line', () => {
    // Backend says line 7; the heuristic (section header + param) would find 3.
    const e = err({ line_number: 7, section: 'stepper_x', param: 'step_pin' });
    expect(resolveIssueLine(e, TEXT)).toBe(7);
  });

  it('falls back to the param line heuristic when backend line_number is 0', () => {
    const e = err({ line_number: 0, section: 'stepper_x', param: 'step_pin' });
    expect(resolveIssueLine(e, TEXT)).toBe(3); // 'step_pin: PB0' is line 3
  });

  it('falls back to the section header line when the param is not found', () => {
    const e = err({ line_number: 0, section: 'stepper_y', param: 'nope' });
    expect(resolveIssueLine(e, TEXT)).toBe(6); // '[stepper_y]' is line 6
  });

  it('handles a commented section header in the heuristic', () => {
    const lines = ['#[probe]', 'pin: ^PB7'];
    const e = err({ line_number: 0, section: 'probe', param: 'pin' });
    expect(resolveIssueLine(e, lines)).toBe(2);
  });

  it('stops the param search at the next section header', () => {
    // step_pin exists only inside stepper_y; the search for stepper_x must
    // stop at the next header rather than crossing it.
    const lines = [
      '[stepper_x]',
      'dir_pin: !PB1',
      '',
      '[stepper_y]',
      'step_pin: PB2',
    ];
    const e = err({ line_number: 0, section: 'stepper_x', param: 'step_pin' });
    expect(resolveIssueLine(e, lines)).toBe(1); // falls back to the header line
  });

  it('returns 0 when nothing resolves (no section, no line)', () => {
    const e = err({ line_number: 0 });
    expect(resolveIssueLine(e, TEXT)).toBe(0);
  });

  it('returns 0 for an unknown section in the text', () => {
    const e = err({ line_number: 0, section: 'nonexistent', param: 'pin' });
    expect(resolveIssueLine(e, TEXT)).toBe(0);
  });

  describe('stale results (user typed ahead of the revalidation)', () => {
    // The validation result below was computed against OLD_TEXT, where
    // stepper_x is at line 1. In CURRENT_TEXT the user inserted two lines at
    // the top, so the section now sits at line 3.
    const OLD_TEXT = ['[stepper_x]', 'step_pin: PB0'];
    const CURRENT_TEXT = ['# new comment', '', '[stepper_x]', 'step_pin: PB0'];

    it('ignores the stale backend line and re-resolves via the section header', () => {
      const e = err({ line_number: 1, section: 'stepper_x', param: 'step_pin' });
      // Without stale: trusts the (stale) backend number 1.
      expect(resolveIssueLine(e, CURRENT_TEXT)).toBe(1);
      // With stale: re-locates step_pin in the CURRENT text (line 4).
      expect(resolveIssueLine(e, CURRENT_TEXT, { stale: true })).toBe(4);
    });

    it('falls back to the section header line when the param is gone', () => {
      const e = err({ line_number: 1, section: 'stepper_x', param: 'gone_param' });
      expect(resolveIssueLine(e, CURRENT_TEXT, { stale: true })).toBe(3);
    });

    it('keeps a stale unclosed-header line that still looks broken in the new text', () => {
      // The broken '[mcu line did not move — the same text is still on the
      // line the backend named, so the dot stays put instead of vanishing.
      const broken = ['[printer]', 'kinematics: corexy', '[mcu', 'status_timeout: 500'];
      const e = err({ line_number: 3, section: 'mcu', param: '' });
      expect(resolveIssueLine(e, broken, { stale: true })).toBe(3);
    });

    it('hides the finding (0) when the section cannot be found in the new text', () => {
      // User deleted the section after validation ran — the finding must not
      // paint a dot on whatever line 1 now happens to be.
      const e = err({ line_number: 1, section: 'stepper_x', param: 'step_pin' });
      expect(resolveIssueLine(e, ['[printer]'], { stale: true })).toBe(0);
    });

    it('trusts the backend line when not stale, even if the heuristic disagrees', () => {
      const e = err({ line_number: 4, section: 'stepper_x', param: 'step_pin' });
      expect(resolveIssueLine(e, CURRENT_TEXT)).toBe(4);
    });
  });
});
