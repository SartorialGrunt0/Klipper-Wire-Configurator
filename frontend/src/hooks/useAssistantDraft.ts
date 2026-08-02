/**
 * Hook encapsulating all AI draft validation, preview, and merge logic.
 *
 * Extracted from ChatDialog.tsx to reduce component complexity and make
 * the validation flow testable in isolation.
 */
import { useState, useRef, useCallback } from 'react';
import type { ChatMessage } from '../stores/aiStore';
import { useAiStore } from '../stores/aiStore';
import { useConfigStore } from '../stores/configStore';
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
  appendWarningMessage,
  rewriteConfigEqualsSeparators,
} from '../utils/chatUtils';
import {
  buildAssistantDraftValidationFeedback,
  buildAssistantDraftValidationErrorMessage,
  hasOnlyRetryExemptAssistantValidationIssues,
  formatAssistantDraftValidationIssues,
  MAX_ASSISTANT_DRAFT_VALIDATION_ATTEMPTS,
  MAX_ASSISTANT_HINT_USER_MESSAGES,
  collectNewValidationErrors,
  type AssistantDraftValidationOutcome,
  type AssistantDraftValidationIssueGroup,
} from '../utils/draftValidation';
import type { AssistantDraftChange } from '../utils/assistantDraftMerge';
import { mergeAssistantSectionsIntoConfig, preprocessDeleteMarkers } from '../utils/assistantDraftMerge';
import { normalizeDiffText } from '../utils/configDiff';
import { isMiniDiffBlock, applyMiniDiffBlock } from '../utils/miniDiff';
import type { ReplyValidator } from '../utils/replyValidation';

// ── Internal Types ──────────────────────────────────────────────────

interface AssistantDraftFilePreview {
  filename: string;
  originalText: string;
  baseConfig: ConfigFile;
  assistantConfig: ConfigFile;
  mergedConfig: ConfigFile;
  mergedText: string;
  changes: AssistantDraftChange[];
  mergedValidation?: ValidationResult;
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
  /** Client-generated id used to signal a user-initiated stop. */
  requestId?: string;
  /** Maximum number of tokens the provider should generate. */
  maxTokens?: number;
  /** Sampling temperature for the provider (0-2). Omit for provider default. */
  temperature?: number;
}

interface SubmitMessageOptions {
  hiddenFromUser?: boolean;
}

// ── Hook ────────────────────────────────────────────────────────────

