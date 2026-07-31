/**
 * Generic reply-validation pipeline for the AI chat feature.
 *
 * The config-draft validator (built in useAssistantDraft.ts) and the
 * printer-memory validator (below) both conform to ReplyValidator.
 * runReplyValidationPipeline drives the shared retry loop:
 * validate → build feedback → re-request → repeat up to max attempts.
 *
 * Previously ChatDialog.tsx contained two independent retry loops with
 * different max attempts, feedback builders, and error handling. This
 * module unifies the mechanics; each validator keeps only its own
 * domain-specific validation and feedback logic.
 */
import type { ChatMessage } from '../stores/aiStore';
import type { AiChatRole } from '../services/api';
import {
  MAX_PRINTER_MEMORY_VALIDATION_ATTEMPTS,
  buildPrinterMemoryValidationFeedback,
  validatePrinterMemoryContent,
  type PrinterMemoryValidationIssue,
} from './printerMemory';

// ── Types ──────────────────────────────────────────────────────────

export interface ReplyValidationIssue {
  type: string;
  message: string;
  /** Optional structured payload the validator can use later (e.g. full outcome). */
  detail?: unknown;
}

export interface ReplyValidationResult {
  /** False = this validator does not apply to the reply — stop, no retry. */
  applicable: boolean;
  /** Empty = the reply is valid — stop. Non-empty = blocking issues. */
  issues: ReplyValidationIssue[];
  failureReason: string | null;
  /**
   * True = stop retrying even though issues remain (advisory-only issues
   * such as duplicate sections the AI cannot resolve). Adds warningOnGiveUp.
   */
  giveUp?: boolean;
  warningOnGiveUp?: string | null;
}

export interface ReplyValidationFeedback {
  /** Message sent to the AI asking it to fix the reply. */
  content: string;
  /** When true, the AI may explain the problem instead of producing a fixed reply. */
  allowExplanationOnly?: boolean;
}

export interface ReplyValidationContext {
  /** Index of the assistant reply being validated within messageHistory. */
  messageIndex: number;
  /** Full visible conversation trail (user + assistant + feedback messages). */
  messageHistory: ChatMessage[];
  /** True when this validation happens after at least one retry. */
  isRetry: boolean;
  /** Number of retries already performed for this validator (0 = first check). */
  attemptsUsed: number;
  /** From the previous feedback: AI may explain instead of producing output. */
  allowExplanationOnly: boolean;
}

export interface ReplyValidator {
  name: string;
  /** Maximum total attempts (initial reply + retries) before giving up. */
  maxAttempts: number;
  /** 'throw' → validation failure raises; 'warn' → failure becomes a warning. */
  failMode: 'throw' | 'warn';
  validate(content: string, context: ReplyValidationContext): Promise<ReplyValidationResult> | ReplyValidationResult;
  buildFeedback(content: string, result: ReplyValidationResult): ReplyValidationFeedback | null;
  /** Called after max attempts. Return message for the throw/warning. */
  onMaxAttemptsReached(content: string, result: ReplyValidationResult, totalAttempts: number): string | null;
  /** Return a warning string to convert a request error into a warning; null → rethrow. */
  handleRequestError?(error: unknown): string | null;
}

export interface ReplyRequestAttempt {
  assistantMessage: ChatMessage;
  conversationMessages: ChatMessage[];
  warningMessage: string | null;
}

export type ReplyRequestFn = (
  conversation: Array<{ role: AiChatRole; content: string }>,
) => Promise<ReplyRequestAttempt>;

export interface ReplyValidationPipelineParams {
  requestFn: ReplyRequestFn;
  /** Initial request conversation (system context + user messages). */
  requestConversation: Array<{ role: AiChatRole; content: string }>;
  /** Visible chat messages (user/assistant) that seed the validation trail. */
  validationConversation: ChatMessage[];
  initialAttempt: ReplyRequestAttempt;
  validators: ReplyValidator[];
}

export interface ReplyValidationPipelineResult {
  finalMessage: ChatMessage;
  /** Full visible conversation trail (assistant replies + feedback messages). */
  finalConversation: ChatMessage[];
  warnings: string | null;
}

// ── Pipeline ───────────────────────────────────────────────────────

function appendWarning(current: string | null, next: string): string {
  return current ? `${current}\n${next}` : next;
}

