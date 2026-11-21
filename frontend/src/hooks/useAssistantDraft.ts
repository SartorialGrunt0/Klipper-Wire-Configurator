/**
 * Hook encapsulating the AI chat request helper for ChatDialog.
 *
 * HISTORY: this hook carried the entire prose→draft pipeline (cfg-block
 * ingestion, mini-diff apply, merge engine, Jinja repair, draft
 * validation + retry feedback, Apply & Review preview). The Phase-4
 * ratchet (2026-09-22, .hermes/plans/2026-09-10_tool-mediated-config-editing.md)
 * deleted that path: config edits go through the config_edit/config_write
 * write tools behind the per-change approval card. Approved staged edits
 * are applied straight into the config store by ChatDialog's
 * applyApprovedToolEdits (utils/approvalApply.ts); there is no draft
 * preview anymore.
 */
import { useCallback } from 'react';
import type { ChatMessage, MessageContextUsage, AiProvider } from '../stores/aiStore';
import type { AiChatRole, PendingConfigEdit } from '../services/api';
import * as api from '../services/api';
import { rewriteConfigEqualsSeparators } from '../utils/chatUtils';
import type { ChatReference } from '../utils/chatReferences';
import type { WorkLedgerRow } from '../utils/chatWorkLedger';
import { isContextOverflowErrorCode } from '../utils/contextOverflow';
import { contextPressureWindowKey, useContextPressureStore } from '../stores/contextPressureStore';

interface ChatRequestBase {
  apiKey: string;
  model: string;
  apiUrl: string;
  apiProvider: AiProvider;
  /** Client-generated id used to signal a user-initiated stop. */
  requestId?: string;
  /** Maximum number of tokens the provider should generate. */
  maxTokens?: number;
  /** Sampling temperature for the provider (0-2). Omit for provider default. */
  temperature?: number;
  /** Tool-calling protocol override: 'auto' (scheme split), 'native', 'text'. */
  toolProtocol?: 'auto' | 'native' | 'text';
  /** Loaded user-config content for the backend config-grounding fallback. */
  contextFiles?: Record<string, { content: string; label: string }>;
  /**
   * Context the user attached explicitly in the docked panel — highlighted
   * line ranges, pinned tree rows. Sent structured; the backend renders them
   * into one trailing system message (omitted entirely when empty, so an
   * ordinary turn's prompt is byte-identical to before this feature).
   */
  context_references?: ChatReference[];
  /**
   * Sticky skill armament (W0/W4-R2): names of the skills whose load_skill
   * ran in this conversation, derived from the stored tool trace via
   * utils/chatSkillTrace. Passed through to api.aiChat verbatim.
   */
  loadedSkills?: string[];
  /**
   * Conversation work-ledger (W6): derived at send time from the stored
   * tool trace + decision store. Passed through to api.aiChat verbatim.
   */
  workLedger?: WorkLedgerRow[];
}

interface AssistantReplyAttempt {
  assistantMessage: ChatMessage;
  conversationMessages: ChatMessage[];
  warningMessage: string | null;
  /** Server-validated staged write-tool changes (the only edit path). */
  pendingEdits?: PendingConfigEdit[] | null;
}

export type { ChatRequestBase, AssistantReplyAttempt };