export function useAssistantDraft() {
  const { messages, setMessages, clearMessages } = useAiStore();
  const {
    configFiles,
    activeFile,
    validation,
    textDrafts,
    setConfigFile,
    setValidation,
    clearTextDraft,
    markDirty,
  } = useConfigStore();
  const loadedConfigFilenames = Object.keys(configFiles);

  // ── State ─────────────────────────────────────────────────────────

  const [assistantDraftPreview, setAssistantDraftPreview] = useState<AssistantDraftPreview | null>(null);
  const [assistantDraftPreviewLoading, setAssistantDraftPreviewLoading] = useState<string | null>(null);
  const [assistantDraftApplicableMessages, setAssistantDraftApplicableMessages] = useState<Record<number, boolean>>({});

  const assistantDraftPreviewRequestRef = useRef(0);

  // ── Helpers ───────────────────────────────────────────────────────

  const getConfigText = useCallback(
    async (filename: string): Promise<string> => {
      if (!filename) return '';
      const draftText = textDrafts[filename];
      if (typeof draftText === 'string') return draftText;
      const config = configFiles[filename];
      if (!config) return '';
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

        // Mini-diff protocol: when the block contains '-'/'+' line edits for an
        // existing section, materialize the full section from the current file
        // text BEFORE parsing. Unchanged lines (including Jinja tags in macros)
        // are preserved verbatim from the base file, so the model can never
        // drop them. If the edit cannot be applied (e.g. the section is not in
        // the base file), fall back to the raw block so the normal parse and
        // validation feedback handles it.
        let draftConfigText = configText;
        if (isMiniDiffBlock(draftConfigText)) {
          const baseFileText = await getConfigText(assistantParseFilename);
          if (baseFileText) {
            const applied = applyMiniDiffBlock(draftConfigText, baseFileText);
            if (applied.applied) {
              draftConfigText = applied.text;
            }
          }
        }

        const processedConfigText = preprocessDeleteMarkers(draftConfigText);
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
    [activeFile, configFiles, getAssistantMessageHintTexts, getConfigText, loadedConfigFilenames],
  );

  const prepareAssistantDraftPreview = useCallback(
    async (content: string, messageIndex?: number, messageHistory: ChatMessage[] = messages): Promise<AssistantDraftPreview> => {
      const assistantConfigs = await buildAssistantDraftTargetConfigs(content, messageIndex, messageHistory);
      const filePreviews: AssistantDraftFilePreview[] = [];

      for (const assistantConfig of assistantConfigs) {
        const targetFile = assistantConfig.filename;
        const baseText = await getConfigText(targetFile);

        if (!baseText) {
          // The assistant proposed a NEW file that does not exist yet.
          // Build the preview against an empty base so every section shows
          // up as an addition, the "new file" badge appears in the preview
          // dialog, and the user can review + create the file.
          console.info('[AIDraft] New file proposed by assistant:', targetFile);
          const emptyBaseConfig: ConfigFile = {
            filename: targetFile,
            includes: [],
            header_comments: [],
            sections: [],
            raw_text: '',
          };
          const { mergedConfig, changes } = mergeAssistantSectionsIntoConfig(emptyBaseConfig, assistantConfig);
          const mergedText = await api.exportConfig({ ...mergedConfig, raw_text: '' });
          filePreviews.push({
            filename: targetFile,
            originalText: '',
            baseConfig: emptyBaseConfig,
            assistantConfig,
            mergedConfig,
            mergedText,
            changes,
          });
          continue;
        }

        const baseResult = await api.parseConfigText(baseText, targetFile);
        const baseConfig = { ...baseResult.config, raw_text: baseText };
        const { mergedConfig, changes } = mergeAssistantSectionsIntoConfig(baseConfig, assistantConfig);
        const mergedText = await api.exportConfig({ ...mergedConfig, raw_text: baseText });

        const textChanged = normalizeDiffText(baseText) !== normalizeDiffText(mergedText);
        console.debug('[AIDraft] File:', targetFile, '| baseSections:', baseResult.config.sections.length, '| mergedSections:', mergedConfig.sections.length, '| changes:', changes.length, '| textChanged:', textChanged, '| emptyBase:', !baseText);

        // Include the file even if text didn't change, as long as there
        // are change entries (e.g. non-existent delete targets proposed
        // by the AI). The dialog will show the changes pills even if
        // the diff is empty, and the accept flow harmlessy skips files
        // whose text didn't actually change.
        if (!textChanged && changes.length === 0) continue;

        filePreviews.push({
          filename: targetFile,
          originalText: baseText,
          baseConfig,
          assistantConfig,
          mergedConfig,
          mergedText,
          changes,
        });
      }

      if (filePreviews.length === 0) {
        console.warn('[AIDraft] No file previews — all target files had identical merged text');
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
      } catch (err: unknown) {
        console.warn('[AIDraft] Assistant message not applicable:', err instanceof Error ? err.message : err);
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

      // Check for delete markers targeting sections that don't exist
      // in the base config. The AI should be told so it can correct
      // itself rather than silently dropping the suggestion.
      const missingSectionIssues: AssistantDraftValidationIssueGroup[] = [];
      for (const fp of preview.filePreviews) {
        const baseConfig = fp.baseConfig;
        const baseHeaders = new Set(baseConfig.sections.map((s) => s.full_header));
        const missingTargets = fp.changes
          .filter((c) => c.mode === 'delete' && !baseHeaders.has(c.fullHeader))
          .map((c) => c.fullHeader);
        if (missingTargets.length > 0) {
          missingSectionIssues.push({
            filename: fp.filename,
            errors: missingTargets.map((header) => ({
              severity: 'warning' as const,
              message: `Section '[${header}]' does not exist in '${fp.filename}' and cannot be deleted.`,
              section: header,
              param: '',
              line_number: 0,
            })),
          });
        }
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
        blockingIssues: [
          ...collectNewValidationErrors(baselineValidations, candidateValidations),
          ...missingSectionIssues,
        ],
        failureReason: null,
      };
    },
    [buildProjectConfigsForValidation, messages, prepareAssistantDraftPreview],
  );

  // ── Request Assistant Message (with auto-doc loading & separator post-processing) ──

  const requestAssistantMessage = useCallback(
    async (
      chatRequestBase: ChatRequestBase,
      conversationMessages: Array<{ role: AiChatRole; content: string }>,
      onMessageUpdate?: (msg: ChatMessage) => void,
      options?: { signal?: AbortSignal },
    ): Promise<AssistantReplyAttempt> => {
      const response = await api.aiChat({ ...chatRequestBase, messages: conversationMessages }, options?.signal);

      if (response.error) throw new Error(response.error);

      let assistantMessage: ChatMessage = {
        role: 'assistant',
        content: response.content || 'No response.',
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
            }, options?.signal);

            if (followUpResponse.error) throw new Error(followUpResponse.error);

            assistantMessage = {
              role: 'assistant',
              content: followUpResponse.content || assistantMessage.content,
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

      // Normalise cfg separators (`key = value` → `key: value`) as local
      // post-processing. Previously this was a full AI re-query; the
      // deterministic rewrite is instant and cannot fail or drift.
      const rewrittenContent = rewriteConfigEqualsSeparators(assistantMessage.content);
      if (rewrittenContent !== assistantMessage.content) {
        assistantMessage = { ...assistantMessage, content: rewrittenContent };
        const lastIndex = conversationTrail.length - 1;
        if (lastIndex >= 0) {
          conversationTrail[lastIndex] = { ...conversationTrail[lastIndex], content: rewrittenContent };
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
      const updatedValidation = { ...validation };
      const touchedFiles: string[] = [];

      for (const fp of currentPreview.filePreviews) {
        const hasSelectedChanges = fp.changes.some((change) => selectedChangeIds.has(change.id));
        console.debug('[AIDraft] Accept check | file:', fp.filename, '| changes:', fp.changes.length, '| selectedAny:', hasSelectedChanges, '| mergedLen:', fp.mergedText.length, '| origLen:', fp.originalText.length);
        if (!hasSelectedChanges) continue;
        if (normalizeDiffText(fp.originalText) === normalizeDiffText(fp.mergedText)) {
          console.warn('[AIDraft] Skipping file with no text diff despite selected changes:', fp.filename);
          continue;
        }

        // Use the cached merged config directly instead of re-parsing
        updatedConfigs[fp.filename] = fp.mergedConfig;
        // Validate — lighter than parse since we already have the parsed config
        try {
          updatedValidation[fp.filename] = await api.validateConfig(fp.mergedConfig);
        } catch {
          // Validation failure shouldn't block the edit
        }
        touchedFiles.push(fp.filename);
      }

      if (touchedFiles.length === 0) {
        console.warn('[AIDraft] No files with actual text changes — abandoning accept');
        setAssistantDraftPreview(null);
        return;
      }
      console.debug('[AIDraft] Accepting', touchedFiles.length, 'files:', touchedFiles);

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
  }, [assistantDraftPreview, configFiles, validation, setConfigFile, setValidation, clearTextDraft, markDirty]);

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

  // ── Draft Reply Validator ────────────────────────────────────────
  // Conforms to the shared ReplyValidator interface driven by
  // runReplyValidationPipeline (utils/replyValidation.ts).

  const createDraftReplyValidator = useCallback((): ReplyValidator => {
    // Remember the most recent validation outcome so buildFeedback and
    // onMaxAttemptsReached can rebuild the structured feedback message.
    let lastOutcome: AssistantDraftValidationOutcome | null = null;

    return {
      name: 'config-draft',
      maxAttempts: MAX_ASSISTANT_DRAFT_VALIDATION_ATTEMPTS,
      failMode: 'throw',

      validate: async (content, context) => {
        // On the first check a plain Q&A reply (no config draft) is fine.
        // On retries the AI must produce a usable draft unless the previous
        // feedback allowed an explanation-only response.
        const requireApplicable = context.isRetry && !context.allowExplanationOnly;
        const outcome = await runAssistantDraftValidation(
          content,
          context.messageIndex,
          context.messageHistory,
          requireApplicable,
        );
        lastOutcome = outcome;

        if (!outcome.applicable) {
          if (!context.isRetry || !outcome.failureReason) {
            return { applicable: false, issues: [], failureReason: outcome.failureReason };
          }
          // AI gave up on producing a draft during a retry — treat as blocking.
          return {
            applicable: true,
            issues: [{ type: 'config-draft', message: outcome.failureReason }],
            failureReason: outcome.failureReason,
          };
        }

        // Duplicate-section / shared-pin issues the AI cannot resolve are
        // advisory only after one retry — keep the reply and warn instead.
        const giveUp =
          context.isRetry && hasOnlyRetryExemptAssistantValidationIssues(outcome.blockingIssues);

        return {
          applicable: true,
          issues: outcome.blockingIssues.flatMap((group) =>
            group.errors.map((error) => {
              const location = error.param ? `[${error.section}] ${error.param}` : `[${error.section}]`;
              return {
                type: 'config-draft',
                message: `${group.filename}: ${location}: ${error.message}`,
              };
            }),
          ),
          failureReason: null,
          giveUp,
          warningOnGiveUp: giveUp
            ? [
                `AI draft still has duplicate section or pin-conflict validation issues after ${context.attemptsUsed + 1} attempts. The assistant response was returned so it can explain the conflict.`,
                formatAssistantDraftValidationIssues(outcome.blockingIssues, null),
              ].join('\n')
            : null,
        };
      },

      buildFeedback: (content, result) => {
        if (!lastOutcome) return null;
        const allowExplanationOnly = hasOnlyRetryExemptAssistantValidationIssues(lastOutcome.blockingIssues);
        return {
          content: buildAssistantDraftValidationFeedback(
            lastOutcome.blockingIssues,
            content,
            result.failureReason,
            allowExplanationOnly,
          ),
          allowExplanationOnly,
        };
      },

      onMaxAttemptsReached: (_content, result, totalAttempts) =>
        buildAssistantDraftValidationErrorMessage(
          lastOutcome?.blockingIssues ?? [],
          result.failureReason ?? lastOutcome?.failureReason ?? null,
          totalAttempts,
        ),

      // Request errors (network, API) propagate to the caller unchanged.
      handleRequestError: () => null,
    };
  }, [runAssistantDraftValidation]);

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
    createDraftReplyValidator,
    handleApplyAssistantEdit,
    handleAssistantDraftSelectionChange,
    handleAcceptAssistantEdit,
    handleNewChat,
    updateAssistantDraftApplicableMessages,
    flattenAssistantDraftChanges,
  };
}
