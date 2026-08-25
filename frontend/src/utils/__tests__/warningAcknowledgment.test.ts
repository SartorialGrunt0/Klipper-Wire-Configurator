import { describe, it, expect } from 'vitest';
import {
  acknowledgeableWarning,
  ackKindForSection,
  sectionHasAcknowledgeableWarning,
} from '../warningAcknowledgment';

// The ack gate branches on the stable `code` field, never message text, so
// the fixtures carry realistic messages but only `code` drives the outcome.
const issue = (severity: 'error' | 'warning', code?: string, message = 'msg') => ({
  severity,
  code,
  message,
});

describe('acknowledgeableWarning', () => {
  it('maps unknown_section to the unknown kind', () => {
    expect(acknowledgeableWarning({ code: 'unknown_section' })).toEqual({ kind: 'unknown' });
  });
  it('maps project_duplicate to the duplicate kind', () => {
    expect(acknowledgeableWarning({ code: 'project_duplicate' })).toEqual({ kind: 'duplicate' });
  });
  it('returns null for non-acknowledgeable codes', () => {
    expect(acknowledgeableWarning({ code: 'shared_pin' })).toBeNull();
    expect(acknowledgeableWarning({ code: 'macro_full_rewrite' })).toBeNull();
    expect(acknowledgeableWarning({})).toBeNull();
  });
});

describe('ackKindForSection', () => {
  it('returns null when no warnings', () => {
    expect(ackKindForSection([issue('error', 'unknown_section')])).toBeNull();
    expect(ackKindForSection([])).toBeNull();
  });

  it('returns unknown for an unknown-section warning', () => {
    expect(ackKindForSection([issue('warning', 'unknown_section', "Unknown section type 'foo'.")])).toBe('unknown');
  });

  it('returns duplicate for a duplicate warning', () => {
    expect(ackKindForSection([issue('warning', 'project_duplicate', 'Section [x] can only be defined once.')])).toBe('duplicate');
  });

  it('prefers duplicate when a section has both (duplicate wins, is unambiguous)', () => {
    expect(ackKindForSection([
      issue('warning', 'unknown_section'),
      issue('warning', 'project_duplicate'),
    ])).toBe('duplicate');
  });

  it('ignores non-acknowledgeable warnings', () => {
    expect(ackKindForSection([issue('warning', 'shared_pin', "Pin 'PA0' is used by multiple sections")])).toBeNull();
  });
});

describe('sectionHasAcknowledgeableWarning', () => {
  it('reflects ackKindForSection presence', () => {
    expect(sectionHasAcknowledgeableWarning([issue('warning', 'project_duplicate')])).toBe(true);
    expect(sectionHasAcknowledgeableWarning([issue('warning', 'shared_pin')])).toBe(false);
  });
});
