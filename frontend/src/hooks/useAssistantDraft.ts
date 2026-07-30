/**
 * Hook encapsulating all AI draft validation, preview, and merge logic.
 *
 * Extracted from ChatDialog.tsx to reduce component complexity and make
 * the validation flow testable in isolation.
 */
import { useState, useRef, useCallback } from 'react';
import type { ChatMessage } from '../stores/aiStore';
import type { AiProvider } from '../stores/aiStore';
import type { ConfigFile, ConfigSection, ValidationResult } from '../types/config';
import type { AiChatRole } from '../services/api';
import * as api from '../services/api';
import {
  extractConfigCodeBlocks,
  extractMentionedConfigFilenames,
  extractAssistantFileHint,
  resolveAssistantTargetFile,
  extractRequestedKlipperDocFilenames,
  buildAutoLoadedKlipperDocMessage,
  extractEqualsSeparatedConfigLines,
  buildConfigSeparatorRewritePrompt,
  appendWarningMessage,
  shouldRetryAssistantValidation,
  buildAssistantDraftValidationFeedback,
  buildAssistantDraftValidationErrorMessage,
  hasOnlyRetryExemptAssistantValidationIssues,
  formatAssistantDraftValidationIssues,
  MAX_ASSISTANT_DRAFT_VALIDATION_ATTEMPTS,
  MAX_ASSISTANT_HINT_USER_MESSAGES,
  collectNewValidationErrors,
  type AssistantDraftValidationOutcome,
  type AssistantDraftValidationIssueGroup,
} from '../utils/chatUtils';
import type { AssistantDraftChange } from '../utils/assistantDraftMerge';
import { mergeAssistantSectionsIntoConfig, preprocessDeleteMarkers } from '../utils/assistantDraftMerge';
import { normalizeDiffText } from '../utils/configDiff';

// ── Internal Types ──────────────────────────────────────────────────

interface AssistantDraftFilePreview {
  filename: string;
  originalText: string;
  baseConfig: ConfigFile;
  assistantConfig: ConfigFile;
  mergedText: string;
  changes: AssistantDraftChange[];
}

export interface AssistantDraftPreview {
  filePreviews: AssistantDraftFilePreview[];
  selectedChangeIds: string[];
  previewUpdating: boolean;
}

interface AssistantReplyAttempt {
  assistantMessage: ChatMessage;
  conversationMessages: ChatMessage[];
  warningMessage: string | null;
}

interface ChatRequestBase {
  apiKey: string;
  model: string;
  apiUrl: string;
  apiProvider: AiProvider;
}

interface SubmitMessageOptions {
  hiddenFromUser?: boolean;
}

// ── Hook ────────────────────────────────────────────────────────────