export async function runReplyValidationPipeline(
  params: ReplyValidationPipelineParams,
): Promise<ReplyValidationPipelineResult> {
  const { requestFn, validators } = params;

  // requestConversation grows incrementally: initial + assistant replies + feedbacks.
  let requestConversation = [...params.requestConversation];
  let currentAttempt = params.initialAttempt;
  // trail always ends with the assistant reply being validated,
  // so messageIndex = trail.length - 1.
  let trail = [...params.validationConversation, ...params.initialAttempt.conversationMessages];
  let warnings = params.initialAttempt.warningMessage;

  for (const validator of validators) {
    let attemptsUsed = 0;
    let allowExplanationOnly = false;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const context: ReplyValidationContext = {
        messageIndex: trail.length - 1,
        messageHistory: trail,
        isRetry: attemptsUsed > 0,
        attemptsUsed,
        allowExplanationOnly,
      };

      const result = await validator.validate(currentAttempt.assistantMessage.content, context);

      if (!result.applicable || result.issues.length === 0) {
        break; // Valid or not applicable — move to the next validator
      }

      if (result.giveUp) {
        if (result.warningOnGiveUp) {
          warnings = appendWarning(warnings, result.warningOnGiveUp);
        }
        break; // Advisory-only issues — stop retrying, keep the reply
      }

      attemptsUsed += 1;
      if (attemptsUsed >= validator.maxAttempts) {
        const failure = validator.onMaxAttemptsReached(
          currentAttempt.assistantMessage.content,
          result,
          attemptsUsed,
        );
        if (validator.failMode === 'throw') {
          throw new Error(failure ?? `AI reply failed ${validator.name} validation after ${attemptsUsed} attempts.`);
        }
        if (failure) {
          warnings = appendWarning(warnings, failure);
        }
        break;
      }

      const feedback = validator.buildFeedback(currentAttempt.assistantMessage.content, result);
      if (!feedback) {
        break; // Validator has no fix to suggest — stop retrying
      }
      allowExplanationOnly = feedback.allowExplanationOnly === true;

      requestConversation = [
        ...requestConversation,
        ...currentAttempt.conversationMessages.map((m) => ({ role: m.role as AiChatRole, content: m.content })),
        { role: 'user', content: feedback.content },
      ];
      trail = [...trail, { role: 'user', content: feedback.content }];

      try {
        currentAttempt = await requestFn(requestConversation);
      } catch (err: unknown) {
        const warning = validator.handleRequestError?.(err);
        if (warning) {
          warnings = appendWarning(warnings, warning);
          break;
        }
        throw err;
      }

      if (currentAttempt.warningMessage) {
        warnings = appendWarning(warnings, currentAttempt.warningMessage);
      }
      trail = [...trail, ...currentAttempt.conversationMessages];
    }
  }

  return {
    finalMessage: currentAttempt.assistantMessage,
    finalConversation: trail,
    warnings,
  };
}

// ── Printer Memory Validator ───────────────────────────────────────

/**
 * Validator for printer-memory code blocks (```printer-memory ... ```).
 *
 * - Not applicable: the reply has no printer-memory block.
 * - Valid: the block parses and uses only the 7 allowed fields.
 * - Invalid: sends buildPrinterMemoryValidationFeedback and retries up to
 *   MAX_PRINTER_MEMORY_VALIDATION_ATTEMPTS, then warns (does not throw).
 */
export function createPrinterMemoryReplyValidator(): ReplyValidator {
  let lastIssues: ReplyValidationIssue[] = [];

  return {
    name: 'printer-memory',
    maxAttempts: MAX_PRINTER_MEMORY_VALIDATION_ATTEMPTS,
    failMode: 'warn',

    validate: (content) => {
      const validationResult = validatePrinterMemoryContent(content);
      if (!validationResult) {
        return { applicable: false, issues: [], failureReason: null };
      }
      if (validationResult.issues.length === 0) {
        return { applicable: true, issues: [], failureReason: null };
      }
      lastIssues = validationResult.issues.map((issue) => ({
        type: 'printer-memory',
        message: issue.message,
        detail: issue,
      }));
      return { applicable: true, issues: lastIssues, failureReason: null };
    },

    buildFeedback: (_content, result) => ({
      content: buildPrinterMemoryValidationFeedback(
        result.issues.flatMap((issue) =>
          issue.detail ? [issue.detail as PrinterMemoryValidationIssue] : [],
        ),
      ),
    }),

    onMaxAttemptsReached: (_content, result, totalAttempts) => {
      const issueMessages = result.issues.map((issue) => `- ${issue.message}`).join('\n');
      return `The AI returned an invalid printer-memory block after ${totalAttempts} attempts:\n${issueMessages}`;
    },

    handleRequestError: (error) => {
      const issueMessages = lastIssues.map((issue) => `- ${issue.message}`).join('\n');
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return `Failed to retry after invalid printer memory block (${errorMessage}):\n${issueMessages}`;
    },
  };
}
