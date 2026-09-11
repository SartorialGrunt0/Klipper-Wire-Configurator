import { describe, expect, it } from 'vitest';
import {
  createPrinterMemoryReplyValidator,
  runReplyValidationPipeline,
  type ReplyRequestAttempt,
  type ReplyValidationPipelineParams,
  type ReplyValidator,
} from '@/utils/replyValidation';
import type { ChatMessage } from '@/stores/aiStore';

function assistant(content: string): ChatMessage {
  return { role: 'assistant', content };
}

function user(content: string): ChatMessage {
  return { role: 'user', content };
}

function attempt(assistantMessage: ChatMessage, warningMessage: string | null = null): ReplyRequestAttempt {
  return {
    assistantMessage,
    conversationMessages: [assistantMessage],
    warningMessage,
  };
}

describe('createPrinterMemoryReplyValidator', () => {
  it('is not applicable when the reply has no printer-memory block', async () => {
    const v = createPrinterMemoryReplyValidator();
    const result = await v.validate('Just a normal answer.', {
      messageIndex: 0,
      messageHistory: [],
      isRetry: false,
      attemptsUsed: 0,
      allowExplanationOnly: false,
    });
    expect(result.applicable).toBe(false);
  });

  it('accepts a valid printer-memory block', async () => {
    const v = createPrinterMemoryReplyValidator();
    const content = [
      '```printer-memory',
      JSON.stringify({ mainboard: 'Spider', kinematics: 'corexy' }, null, 2),
      '```',
    ].join('\n');
    const result = await v.validate(content, {
      messageIndex: 0,
      messageHistory: [],
      isRetry: false,
      attemptsUsed: 0,
      allowExplanationOnly: false,
    });
    expect(result.applicable).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it('flags extra keys as issues', async () => {
    const v = createPrinterMemoryReplyValidator();
    const content = [
      '```printer-memory',
      JSON.stringify({ mainboard: 'Spider', warpDrive: 'on' }, null, 2),
      '```',
    ].join('\n');
    const result = await v.validate(content, {
      messageIndex: 0,
      messageHistory: [],
      isRetry: false,
      attemptsUsed: 0,
      allowExplanationOnly: false,
    });
    expect(result.applicable).toBe(true);
    expect(result.issues.length).toBeGreaterThan(0);
    expect(result.issues[0].message).toContain('warpDrive');
  });

  it('builds feedback referencing the offending fields', async () => {
    const v = createPrinterMemoryReplyValidator();
    const content = [
      '```printer-memory',
      JSON.stringify({ mainboard: 'Spider', extraField: 'x' }, null, 2),
      '```',
    ].join('\n');
    const result = await v.validate(content, {
      messageIndex: 0,
      messageHistory: [],
      isRetry: false,
      attemptsUsed: 0,
      allowExplanationOnly: false,
    });
    const feedback = await v.buildFeedback(content, result);
    expect(feedback).not.toBeNull();
    expect(feedback!.content).toContain('extraField');
    expect(feedback!.content).toContain('mainboard');
  });

  it('produces a max-attempts warning without throwing (failMode warn)', async () => {
    const v = createPrinterMemoryReplyValidator();
    const msg = v.onMaxAttemptsReached('bad', {
      applicable: true,
      issues: [{ type: 'printer-memory', message: 'The block is empty.' }],
      failureReason: null,
    }, 3);
    expect(msg).toContain('3 attempts');
    expect(msg).toContain('block is empty');
  });
});

describe('runReplyValidationPipeline', () => {
  const validContent = '```printer-memory\n{"mainboard": "Spider"}\n```';
  const invalidContent = '```printer-memory\n{"mainboard": "Spider", "extra": "x"}\n```';

  function params(overrides: Partial<ReplyValidationPipelineParams> = {}): ReplyValidationPipelineParams {
    return {
      requestFn: async () => attempt(assistant(validContent)),
      requestConversation: [user('fill in printer memory')],
      validationConversation: [user('fill in printer memory')],
      initialAttempt: attempt(assistant(invalidContent)),
      validators: [createPrinterMemoryReplyValidator()],
      ...overrides,
    };
  }

  it('retries until the reply validates', async () => {
    let calls = 0;
    const p = params({
      requestFn: async () => {
        calls += 1;
        return attempt(assistant(validContent));
      },
    });
    const result = await runReplyValidationPipeline(p);
    expect(calls).toBe(1);
    expect(result.finalMessage.content).toBe(validContent);
    expect(result.warnings).toBeNull();
    expect(result.retryCount).toBe(1);
  });

  it('warns after max attempts when the AI keeps failing', async () => {
    const p = params({
      requestFn: async () => attempt(assistant(invalidContent)),
    });
    const result = await runReplyValidationPipeline(p);
    expect(result.finalMessage.content).toBe(invalidContent);
    expect(result.warnings).toContain('3 attempts');
    expect(result.warnings).toContain('extra');
  });

  it('converts request errors to warnings via handleRequestError', async () => {
    const p = params({
      requestFn: async () => {
        throw new Error('provider down');
      },
    });
    const result = await runReplyValidationPipeline(p);
    expect(result.warnings).toContain('provider down');
  });

  it('throws when a throw-mode validator exhausts attempts', async () => {
    const throwingValidator: ReplyValidator = {
      name: 'strict',
      maxAttempts: 2,
      failMode: 'throw',
      validate: async () => ({
        applicable: true,
        issues: [{ type: 'strict', message: 'always bad' }],
        failureReason: null,
      }),
      buildFeedback: () => ({ content: 'fix it' }),
      onMaxAttemptsReached: () => 'gave up on strict',
    };
    const p = params({ validators: [throwingValidator] });
    await expect(runReplyValidationPipeline(p)).rejects.toThrow('gave up on strict');
  });

  it('skips non-applicable validators', async () => {
    let calls = 0;
    const p = params({
      initialAttempt: attempt(assistant('no block here')),
      requestFn: async () => {
        calls += 1;
        return attempt(assistant('still no block'));
      },
    });
    const result = await runReplyValidationPipeline(p);
    expect(calls).toBe(0);
    expect(result.finalMessage.content).toBe('no block here');
    expect(result.retryCount).toBe(0);
  });

  it('attaches repairCount from the accepting validator to the final message', async () => {
    const repairingValidator: ReplyValidator = {
      name: 'repairer',
      maxAttempts: 1,
      failMode: 'throw',
      validate: async () => ({
        applicable: true,
        issues: [],
        failureReason: null,
        repairCount: 2,
      }),
      buildFeedback: () => null,
      onMaxAttemptsReached: () => null,
    };
    const p = params({
      initialAttempt: attempt(assistant(validContent)),
      requestFn: async () => attempt(assistant(validContent)),
      validators: [repairingValidator],
    });
    const result = await runReplyValidationPipeline(p);
    expect(result.finalMessage.repairCount).toBe(2);
    expect(result.retryCount).toBe(0);
  });

  it('preserves repromptCount from the attempt that produced the final message', async () => {
    const p = params({
      initialAttempt: attempt({ role: 'assistant', content: invalidContent, repromptCount: 2 }),
      requestFn: async () => attempt({ role: 'assistant', content: validContent, repromptCount: 3 }),
    });
    const result = await runReplyValidationPipeline(p);
    expect(result.finalMessage.repromptCount).toBe(3);
    expect(result.retryCount).toBe(1);
  });
});

describe('serverRetryExemptWarning (finding #4)', () => {
  it('returns null for absent/clean/non-exempt verdicts', async () => {
    const { serverRetryExemptWarning } = await import('@/utils/replyValidation');
    expect(serverRetryExemptWarning(null)).toBeNull();
    expect(serverRetryExemptWarning(undefined)).toBeNull();
    expect(
      serverRetryExemptWarning({ attempted: false, repaired: false, issuesAfter: [] }),
    ).toBeNull();
    expect(
      serverRetryExemptWarning({
        attempted: true, repaired: false, issuesAfter: [], reason: 'something-else',
      }),
    ).toBeNull();
  });

  it('renders the server findings when reason is retry-exempt', async () => {
    const { serverRetryExemptWarning } = await import('@/utils/replyValidation');
    const warning = serverRetryExemptWarning({
      attempted: false,
      repaired: false,
      reason: 'retry-exempt',
      issuesAfter: [{
        filename: 'printer.cfg',
        errors: [{ severity: 'error', section: 'fan', param: 'pin', message: "Pin 'PB3' is used by multiple sections" }],
      }],
    });
    expect(warning).toContain('printer.cfg');
    expect(warning).toContain('[fan] pin');
    expect(warning).toContain('cannot fix by regenerating');
  });
});

describe('runReplyValidationPipeline serverRepair plumbing', () => {
  function params(over: Partial<ReplyValidationPipelineParams>): ReplyValidationPipelineParams {
    return {
      requestFn: async () => attempt(assistant('y')),
      requestConversation: [{ role: 'user', content: 'q' }],
      validationConversation: [user('q')],
      initialAttempt: attempt(assistant('x')),
      validators: [],
      ...over,
    };
  }

  it('passes the attempt serverRepair verdict into the validator context', async () => {
    const verdict = {
      attempted: false, repaired: false, reason: 'retry-exempt',
      issuesAfter: [{ filename: 'printer.cfg', errors: [] }],
    };
    let seen: unknown = 'unset';
    const validator: ReplyValidator = {
      name: 'ctx-probe',
      maxAttempts: 3,
      failMode: 'warn',
      validate: (_content, context) => {
        seen = context.serverRepair;
        return { applicable: false, issues: [], failureReason: null };
      },
      buildFeedback: () => null,
      onMaxAttemptsReached: () => null,
    };
    const p = params({
      initialAttempt: { ...attempt(assistant('x')), serverRepair: verdict },
      requestFn: async () => attempt(assistant('y')),
      validators: [validator],
    });
    await runReplyValidationPipeline(p);
    expect(seen).toEqual(verdict);
  });

  it('defaults the context verdict to null when the attempt has none', async () => {
    let seen: unknown = 'unset';
    const validator: ReplyValidator = {
      name: 'ctx-probe',
      maxAttempts: 3,
      failMode: 'warn',
      validate: (_content, context) => {
        seen = context.serverRepair;
        return { applicable: false, issues: [], failureReason: null };
      },
      buildFeedback: () => null,
      onMaxAttemptsReached: () => null,
    };
    const p = params({
      initialAttempt: attempt(assistant('x')),
      requestFn: async () => attempt(assistant('y')),
      validators: [validator],
    });
    await runReplyValidationPipeline(p);
    expect(seen).toBeNull();
  });
});