export function useAssistantDraft(deps: {
  messages: ChatMessage[];
  setMessages: (messages: ChatMessage[]) => void;
  configFiles: Record<string, ConfigFile>;
  activeFile: string;
  validation: Record<string, ValidationResult>;
  schemas: unknown;
  textDrafts: Record<string, string>;
  textEditorDirty: boolean;
  setConfigFile: (filename: string, config: ConfigFile) => void;
  setValidation: (filename: string, validation: ValidationResult) => void;
  clearTextDraft: (filename: string) => void;
  markDirty: () => void;
  clearMessages: () => void;
  loadedConfigFilenames: string[];
}) {
  const {
    messages,
    setMessages,
    configFiles,
    activeFile,
    textDrafts,
    setConfigFile,
    setValidation,
    clearTextDraft,
    markDirty,
    clearMessages,
    loadedConfigFilenames,
  } = deps;

  // ── State ─────────────────────────────────────────────────────────

  const [assistantDraftPreview, setAssistantDraftPreview] = useState<AssistantDraftPreview | null>(null);
  const [assistantDraftPreviewLoading, setAssistantDraftPreviewLoading] = useState<string | null>(null);
  const [assistantDraftApplicableMessages, setAssistantDraftApplicableMessages] = useState<Record<number, boolean>>({});

  const assistantDraftPreviewRequestRef = useRef(0);

  // ── Helpers ───────────────────────────────────────────────────────

  const getConfigText = useCallback(
    async (filename: string): Promise<string | null> => {
      if (!filename) return null;
      const draftText = textDrafts[filename];
      if (typeof draftText === 'string') return draftText;
      const config = configFiles[filename];
      if (!config) return null;
      return api.exportConfig(config);
    },
    [configFiles, textDrafts],
  );

  const flattenAssistantDraftChanges = useCallback(
    (filePreviews: AssistantDraftFilePreview[]): AssistantDraftChange[] =>
      filePreviews.flatMap((fp) => fp.changes),
    [],
  );

  const buildAssistantDraftMergedText = useCallback(
    async (
      baseConfig: ConfigFile,
      assistantConfig: ConfigFile,
      originalText: string,
      selectedChangeIds: string[],
    ): Promise<string> => {
      if (selectedChangeIds.length === 0) return originalText;
      const { mergedConfig } = mergeAssistantSectionsIntoConfig(baseConfig, assistantConfig, selectedChangeIds);
      return api.exportConfig({ ...mergedConfig, raw_text: originalText });
    },
    [],
  );

  const getAssistantMessageHintTexts = useCallback(
    (content: string, messageIndex?: number, messageHistory: ChatMessage[] = messages): string[] => {
      if (messageIndex == null) return [content];
      const hintTexts = [content];
      let collectedUserMessages = 0;
      for (let index = messageIndex - 1; index >= 0; index -= 1) {
        const candidate = messageHistory[index];
        if (candidate?.role === 'user') {
          hintTexts.push(candidate.content);
          collectedUserMessages += 1;
          if (collectedUserMessages >= MAX_ASSISTANT_HINT_USER_MESSAGES) break;
        }
      }
      return hintTexts;
    },
    [messages],
  );

  const buildAssistantDraftTargetConfigs = useCallback(
    async (
      content: string,
      messageIndex?: number,
      messageHistory: ChatMessage[] = messages,
    ): Promise<ConfigFile[]> => {
      const configBlocks = extractConfigCodeBlocks(content);
      if (configBlocks.length === 0) {
        throw new Error('The assistant response did not include a config code block to review.');
      }

      const hintTexts = getAssistantMessageHintTexts(content, messageIndex, messageHistory);
      const mentionedFilenames = extractMentionedConfigFilenames(hintTexts, loadedConfigFilenames);
      const groupedTargets = new Map<string, ConfigFile>();

      for (const configBlock of configBlocks) {
        const { configText, fileHint } = extractAssistantFileHint(configBlock, loadedConfigFilenames);
        if (!configText.trim()) continue;

        const assistantParseFilename = fileHint ?? mentionedFilenames[0] ?? activeFile ?? loadedConfigFilenames[0] ?? 'printer.cfg';
        const processedConfigText = preprocessDeleteMarkers(configText);
        const assistantResult = await api.parseConfigText(processedConfigText, assistantParseFilename);

        if (assistantResult.config.sections.length === 0) continue;

        const targetFile = resolveAssistantTargetFile(
          assistantResult.config,
          configFiles,
          activeFile,
          fileHint ? [fileHint] : mentionedFilenames,
        );
        if (!targetFile) {
          throw new Error('Unable to determine which config file should receive the assistant changes.');
        }

        const existingTarget = groupedTargets.get(targetFile);
        if (existingTarget) {
          groupedTargets.set(targetFile, {
            ...existingTarget,
            includes: Array.from(new Set([...existingTarget.includes, ...assistantResult.config.includes])),
            header_comments: existingTarget.header_comments.length > 0 ? existingTarget.header_comments : assistantResult.config.header_comments,
            sections: [...existingTarget.sections, ...assistantResult.config.sections],
          });
        } else {
          groupedTargets.set(targetFile, {
            ...assistantResult.config,
            filename: targetFile,
            includes: [...assistantResult.config.includes],
            header_comments: [...assistantResult.config.header_comments],
            sections: [...assistantResult.config.sections],
          });
        }
      }

      if (groupedTargets.size === 0) {
        throw new Error('The assistant response did not include any complete config sections to merge.');
      }
      return Array.from(groupedTargets.values());
    },
    [activeFile, configFiles, getAssistantMessageHintTexts, loadedConfigFilenames],
  );

  const prepareAssistantDraftPreview = useCallback(
    async (content: string, messageIndex?: number, messageHistory: ChatMessage[] = messages): Promise<AssistantDraftPreview> => {
      const assistantConfigs = await buildAssistantDraftTargetConfigs(content, messageIndex, messageHistory);
      const filePreviews: AssistantDraftFilePreview[] = [];

      for (const assistantConfig of assistantConfigs) {
        const targetFile = assistantConfig.filename;
        const baseText = await getConfigText(targetFile);
        if (baseText == null) {
          throw new Error(`Unable to load ${targetFile} for preview.`);
        }

        const baseResult = await api.parseConfigText(baseText, targetFile);
        const baseConfig = { ...baseResult.config, raw_text: baseText };
        const { mergedConfig, changes } = mergeAssistantSectionsIntoConfig(baseConfig, assistantConfig);
        const mergedText = await api.exportConfig({ ...mergedConfig, raw_text: baseText });

        if (normalizeDiffText(baseText) === normalizeDiffText(mergedText)) continue;

        filePreviews.push({ filename: targetFile, originalText: baseText, baseConfig, assistantConfig, mergedText, changes });
      }

      if (filePreviews.length === 0) {
        throw new Error('The assistant response does not change the current draft.');
      }

      return {
        filePreviews,
        selectedChangeIds: flattenAssistantDraftChanges(filePreviews).map((change) => change.id),
        previewUpdating: false,
      };
    },
    [buildAssistantDraftTargetConfigs, flattenAssistantDraftChanges, getConfigText, messages],
  );

  const canAssistantMessageAffectDraft = useCallback(
    async (content: string, messageIndex?: number, messageHistory: ChatMessage[] = messages): Promise<boolean> => {
      try {
        await prepareAssistantDraftPreview(content, messageIndex, messageHistory);
        return true;
      } catch {
        return false;
      }
    },
    [messages, prepareAssistantDraftPreview],
  );

  // ── Validation ────────────────────────────────────────────────────

  const buildProjectConfigsForValidation = useCallback(async (): Promise<Record<string, ConfigFile>> => {
    const currentProjectConfigs: Record<string, ConfigFile> = { ...configFiles };
    const draftEntries = Object.entries(textDrafts);

    if (draftEntries.length === 0) return currentProjectConfigs;

    const draftResults = await Promise.all(
      draftEntries.map(async ([filename, draftText]) => {
        const result = await api.parseConfigText(draftText, filename);
        return [filename, draftText, result] as const;
      }),
    );

    draftResults.forEach(([filename, draftText, draftResult]) => {
      currentProjectConfigs[filename] = { ...draftResult.config, raw_text: draftText };
    });

    return currentProjectConfigs;
  }, [configFiles, textDrafts]);

  const runAssistantDraftValidation = useCallback(
    async (
      content: string,
      messageIndex?: number,
      messageHistory: ChatMessage[] = messages,
      requireApplicable = false,
    ): Promise<AssistantDraftValidationOutcome> => {
      let preview: AssistantDraftPreview;

      try {
        preview = await prepareAssistantDraftPreview(content, messageIndex, messageHistory);
      } catch (err: unknown) {
        if (!requireApplicable) {
          return { applicable: false, blockingIssues: [], failureReason: null };
        }
        return {
          applicable: false,
          blockingIssues: [],
          failureReason: err instanceof Error ? err.message : 'The reply did not include a complete applicable cfg draft.',
        };
      }

      const baselineProjectConfigs = await buildProjectConfigsForValidation();
      preview.filePreviews.forEach((fp) => {
        baselineProjectConfigs[fp.filename] = fp.baseConfig;
      });

      const candidateProjectConfigs = { ...baselineProjectConfigs };
      const mergedConfigs = await Promise.all(
        preview.filePreviews.map(async (fp) => {
          const result = await api.parseConfigText(fp.mergedText, fp.filename);
          return [fp.filename, { ...result.config, raw_text: fp.mergedText }] as const;
        }),
      );
      mergedConfigs.forEach(([filename, config]) => {
        candidateProjectConfigs[filename] = config;
      });

      const [baselineValidations, candidateValidations] = await Promise.all([
        api.validateProject(baselineProjectConfigs),
        api.validateProject(candidateProjectConfigs),
      ]);

      return {
        applicable: true,
        blockingIssues: collectNewValidationErrors(baselineValidations, candidateValidations),
        failureReason: null,
      };
    },
    [buildProjectConfigsForValidation, messages, prepareAssistantDraftPreview],
  );

  // ── Request Assistant Message (with auto-doc loading & separator rewrite) ──

  const requestAssistantMessage = useCallback(
    async (
      chatRequestBase: ChatRequestBase,
      conversationMessages: Array<{ role: AiChatRole; content: string }>,
      onMessageUpdate?: (msg: ChatMessage) => void,
    ): Promise<AssistantReplyAttempt> => {
      const response = await api.aiChat({ ...chatRequestBase, messages: conversationMessages });

      if (response.error) throw new Error(response.error);

      let assistantMessage: ChatMessage = {
        role: 'assistant',
        content: response.content || 'No response.',
        lmStudioContext: response.lmStudioContext,
        mcpToolNames: response.mcpToolNames,
      };
      let conversationTrail: ChatMessage[] = [{ role: 'assistant', content: assistantMessage.content }];
      let warningMessage: string | null = null;

      // Auto-load Klipper docs if the assistant requests them
      const requestedKlipperDocs = extractRequestedKlipperDocFilenames(assistantMessage.content);
      if (requestedKlipperDocs.length > 0) {
        try {
          const docResults = await Promise.allSettled(requestedKlipperDocs.map((filename) => api.getKlipperDoc(filename)));
          const loadedDocs = docResults.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));

          if (loadedDocs.length === 0) {
            warningMessage = `The assistant requested full Klipper docs (${requestedKlipperDocs.join(', ')}), but none of those bundled markdown files were available from the backend.`;
          } else {
            const autoLoadedDocsMessage = buildAutoLoadedKlipperDocMessage(loadedDocs);
            const followUpResponse = await api.aiChat({
              ...chatRequestBase,
              messages: [
                ...conversationMessages,
                ...conversationTrail.map((m) => ({ role: m.role as AiChatRole, content: m.content })),
                { role: 'user', content: autoLoadedDocsMessage },
              ],
            });

            if (followUpResponse.error) throw new Error(followUpResponse.error);

            assistantMessage = {
              role: 'assistant',
              content: followUpResponse.content || assistantMessage.content,
              lmStudioContext: followUpResponse.lmStudioContext ?? assistantMessage.lmStudioContext,
              autoLoadedDocs: loadedDocs.map((d) => d.filename),
              mcpToolNames: followUpResponse.mcpToolNames ?? assistantMessage.mcpToolNames,
            };
            conversationTrail = [
              ...conversationTrail,
              { role: 'user', content: autoLoadedDocsMessage },
              { role: 'assistant', content: assistantMessage.content },
            ];
          }
        } catch (autoDocErr: unknown) {
          warningMessage = `Automatic full-doc follow-up failed: ${autoDocErr instanceof Error ? autoDocErr.message : 'Unknown error'}`;
        }
      }

      // Rewrite equals-sign separators to colons if present
      const equalsSeparatedLines = extractEqualsSeparatedConfigLines(assistantMessage.content);
      if (equalsSeparatedLines.length > 0) {
        const rewritePrompt = buildConfigSeparatorRewritePrompt(equalsSeparatedLines);
        try {
          const rewriteResponse = await api.aiChat({
            ...chatRequestBase,
            messages: [
              ...conversationMessages,
              ...conversationTrail.map((m) => ({ role: m.role as AiChatRole, content: m.content })),
              { role: 'user', content: rewritePrompt },
            ],
          });

          if (rewriteResponse.error) throw new Error(rewriteResponse.error);

          assistantMessage = {
            role: 'assistant',
            content: rewriteResponse.content || assistantMessage.content,
            lmStudioContext: rewriteResponse.lmStudioContext ?? assistantMessage.lmStudioContext,
            autoLoadedDocs: assistantMessage.autoLoadedDocs,
            mcpToolNames: rewriteResponse.mcpToolNames ?? assistantMessage.mcpToolNames,
          };
          conversationTrail = [
            ...conversationTrail,
            { role: 'user', content: rewritePrompt },
            { role: 'assistant', content: assistantMessage.content },
          ];

          if (extractEqualsSeparatedConfigLines(assistantMessage.content).length > 0) {
            warningMessage = appendWarningMessage(
              warningMessage,
              'The assistant was asked to rewrite cfg assignments with colons, but the replacement reply still included equals-sign separators.',
            );
          }
        } catch (rewriteErr: unknown) {
          warningMessage = appendWarningMessage(
            warningMessage,
            `Automatic cfg separator rewrite failed: ${rewriteErr instanceof Error ? rewriteErr.message : 'Unknown error'}`,
          );
        }
      }

      return { assistantMessage, conversationMessages: conversationTrail, warningMessage };
    },
    [],
  );

  // ── Preview Handlers ──────────────────────────────────────────────

  const handleApplyAssistantEdit = useCallback(
    async (content: string, messageIndex?: number) => {
      setAssistantDraftPreviewLoading(content);
      try {
        setAssistantDraftPreview(await prepareAssistantDraftPreview(content, messageIndex));
      } catch (err: unknown) {
        setAssistantDraftPreview(null);
        throw err; // Let caller handle the error
      } finally {
        setAssistantDraftPreviewLoading(null);
      }
    },
    [prepareAssistantDraftPreview],
  );

  const handleAssistantDraftSelectionChange = useCallback(
    async (selectedChangeIds: string[]) => {
      const current = assistantDraftPreview;
      if (!current) return;

      if (
        selectedChangeIds.length === current.selectedChangeIds.length &&
        selectedChangeIds.every((id, i) => id === current.selectedChangeIds[i])
      ) return;

      const requestId = ++assistantDraftPreviewRequestRef.current;
      setAssistantDraftPreview({ ...current, selectedChangeIds, previewUpdating: true });

      try {
        const filePreviews = await Promise.all(
          current.filePreviews.map(async (fp) => ({
            ...fp,
            mergedText: await buildAssistantDraftMergedText(fp.baseConfig, fp.assistantConfig, fp.originalText, selectedChangeIds),
          })),
        );

        if (requestId !== assistantDraftPreviewRequestRef.current) return;

        setAssistantDraftPreview((prev) => {
          if (!prev) return prev;
          return { ...prev, selectedChangeIds, filePreviews, previewUpdating: false };
        });
      } catch {
        if (requestId !== assistantDraftPreviewRequestRef.current) return;
        setAssistantDraftPreview((prev) => {
          if (!prev) return prev;
          return { ...prev, previewUpdating: false };
        });
      }
    },
    [assistantDraftPreview, buildAssistantDraftMergedText],
  );

  const handleAcceptAssistantEdit = useCallback(async () => {
    const currentPreview = assistantDraftPreview;
    if (!currentPreview) return;

    try {
      const selectedChangeIds = new Set(currentPreview.selectedChangeIds);
      const updatedConfigs = { ...configFiles };
      const updatedValidation = { ...deps.validation };
      const touchedFiles: string[] = [];

      for (const fp of currentPreview.filePreviews) {
        const hasSelectedChanges = fp.changes.some((change) => selectedChangeIds.has(change.id));
        if (!hasSelectedChanges) continue;
        if (normalizeDiffText(fp.originalText) === normalizeDiffText(fp.mergedText)) continue;

        const result = await api.parseConfigText(fp.mergedText, fp.filename);
        updatedConfigs[fp.filename] = result.config;
        updatedValidation[fp.filename] = result.validation;
        touchedFiles.push(fp.filename);
      }

      if (touchedFiles.length === 0) {
        setAssistantDraftPreview(null);
        return;
      }

      touchedFiles.forEach((filename) => {
        setConfigFile(filename, updatedConfigs[filename]);
        setValidation(filename, updatedValidation[filename]);
      });
      touchedFiles.forEach((filename) => clearTextDraft(filename));
      markDirty();

      setAssistantDraftPreview(null);
    } catch (err: unknown) {
      throw err; // Let caller handle the error
    }
  }, [assistantDraftPreview, configFiles, deps.validation, setConfigFile, setValidation, clearTextDraft, markDirty]);

  // ── Applicable Messages (for showing/hiding "Apply and Review Changes" buttons) ──

  const updateAssistantDraftApplicableMessages = useCallback(
    async (messagesToCheck: ChatMessage[]) => {
      const assistantMessages = messagesToCheck
        .map((msg, index) => ({ msg, index }))
        .filter(({ msg }) => msg.role === 'assistant' && extractConfigCodeBlocks(msg.content).length > 0);

      if (assistantMessages.length === 0) {
        setAssistantDraftApplicableMessages({});
        return;
      }

      const availabilityEntries = await Promise.all(
        assistantMessages.map(async ({ msg, index }) => [index, await canAssistantMessageAffectDraft(msg.content, index, messagesToCheck)] as const),
      );

      setAssistantDraftApplicableMessages(Object.fromEntries(availabilityEntries));
    },
    [canAssistantMessageAffectDraft],
  );

  // ── Validation Retry Loop ──

  const runValidationRetryLoop = useCallback(
    async (
      chatRequestBase: ChatRequestBase,
      requestConversation: Array<{ role: AiChatRole; content: string }>,
      validationConversation: ChatMessage[],
      assistantAttempt: AssistantReplyAttempt,
    ): Promise<{
      finalMessage: ChatMessage;
      finalConversation: ChatMessage[];
      warningMessage: string | null;
    }> => {
      let currentAttempt = assistantAttempt;
      let candidateConversation = [...validationConversation, ...currentAttempt.conversationMessages];
      let validationOutcome = await runAssistantDraftValidation(
        currentAttempt.assistantMessage.content,
        candidateConversation.length - 1,
        candidateConversation,
        false,
      );
      let attemptsUsed = 1;
      let pendingWarningMessage = currentAttempt.warningMessage;

      while (shouldRetryAssistantValidation(validationOutcome, attemptsUsed)) {
        if (attemptsUsed >= MAX_ASSISTANT_DRAFT_VALIDATION_ATTEMPTS) {
          throw new Error(
            buildAssistantDraftValidationErrorMessage(validationOutcome.blockingIssues, validationOutcome.failureReason, attemptsUsed),
          );
        }

        const allowExplanationOnly = hasOnlyRetryExemptAssistantValidationIssues(validationOutcome.blockingIssues);
        const validationFeedback = buildAssistantDraftValidationFeedback(
          validationOutcome.blockingIssues,
          currentAttempt.assistantMessage.content,
          validationOutcome.failureReason,
          allowExplanationOnly,
        );

        requestConversation = [
          ...requestConversation,
          ...currentAttempt.conversationMessages.map((m) => ({ role: m.role as AiChatRole, content: m.content })),
          { role: 'user', content: validationFeedback },
        ];
        validationConversation = [...candidateConversation, { role: 'user', content: validationFeedback }];
        currentAttempt = await requestAssistantMessage(chatRequestBase, requestConversation);
        pendingWarningMessage = currentAttempt.warningMessage ?? pendingWarningMessage;
        candidateConversation = [...validationConversation, ...currentAttempt.conversationMessages];
        attemptsUsed += 1;
        validationOutcome = await runAssistantDraftValidation(
          currentAttempt.assistantMessage.content,
          candidateConversation.length - 1,
          candidateConversation,
          !allowExplanationOnly,
        );
      }

      if (
        validationOutcome.applicable &&
        validationOutcome.blockingIssues.length > 0 &&
        hasOnlyRetryExemptAssistantValidationIssues(validationOutcome.blockingIssues)
      ) {
        const advisoryWarning = [
          `AI draft still has duplicate section or pin-conflict validation issues after ${attemptsUsed} attempts. The assistant response was returned so it can explain the conflict.`,
          formatAssistantDraftValidationIssues(validationOutcome.blockingIssues, null),
        ].join('\n');
        pendingWarningMessage = pendingWarningMessage ? `${pendingWarningMessage}\n${advisoryWarning}` : advisoryWarning;
      }

      if (!validationOutcome.applicable && validationOutcome.failureReason) {
        throw new Error(
          buildAssistantDraftValidationErrorMessage(validationOutcome.blockingIssues, validationOutcome.failureReason, attemptsUsed),
        );
      }

      return {
        finalMessage: currentAttempt.assistantMessage,
        finalConversation: candidateConversation,
        warningMessage: pendingWarningMessage,
      };
    },
    [requestAssistantMessage, runAssistantDraftValidation],
  );

  // ── New Chat ──────────────────────────────────────────────────────

  const handleNewChat = useCallback(() => {
    clearMessages();
    setAssistantDraftPreview(null);
  }, [clearMessages]);

  // ── Return ────────────────────────────────────────────────────────

  return {
    assistantDraftPreview,
    setAssistantDraftPreview,
    assistantDraftPreviewLoading,
    assistantDraftApplicableMessages,
    setAssistantDraftApplicableMessages,
    getConfigText,
    buildAssistantDraftMergedText,
    getAssistantMessageHintTexts,
    prepareAssistantDraftPreview,
    canAssistantMessageAffectDraft,
    runAssistantDraftValidation,
    requestAssistantMessage,
    runValidationRetryLoop,
    handleApplyAssistantEdit,
    handleAssistantDraftSelectionChange,
    handleAcceptAssistantEdit,
    handleNewChat,
    updateAssistantDraftApplicableMessages,
    flattenAssistantDraftChanges,
  };
}
