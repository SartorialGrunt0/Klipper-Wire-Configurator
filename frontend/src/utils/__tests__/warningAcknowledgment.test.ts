import { describe, it, expect } from 'vitest';
import {
  isUnknownSectionWarning,
  isDuplicateSectionWarning,
  isAcknowledgeableWarning,
  acknowledgeableWarning,
  ackKindForSection,
  sectionHasAcknowledgeableWarning,
} from '../warningAcknowledgment';

describe('isUnknownSectionWarning', () => {
  it('matches unknown-section messages', () => {
    expect(isUnknownSectionWarning("Unknown section type 'foo_bar'. Parameters won't be validated.")).toBe(true);
  });
  it('does not match duplicate messages', () => {
    expect(isUnknownSectionWarning('Section [virtual_sdcard] is reused across active included config files.')).toBe(false);
  });
});

describe('isDuplicateSectionWarning', () => {
  it('matches single-file duplicate (demoted to warning)', () => {
    expect(isDuplicateSectionWarning('Section [idle_timeout] can only be defined once.')).toBe(true);
  });
  it('matches cross-file duplicate without "also defined in"', () => {
    expect(isDuplicateSectionWarning('Section [virtual_sdcard] is reused across active included config files.')).toBe(true);
  });
  it('matches cross-file duplicate with "also defined in"', () => {
    expect(isDuplicateSectionWarning('Section [virtual_sdcard] is reused across active included config files. Also defined in: mainsail.cfg.')).toBe(true);
  });
  it('does not match unknown-section messages', () => {
    expect(isDuplicateSectionWarning("Unknown section type 'foo'. Parameters won't be validated.")).toBe(false);
  });
  it('does not match arbitrary warning text', () => {
    expect(isDuplicateSectionWarning('Some other warning.')).toBe(false);
  });
});

describe('acknowledgeableWarning', () => {
  it('classifies unknown vs duplicate', () => {
    expect(acknowledgeableWarning("Unknown section type 'x'.")).toEqual({ kind: 'unknown' });
    expect(acknowledgeableWarning('Section [x] can only be defined once.')).toEqual({ kind: 'duplicate' });
    expect(acknowledgeableWarning('Section [x] is reused across active included config files.')).toEqual({ kind: 'duplicate' });
    expect(acknowledgeableWarning('not a warning we ack')).toBeNull();
  });
});

describe('isAcknowledgeableWarning', () => {
  it('true for either ack-able kind, false otherwise', () => {
    expect(isAcknowledgeableWarning("Unknown section type 'x'")).toBe(true);
    expect(isAcknowledgeableWarning('Section [x] can only be defined once.')).toBe(true);
    expect(isAcknowledgeableWarning('Section [x] is reused across active included config files. Also defined in: a.cfg.')).toBe(true);
    expect(isAcknowledgeableWarning('some error')).toBe(false);
  });
});

describe('ackKindForSection', () => {
  const issue = (severity: 'error' | 'warning', message: string) => ({ severity, message });

  it('returns null when no warnings', () => {
    expect(ackKindForSection([issue('error', 'boom')])).toBeNull();
    expect(ackKindForSection([])).toBeNull();
  });

  it('returns unknown for an unknown-section warning', () => {
    expect(ackKindForSection([issue('warning', "Unknown section type 'foo'")])).toBe('unknown');
  });

  it('returns duplicate for a duplicate warning', () => {
    expect(ackKindForSection([issue('warning', 'Section [x] can only be defined once.')])).toBe('duplicate');
  });

  it('prefers duplicate when a section has both (duplicate wins, is unambiguous)', () => {
    expect(ackKindForSection([
      issue('warning', "Unknown section type 'foo'"),
      issue('warning', 'Section [x] can only be defined once.'),
    ])).toBe('duplicate');
  });

  it('ignores non-acknowledgeable warnings', () => {
    expect(ackKindForSection([issue('warning', 'some other warning')])).toBeNull();
  });
});

describe('sectionHasAcknowledgeableWarning', () => {
  it('reflects ackKindForSection presence', () => {
    expect(sectionHasAcknowledgeableWarning([{ severity: 'warning', message: 'Section [x] can only be defined once.' }])).toBe(true);
    expect(sectionHasAcknowledgeableWarning([{ severity: 'warning', message: 'other' }])).toBe(false);
  });
});
