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
import type { ChatMessage, AiProvider } from '../stores/aiStore';
import type { AiChatRole, PendingConfigEdit } from '../services/api';
import * as api from '../services/api';
import { rewriteConfigEqualsSeparators } from '../utils/chatUtils';

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
      const response = await api.aiChat({ ...chatRequestBase, messages: conversationMessages }, options?.signal);

      if (response.error) throw new Error(response.error);

      let assistantMessage: ChatMessage = {
        role: 'assistant',
        content: response.content || 'No response.',
        mcpToolNames: response.mcpToolNames,
        toolCalls: response.toolCalls,
        repromptCount: response.repromptCount,
        pendingEdits: response.pendingEdits ?? undefined,
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