export function useAssistantDraft() {
  // ── Request Assistant Message (separator post-processing) ──────────

  const requestAssistantMessage = useCallback(
    async (
      chatRequestBase: ChatRequestBase,
      conversationMessages: Array<{ role: AiChatRole; content: string }>,
      onMessageUpdate?: (msg: ChatMessage) => void,
      options?: { signal?: AbortSignal },
    ): Promise<AssistantReplyAttempt> => {
      void onMessageUpdate;
      // W8 pre-flight input: send the window this session already probed —
      // but ONLY when the probe belongs to this exact apiUrl+model. A stale
      // probe from a previous model must not block this request; omitting
      // the field means the backend stays silent (its own W7 law).
      const pressure = useContextPressureStore.getState();
      const windowKey = contextPressureWindowKey({
        apiKey: chatRequestBase.apiKey,
        apiUrl: chatRequestBase.apiUrl,
        apiProvider: chatRequestBase.apiProvider,
        model: chatRequestBase.model,
      });
      const knownContextWindow =
        pressure.probedKey === windowKey ? pressure.contextWindow : null;
      // C-01: generation this request belongs to. If the user starts or
      // loads a chat while this reply is in flight, the epoch moved and
      // this reply's telemetry must not land in the new conversation.
      const pressureEpoch = pressure.epoch;
      // Context chip: the reply's wall-clock duration, measured where the
      // user feels it — client send to reply in hand (loop retries included,
      // since the backend performs them inside this one call).
      const replyStartedAt = Date.now();
      const response = await api.aiChat(
        { ...chatRequestBase, knownContextWindow, messages: conversationMessages },
        options?.signal,
      );

      if (response.error) {
        // W8: the structured overflow code becomes a typed error so the
        // dialog can show the actionable overflow banner instead of the
        // generic red text. Prose is never matched.
        if (isContextOverflowErrorCode(response.errorCode)) {
          throw new api.AiContextOverflowError(response.error);
        }
        throw new Error(response.error);
      }

      // W7 context-pressure telemetry: record the latest request's prompt
      // size and make sure the window for this provider+model has been
      // probed (once per key, fire-and-forget — the advisory self-heals on
      // the NEXT reply if the probe lands after this render).
      // C-01: only for the conversation this request belongs to — if a
      // new/loaded chat moved the epoch mid-flight, this reply's telemetry
      // is stale and lands nowhere.
      if (useContextPressureStore.getState().epoch === pressureEpoch) {
        pressure.recordUsage(
          response.usage?.lastPromptTokens ?? null,
          response.usage?.lastCachedTokens ?? null,
        );
        // The Context chip freezes this reply's window onto the message, so
        // the probe runs BEFORE the message is built: it is deduped per
        // provider+model and the backend answers from router preset args, so
        // the first reply of a session pays milliseconds. A probe that hangs
        // must never hold the reply hostage — the wait is bounded, and a late
        // answer still heals the chip through the store.
        await Promise.race([
          pressure.ensureWindow({
            apiKey: chatRequestBase.apiKey,
            apiUrl: chatRequestBase.apiUrl,
            apiProvider: chatRequestBase.apiProvider,
            model: chatRequestBase.model,
          }),
          new Promise<void>((resolve) => { setTimeout(resolve, 1500); }),
        ]);
      }

      // Context chip: freeze this reply's numbers onto the message. The
      // window comes from the session's probe for the same provider+model;
      // when the probe has not landed yet it stays null and the chip degrades
      // to a token readout rather than inventing a percentage.
      const pressureAfter = useContextPressureStore.getState();
      const contextUsage: MessageContextUsage = {
        promptTokens: typeof response.usage?.lastPromptTokens === 'number'
          ? response.usage.lastPromptTokens
          : null,
        cachedTokens: typeof response.usage?.lastCachedTokens === 'number'
          ? response.usage.lastCachedTokens
          : null,
        contextWindow: pressureAfter.probedKey === windowKey ? pressureAfter.contextWindow : null,
        windowKey,
        replyMs: Date.now() - replyStartedAt,
        model: chatRequestBase.model ?? null,
      };

      let assistantMessage: ChatMessage = {
        role: 'assistant',
        content: response.content || 'No response.',
        contextUsage,
        mcpToolNames: response.mcpToolNames,
        toolCalls: response.toolCalls,
        repromptCount: response.repromptCount,
        pendingEdits: response.pendingEdits ?? undefined,
        // Post-hoc review: the change set rides the message exactly like
        // pendingEdits does, so a reloaded conversation keeps the set the
        // reply produced (never re-derived from prose).
        changeSet: response.changeSet ?? null,
        steers: response.steers ?? [],
      };
      // Clone the assistant message (not just content) so pendingEdits
      // survive into the validation trail.
      let conversationTrail: ChatMessage[] = [{ ...assistantMessage }];

      // Normalise cfg separators (`key = value` → `key: value`) as local
      // post-processing — display consistency for fenced config text.
      // Deterministic, instant, cannot drift (was a full AI re-query).
      const rewrittenContent = rewriteConfigEqualsSeparators(assistantMessage.content);
      if (rewrittenContent !== assistantMessage.content) {
        assistantMessage = { ...assistantMessage, content: rewrittenContent };
        const lastIndex = conversationTrail.length - 1;
        if (lastIndex >= 0) {
          conversationTrail[lastIndex] = { ...conversationTrail[lastIndex], content: rewrittenContent };
        }
      }

      return {
        assistantMessage,
        conversationMessages: conversationTrail,
        warningMessage: null,
        pendingEdits: response.pendingEdits ?? null,
      };
    },
    [],
  );

  return {
    requestAssistantMessage,
  };
}
