/**
 * AI Chat Dialog
 *
 * Orchestrates the full AI chat experience:
 * - Unconfigured state shows ChatSettingsPanel (standalone mode)
 * - Configured state shows title bar, optional inline settings,
 *   message list, and input bar
 * - Message submission runs validation retry loop via useAssistantDraft
 *
 * Single source of truth for settings editing state lives here,
 * passed down to ChatSettingsPanel as props.
 */
import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useAiStore, AiProvider, providerRequiresApiKey, type ChatMessage } from '../../stores/aiStore';
import { useChatHistoryStore } from '../../stores/chatHistoryStore';
import { useConfigStore } from '../../stores/configStore';
import { useGraphStore } from '../../stores/graphStore';
import { usePrinterMemoryStore, DEFAULT_PRINTER_MEMORY, type PrinterMemory } from '../../stores/printerMemoryStore';
import * as api from '../../services/api';
import {
  buildConfigIndexMessage,
  extractMentionedConfigFilenames,
} from '../../utils/chatUtils';
import { extractPrinterMemoryBlock } from '../../utils/printerMemory';
import {
  PROVIDER_DEFAULTS,
  isLocalProvider,
  resolveProviderApiUrl,
  getProviderModel,
} from '../../utils/chatProviders';
import { runReplyValidationPipeline, createPrinterMemoryReplyValidator } from '../../utils/replyValidation';
import {
  extractTargetedSectionHeaders,
  extractSectionText,
  findSectionHeaders,
  buildSectionContextMessage,
} from '../../utils/chatIntent';
import { buildProjectGraph } from '../../utils/graphBuilder';
import { useAssistantDraft, FULL_REWRITE_GUARD_ENABLED } from '../../hooks/useAssistantDraft';
import ChatSettingsPanel from './ChatSettingsPanel';
import ChatHistoryDialog from './ChatHistoryDialog';
import PrinterMemoryDialog from './PrinterMemoryDialog';
import ChatMessageList from './ChatMessageList';
import ChatInputBar from './ChatInputBar';
import AiDraftPreviewDialog from './AiDraftPreviewDialog';
import type { PendingAiChatRequest } from '../../types/ai';
import type { AiChatRole } from '../../services/api';
import type { SavedConversation } from '../../stores/chatHistoryStore';

/**
 * Frontend "handholding" gate (Phase 4/5 lean injection + file-targeting
 * reinforcement).
 *
 * Default OFF: a capable model discovers config content and targets the
 * right files through its MCP tools plus the backend SYSTEM_PROMPT edit
 * protocol (validated by the harness — AMBI-01..08 pass with zero injected
 * content and no frontend reinforcement). The regex-targeted injection can
 * also steer the model toward the wrong section.
 * Re-enable at build time with VITE_KWC_HANDHOLDING=1 for very small models
 * with flaky tool calling: the guess-work section injection and explicit
 * file-targeting instructions may help them stay grounded step-by-step.
 */
const HANDHOLDING_ENABLED =
  (import.meta.env.VITE_KWC_HANDHOLDING as string | undefined) === '1';

/**
 * Heuristic for failures worth auto-recovering from: network drops and
 * timeouts mid-flight. Deterministic API errors (validation failures,
 * bad keys) should surface as normal error banners, not auto-resends.
 */
function looksLikeTransientFailure(err: unknown): boolean {
  if (err instanceof api.ChatStoppedError) return false;
  const message = err instanceof Error ? err.message : String(err);
  return /failed to fetch|networkerror|network error|timed out|timeout|econnreset|aborted/i.test(message);
}

// ── Props ───────────────────────────────────────────────────────────

interface ChatDialogProps {
  open: boolean;
  onClose: () => void;
  pendingRequest?: PendingAiChatRequest | null;
  onPendingRequestHandled?: () => void;
}

interface AttachedConfigFile {
  id: string;
  name: string;
  content: string;
}

// ── Constants ───────────────────────────────────────────────────────

// CONTEXT_TRUNCATION_LIMIT and truncateConfigContext live in
// utils/chatUtils.ts — imported above to avoid duplicate definitions.

// Parse the temperature edit field into a clamped sampling value.
// Invalid input falls back to the 0.7 default; range is 0-2.
function parseTemperature(value: string): number {
  const parsed = parseFloat(value);
  if (Number.isNaN(parsed)) return 0.7;
  return Math.min(2, Math.max(0, parsed));
}

// ── Component ───────────────────────────────────────────────────────

const ChatDialog: React.FC<ChatDialogProps> = ({
  open,
  onClose,
  pendingRequest = null,
  onPendingRequestHandled,
}) => {
  // ── Stores ──────────────────────────────────────────────────────
  const { settings, setSettings, isConfigured, messages, setMessages, clearMessages } = useAiStore();
  const {
    configFiles,
    activeFile,
    validation,
    schemas,
    setConfigFile,
    setValidation,
    markDirty,
  } = useConfigStore();

  // ── Draft Hook ──────────────────────────────────────────────────
  const {
    assistantDraftPreview,
    assistantDraftPreviewLoading,
    assistantDraftApplicableMessages,
    setAssistantDraftPreview,
    setAssistantDraftApplicableMessages,
    handleApplyAssistantEdit,
    handleAssistantDraftSelectionChange,
    handleAcceptAssistantEdit,
    handleNewChat,
    requestAssistantMessage: draftRequestMessage,
    createDraftReplyValidator,
    flattenAssistantDraftChanges,
    updateAssistantDraftApplicableMessages,
  } = useAssistantDraft();

  // ── Component State ─────────────────────────────────────────────
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set when a transient failure (network drop / timeout mid-flight) leaves
  // an unanswered user message; offers a one-click resend and auto-resends
  // when the browser reports the connection is back.
  const [connectionLost, setConnectionLost] = useState(false);
  const connectionLostRef = useRef(false);
  const [showSettings, setShowSettings] = useState(false);
  // EXPERIMENT (auto-attach off): don't auto-select the active file.
  // Context only includes files the user explicitly checks in "Include Files".
  const [selectedConfigContextFiles, setSelectedConfigContextFiles] = useState<string[]>([]);
  const [attachedConfigFiles, setAttachedConfigFiles] = useState<AttachedConfigFile[]>([]);
  const [showChatHistory, setShowChatHistory] = useState(false);
  const [showCarryOverPrompt, setShowCarryOverPrompt] = useState(false);
  const [showPrinterMemory, setShowPrinterMemory] = useState(false);
  const [proposedMemory, setProposedMemory] = useState<PrinterMemory | null>(null);

  // Phase 4: carry the sections injected last turn so follow-up questions
  // keep their grounding even when the new message names no section. Entries
  // are bounded to the last two turns and dropped when the file leaves the
  // selection.
  const carriedSectionsRef = useRef<Array<{ filename: string; headers: string[]; turn: number }>>([]);
  const chatTurnRef = useRef(0);

  // ── Settings Editing State (single source of truth) ─────────────
  const [editApiKey, setEditApiKey] = useState(settings.apiKey);
  const [editProviderModels, setEditProviderModels] = useState(settings.providerModels);
  const [editModel, setEditModel] = useState(() =>
    getProviderModel(settings.apiProvider, settings.providerModels, settings.model, settings.apiProvider),
  );
  const [editApiUrl, setEditApiUrl] = useState(settings.apiUrl);
  const [editApiProvider, setEditApiProvider] = useState<AiProvider>(settings.apiProvider);
  const [editHost, setEditHost] = useState(settings.host);
  const [editPort, setEditPort] = useState(settings.port);
  const [editMaxTokens, setEditMaxTokens] = useState(String(settings.maxTokens ?? 4096));
  const [editTemperature, setEditTemperature] = useState(String(settings.temperature ?? 0.7));
  const [editToolProtocol, setEditToolProtocol] = useState<'auto' | 'native' | 'text'>(settings.toolProtocol ?? 'auto');

  const resolvedEditApiUrl = resolveProviderApiUrl(
    editApiProvider,
    editApiUrl,
    editHost,
    editPort,
  );

  // ── Refs ────────────────────────────────────────────────────────
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const handledPendingRequestIdRef = useRef<string | null>(null);
  // Live open state for async completions: the toolbar button only flashes
  // green/red when the dialog is closed at the moment the request finishes.
  const openRef = useRef(open);
  openRef.current = open;
  // Stop button: AbortController cancels the client fetch immediately;
  // the backend /ai/chat/stop endpoint (via requestId) cancels the work.
  const stopControllerRef = useRef<AbortController | null>(null);
  const stopRequestIdRef = useRef<string | null>(null);

  const loadedConfigFilenames = Object.keys(configFiles);

  // ── Sync settings to edit state when dialog opens ───────────────
  useEffect(() => {
    if (open) {
      setEditApiKey(settings.apiKey);
      setEditProviderModels(settings.providerModels);
      setEditModel(getProviderModel(settings.apiProvider, settings.providerModels, settings.model, settings.apiProvider));
      setEditApiUrl(settings.apiUrl);
      setEditApiProvider(settings.apiProvider);
      setEditHost(settings.host);
      setEditPort(settings.port);
      setEditMaxTokens(String(settings.maxTokens ?? 4096));
      setEditTemperature(String(settings.temperature ?? 0.7));
      setEditToolProtocol(settings.toolProtocol ?? 'auto');
      setError(null);
      // Opening the dialog consumes any background completion signal — the
      // toolbar button returns to its default color (the user is looking at
      // the conversation now).
      useAiStore.getState().setChatStatus('idle');
    }
  }, [open, settings]);

  // ── EXPERIMENT (auto-attach off) ───────────────────────────────
  // Removed the old "seed the active file into the selection when the
  // dialog opens" effect. Context now only includes files the user
  // explicitly checks in "Include Files" (or manually attaches).

  // ── Prune config context files when files are removed ───────────
  useEffect(() => {
    const availableFiles = new Set(Object.keys(configFiles));
    setSelectedConfigContextFiles((prev) => {
      const next = prev.filter((f) => availableFiles.has(f));
      return next.length === prev.length ? prev : next;
    });
  }, [configFiles]);

  // ── Auto-scroll to bottom ───────────────────────────────────────
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // ── Detect applicable assistant messages ────────────────────────
  useEffect(() => {
    if (!open || !activeFile) {
      setAssistantDraftApplicableMessages({});
      return;
    }
    void updateAssistantDraftApplicableMessages(messages);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, messages, activeFile, configFiles]);

  // ── Settings Save ───────────────────────────────────────────────
  const handleSaveSettings = useCallback(() => {
    const nextModel = editModel.trim();
    const nextProviderModels = { ...editProviderModels, [editApiProvider]: nextModel };
    setSettings({
      apiKey: editApiKey,
      model: nextModel,
      providerModels: nextProviderModels,
      apiUrl: resolvedEditApiUrl,
      apiProvider: editApiProvider,
      host: editHost,
      port: editPort,
      maxTokens: Math.max(256, parseInt(editMaxTokens, 10) || 4096),
      temperature: parseTemperature(editTemperature),
      toolProtocol: editToolProtocol,
    });
    setShowSettings(false);
  }, [
    editApiKey,
    editApiProvider,
    editHost,
    editMaxTokens,
    editPort,
    editModel,
    editProviderModels,
    editTemperature,
    editToolProtocol,
    resolvedEditApiUrl,
    setSettings,
  ]);

  // ── File Attach ─────────────────────────────────────────────────
  const handleAttachConfigFiles = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;
    try {
      const loadedFiles = await Promise.all(
        files.map(async (file, index) => ({
          id: `${file.name}-${file.lastModified}-${index}`,
          name: file.name,
          content: await file.text(),
        })),
      );
      setAttachedConfigFiles((prev) => [...prev, ...loadedFiles]);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to import config file.');
    } finally {
      e.target.value = '';
    }
  };

  const handleRemoveAttachedFile = (id: string) => {
    setAttachedConfigFiles((prev) => prev.filter((file) => file.id !== id));
  };

  // ── Helper: get config text (draft or saved) ────────────────────
  const getConfigText = useCallback(
    async (filename: string): Promise<string | null> => {
      if (!filename) return null;
      const config = configFiles[filename];
      if (!config) return null;
      return api.exportConfig(config);
    },
    [configFiles],
  );

  const getConfigContextLabel = useCallback(
    (filename: string): string =>
      filename === activeFile
        ? 'Active Klipper config draft'
        : 'Loaded Klipper config file',
    [activeFile],
  );

  // ── Submit Message ──────────────────────────────────────────────
  const submitMessage = useCallback(
    async (messageText: string, options?: { hiddenFromUser?: boolean; retry?: boolean; editIndex?: number }) => {
      const trimmedMessage = messageText.trim();
      if (!trimmedMessage || loading) return;

      // Fresh stop handle for this request (covers the whole pipeline,
      // including validation retries and auto-doc re-queries).
      const stopController = new AbortController();
      const stopRequestId = (typeof crypto !== 'undefined' && 'randomUUID' in crypto)
        ? crypto.randomUUID()
        : `chat-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      stopControllerRef.current = stopController;
      stopRequestIdRef.current = stopRequestId;

      const userMsg = { role: 'user' as const, content: trimmedMessage, hiddenFromUser: options?.hiddenFromUser === true };
      const previousMessages = options?.hiddenFromUser ? [] : messages;
      // On retry the conversation already ends with the failed user message —
      // reuse it as-is so the request includes the failed question in context
      // without duplicating it.
      // On edit the message at editIndex is replaced with the new text and the
      // conversation is truncated there, so the model regenerates from the
      // edited question with full prior context.
      let newMessages: ChatMessage[];
      if (options?.editIndex !== undefined) {
        newMessages = [...messages.slice(0, options.editIndex), userMsg];
      } else {
        newMessages = options?.retry ? messages : [...previousMessages, userMsg];
      }
      setMessages(newMessages);
      setInput('');
      if (inputRef.current) inputRef.current.textContent = '';
      setLoading(true);
      setError(null);
      connectionLostRef.current = false;
      setConnectionLost(false);

      try {
        const chatRequestBase = {
          apiKey: editApiKey,
          model: editModel,
          apiUrl: resolvedEditApiUrl,
          apiProvider: editApiProvider,
          requestId: stopRequestId,
          maxTokens: Math.max(256, parseInt(editMaxTokens, 10) || 4096),
          temperature: parseTemperature(editTemperature),
          toolProtocol: editToolProtocol,
          fullRewriteGuard: FULL_REWRITE_GUARD_ENABLED,
        };

        // Build context messages
        const contextMessages: Array<{ role: 'system'; content: string }> = [];
        const mentionedConfigFiles = extractMentionedConfigFilenames([userMsg.content], loadedConfigFilenames);
        // EXPERIMENT (auto-attach off): mentioned files are NOT auto-injected.
        // The targeting instructions below still name them so the model can
        // fetch content itself via read_user_config. Only files the user
        // explicitly checks in "Include Files" are sent as context.
        const contextTargets = Array.from(new Set(selectedConfigContextFiles));

        // Phase 4: collect the candidate files (checked in "Include Files" +
        // manually attached) with their content and labels. Content is sent
        // to the backend as contextFiles so ITS config-grounding fallback can
        // inject the exact loaded content if the model answers without
        // calling any tool — but nothing is dumped into the prompt up front
        // beyond what the intent path below decides.
        const candidateFiles = new Map<string, { text: string; label: string }>();
        for (const filename of contextTargets) {
          const fileText = await getConfigText(filename);
          if (fileText != null) {
            candidateFiles.set(filename, { text: fileText, label: getConfigContextLabel(filename) });
          }
        }
        for (const file of attachedConfigFiles) {
          candidateFiles.set(file.name, { text: file.content, label: 'User-attached local Klipper config file' });
        }

        // Phase 4/5 lean-context injection (targeted sections + section
        // index) is part of the handholding workflow — GATED OFF by default;
        // the model discovers config content via its MCP tools (validated by
        // the harness). Re-enable with VITE_KWC_HANDHOLDING=1.
        if (HANDHOLDING_ENABLED) {
          // Phase 4 carry-over: resolve the sections this message targets for
          // each candidate file. Targeted sections replace any carried set;
          // files with no new target keep the previous turn's sections so
          // follow-up questions stay grounded. Carried entries are bounded to
          // the last two turns and dropped when the file leaves the selection.
          chatTurnRef.current += 1;
          const currentTurn = chatTurnRef.current;
          const usedSections = new Map<string, string[]>();
          const nextCarried: Array<{ filename: string; headers: string[]; turn: number }> = [];
          for (const [filename, candidate] of candidateFiles) {
            const targetedHeaders = extractTargetedSectionHeaders(userMsg.content, candidate.text);
            if (targetedHeaders.length > 0) {
              usedSections.set(filename, targetedHeaders);
              nextCarried.push({ filename, headers: targetedHeaders, turn: currentTurn });
              continue;
            }
            const recent = [...carriedSectionsRef.current]
              .filter((entry) => entry.filename === filename && currentTurn - entry.turn <= 2)
              .sort((a, b) => b.turn - a.turn)[0];
            if (recent) {
              usedSections.set(filename, recent.headers);
              nextCarried.push({ filename, headers: recent.headers, turn: currentTurn });
            }
          }
          carriedSectionsRef.current = nextCarried;

          // Inject the lean context this request actually needs.
          // Phase 5: always lean — targeted sections when resolved, otherwise a
          // compact section index. Never dump the whole file as a system message;
          // the model fetches the sections it needs via read_user_config.
          const appendFileContext = (filename: string, candidate: { text: string; label: string }) => {
            const headers = usedSections.get(filename);
            if (headers && headers.length > 0) {
              for (const header of headers) {
                const sectionText = extractSectionText(candidate.text, header);
                if (sectionText != null) {
                  contextMessages.push({
                    role: 'system',
                    content: buildSectionContextMessage(filename, candidate.label, header, sectionText),
                  });
                }
              }
              return;
            }
            contextMessages.push({
              role: 'system',
              content: buildConfigIndexMessage(filename, findSectionHeaders(candidate.text), candidate.label),
            });
          };

          for (const [filename, candidate] of candidateFiles) {
            appendFileContext(filename, candidate);
          }
        }

        // File targeting instructions — the draft/mini-diff reinforcement.
        // Part of the handholding workflow, GATED OFF by default: the backend
        // SYSTEM_PROMPT already carries the '# file:' hint + mini-diff
        // protocol (ai_routes.py), and intent detection was removed — the
        // model decides whether a message is an edit or a question (harness
        // AMBI-01..08 all pass without any frontend classifier).
        if (HANDHOLDING_ENABLED) {
          const miniDiffInstruction = ` To EDIT an existing section, prefer a mini-diff: the section header followed by only the lines that change, prefixing removed lines with '-' and added lines with '+', keeping their original indentation. The app applies these replacements exactly, so unchanged lines (like Jinja {% if %}/{% endif %} tags) are preserved automatically. Outputting any unchanged line risks a full rewrite where those lines could be dropped — prefer emitting ONLY the lines that change. A pure addition (nothing removed) needs no '-' line: just the header plus the '+' lines. A pure deletion (nothing added) needs no '+' line: just the header plus the '-' lines. If a section is already correct and you only need to show it, quoting it unchanged is allowed. To ADD a new section, write it in full; to delete one, write '*[section_name]'.`;
          if (mentionedConfigFiles.length > 0) {
            contextMessages.push({
              role: 'system',
              content: `Apply requested edits to these loaded files: ${mentionedConfigFiles.join(', ')}. Start each fenced \`\`\`cfg block with a '# file: <filename>' hint line; use one separate block per file. To create a new file, use '# file: <newfilename>' with a name that does not exist yet.${miniDiffInstruction}`,
            });
          } else if (activeFile) {
            contextMessages.push({
              role: 'system',
              content: `Unless the user names a different file, apply edits to ${activeFile}. Return only changed, new, or deleted content in a fenced \`\`\`cfg code block. Start each fenced \`\`\`cfg block with a '# file: <filename>' hint line when targeting a specific file. To create a new file, use '# file: <newfilename>'. Do not return the whole file unless the user explicitly asks for a full replacement.${miniDiffInstruction}`,
            });
          }
        }

        // Context files sent to the backend for its config-grounding fallback
        // (content never lands in the prompt here — the model must fetch).
        const contextFilesPayload: Record<string, { content: string; label: string }> = {};
        for (const [filename, candidate] of candidateFiles) {
          contextFilesPayload[filename] = { content: candidate.text, label: candidate.label };
        }

        const requestConversation: Array<{ role: AiChatRole; content: string }> = [
          ...contextMessages,
          ...newMessages.map((m) => ({ role: m.role, content: m.content })),
        ];
        const validationConversation = [...newMessages];

        // First request
        const assistantAttempt = await draftRequestMessage(
          { ...chatRequestBase, contextFiles: contextFilesPayload },
          requestConversation,
          undefined,
          { signal: stopController.signal },
        );

        // ── Unified validation retry pipeline ───────────────────
        // Runs the config-draft validator and the printer-memory validator
        // in sequence. Each validator decides whether the reply applies to
        // it, what feedback to send for retries, and how to handle max
        // attempts (throw vs. warn). Previously these were two separate
        // retry loops with independent conversation bookkeeping.
        const pipelineResult = await runReplyValidationPipeline({
          requestFn: (conversation) => draftRequestMessage(
            { ...chatRequestBase, contextFiles: contextFilesPayload },
            conversation,
            undefined,
            { signal: stopController.signal },
          ),
          requestConversation,
          validationConversation,
          initialAttempt: assistantAttempt,
          validators: [
            createDraftReplyValidator(),
            createPrinterMemoryReplyValidator(),
          ],
        });

        if (pipelineResult.warnings) setError(pipelineResult.warnings);
        setMessages([...newMessages, pipelineResult.finalMessage]);
        setAssistantDraftApplicableMessages({}); // Will be re-evaluated by the useEffect
        // Background completion signal: if the dialog is closed when the reply
        // lands, flag the toolbar button so the user knows it's ready.
        if (!openRef.current) {
          useAiStore.getState().setChatStatus('success');
        }
      } catch (err: unknown) {
        const stopped = stopController.signal.aborted || err instanceof api.ChatStoppedError;
        if (stopped) {
          // User pressed Stop — keep the user message in history, no error banner.
          setAssistantDraftApplicableMessages({});
        } else {
          const message = err instanceof Error ? err.message : 'Failed to get response.';
          setError(message);
          // Keep the user message in history (no rollback) so a follow-up or
          // retry sends the full conversation — including the failed question —
          // back to the model. Previously the message was rolled back, so the
          // model never saw what the user had asked.
          if (looksLikeTransientFailure(err)) {
            connectionLostRef.current = true;
            setConnectionLost(true);
          } else {
            // Unrecoverable failure (validation retry limit, API error): signal
            // the toolbar button red if the dialog is closed.
            if (!openRef.current) {
              useAiStore.getState().setChatStatus('error');
            }
          }
        }
      } finally {
        stopControllerRef.current = null;
        stopRequestIdRef.current = null;
        setLoading(false);
      }
    },
    [
      activeFile,
      attachedConfigFiles,
      createDraftReplyValidator,
      draftRequestMessage,
      setAssistantDraftApplicableMessages,
      editApiKey,
      editApiProvider,
      editMaxTokens,
      editTemperature,
      editModel,
      loading,
      loadedConfigFilenames,
      messages,
      resolvedEditApiUrl,
      selectedConfigContextFiles,
      setMessages,
    ],
  );

  // ── Handle Send ─────────────────────────────────────────────────
  const handleSend = useCallback(() => {
    void submitMessage(input);
  }, [input, submitMessage]);

  // ── Handle Stop ────────────────────────────────────────────────
  // Abort the client fetch immediately (stops the UI wait) and tell the
  // backend to cancel the in-flight provider calls / tool work.
  const handleStop = useCallback(() => {
    stopControllerRef.current?.abort();
    const requestId = stopRequestIdRef.current;
    if (requestId) {
      void api.stopChat(requestId);
    }
  }, []);

  // ── Handle Retry ────────────────────────────────────────────────
  // Re-submit the last user message after a failure (timeout, unloaded
  // model, API error). The stored conversation already ends with the
  // failed message, so the retry request carries the full history — plus
  // rebuilt config/doc context — back to the model.
  const handleRetry = useCallback(() => {
    const { messages: currentMessages } = useAiStore.getState();
    const last = currentMessages[currentMessages.length - 1];
    if (last?.role === 'user' && !loading) {
      void submitMessage(last.content, { retry: true });
    }
  }, [loading, submitMessage]);

  // ── Handle Edit & Regenerate ──────────────────────────────────────
  // Replace the user message at `index` with the new text and regenerate.
  const handleEditMessage = useCallback(
    (index: number, newText: string) => {
      const { messages: currentMessages } = useAiStore.getState();
      const target = currentMessages[index];
      if (target?.role !== 'user' || loading) return;
      void submitMessage(newText, { editIndex: index });
    },
    [loading, submitMessage],
  );

  // ── Connection-loss recovery ────────────────────────────────────
  // If a transient failure left an unanswered question, auto-resend it
  // once the browser reports the network is back (LAN drops on a Pi are
  // usually brief). Manual Retry remains available via the error banner.
  useEffect(() => {
    const handleOnline = () => {
      if (!connectionLostRef.current || loading) return;
      const { messages: currentMessages } = useAiStore.getState();
      const last = currentMessages[currentMessages.length - 1];
      if (last?.role === 'user') {
        connectionLostRef.current = false;
        setConnectionLost(false);
        void submitMessage(last.content, { retry: true });
      }
    };
    window.addEventListener('online', handleOnline);
    return () => window.removeEventListener('online', handleOnline);
  }, [loading, submitMessage]);

  // ── Chat History ────────────────────────────────────────────────
  const saveCurrentConversation = useCallback(() => {
    const { settings, messages } = useAiStore.getState();
    if (messages.length > 0) {
      useChatHistoryStore.getState().saveConversation(
        messages,
        settings,
        attachedConfigFiles.map(({ name, content }) => ({ name, content })),
      );
    }
  }, [attachedConfigFiles]);

  const handleNewChatWithSave = useCallback(() => {
    const { messages: currentMessages } = useAiStore.getState();
    const last = currentMessages[currentMessages.length - 1];
    // If the conversation ends with an unanswered user message (timeout,
    // unloaded model, stop, or validation failure), offer to carry the
    // context into the new chat instead of silently dropping it.
    if (currentMessages.length > 0 && last?.role === 'user') {
      setShowCarryOverPrompt(true);
      return;
    }
    saveCurrentConversation();
    handleNewChat();
    setAttachedConfigFiles([]);
  }, [saveCurrentConversation, handleNewChat]);

  // Carry the existing conversation into the "new" chat so the next prompt
  // appends to it — the model keeps all prior context.
  const handleCarryOverContext = useCallback(() => {
    saveCurrentConversation();
    setAssistantDraftPreview(null);
    setAttachedConfigFiles([]);
    setError(null);
    setShowCarryOverPrompt(false);
  }, [saveCurrentConversation]);

  const handleStartFreshChat = useCallback(() => {
    saveCurrentConversation();
    handleNewChat();
    setAttachedConfigFiles([]);
    setError(null);
    setShowCarryOverPrompt(false);
  }, [saveCurrentConversation, handleNewChat]);

  const handleLoadConversation = useCallback(
    (conversation: SavedConversation) => {
      // Save current conversation before loading a different one
      saveCurrentConversation();
      setMessages(conversation.messages);
      setSettings(conversation.settings);
      setAssistantDraftPreview(null);
      // Restore config files that were attached during the original chat so
      // continuing the conversation keeps the same file context.
      setAttachedConfigFiles(
        (conversation.attachedConfigFiles ?? []).map((file, index) => ({
          id: `${file.name}-${index}`,
          name: file.name,
          content: file.content,
        })),
      );
    },
    [saveCurrentConversation, setMessages, setSettings],
  );

  // ── Printer Memory ──────────────────────────────────────────────

  const handleReviewPrinterMemory = useCallback(
    (content: string) => {
      const memory = extractPrinterMemoryBlock(content);
      if (memory) {
        setProposedMemory(memory as unknown as PrinterMemory);
        setShowPrinterMemory(true);
      }
    },
    [],
  );

  const handleAcceptPrinterMemoryProposal = useCallback(
    async (memory: PrinterMemory) => {
      try {
        const { save } = usePrinterMemoryStore.getState();
        await save(memory);
        setProposedMemory(null);
        setShowPrinterMemory(false);
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : 'Failed to save printer memory');
      }
    },
    [],
  );

  // ── Handle Key Down ─────────────────────────────────────────────
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  // ── Handle "Apply and Review Changes" ───────────────────────────
  const handleApplyEdit = useCallback(
    async (content: string, messageIndex?: number) => {
      setError(null);
      try {
        await handleApplyAssistantEdit(content, messageIndex);
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : 'Failed to prepare assistant changes.');
      }
    },
    [handleApplyAssistantEdit],
  );

  // ── Handle Accept Draft ─────────────────────────────────────────
  const handleAcceptDraft = useCallback(async () => {
    try {
      await handleAcceptAssistantEdit();
      const graphStore = useGraphStore.getState();
      graphStore.clearGraph();
      // Read config files AND validation directly from the store so newly
      // created files and fresh validation results (added by
      // handleAcceptAssistantEdit via setConfigFile/setValidation) are
      // included in the graph rebuild instead of stale closure values.
      const latestConfigFiles = useConfigStore.getState().configFiles;
      const latestValidation = useConfigStore.getState().validation;
      buildProjectGraph(latestConfigFiles, graphStore, schemas, latestValidation);
      setError(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to accept assistant changes.');
    }
  }, [handleAcceptAssistantEdit, schemas]);

  // ── Pending Request Handling ────────────────────────────────────
  useEffect(() => {
    if (!open || !pendingRequest || loading || !isConfigured()) return;
    if (handledPendingRequestIdRef.current === pendingRequest.id) return;
    handledPendingRequestIdRef.current = pendingRequest.id;
    onPendingRequestHandled?.();
    void submitMessage(pendingRequest.prompt, { hiddenFromUser: pendingRequest.hiddenFromUser });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isConfigured, loading, onPendingRequestHandled, open, pendingRequest]);

  // ── Shared settings panel props ─────────────────────────────────
  const settingsPanelProps = {
    editApiKey,
    setEditApiKey,
    editModel,
    setEditModel,
    editApiUrl,
    setEditApiUrl,
    editApiProvider,
    setEditApiProvider,
    editMaxTokens,
    setEditMaxTokens,
    editTemperature,
    setEditTemperature,
    editToolProtocol,
    setEditToolProtocol,
    resolvedEditApiUrl,
    onSaveSettings: handleSaveSettings,
  };

  // ═════════════════════════════════════════════════════════════════
  // RENDER
  // ═════════════════════════════════════════════════════════════════

  // The dialog stays MOUNTED when closed so an in-flight request keeps
  // running (validation retries, connection-recovery listener, WIP state).
  // Closing only hides the overlay; reopening shows the finished reply.
  if (!open) {
    return null;
  }

  // ── Unconfigured State ──────────────────────────────────────────
  if (!isConfigured()) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
        <div
          className="bg-[var(--color-bg-secondary)] rounded-xl border border-[var(--color-bg-tertiary)] shadow-2xl w-[600px] overflow-hidden"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center justify-between p-4 border-b border-[var(--color-bg-tertiary)]">
            <h2 className="text-sm font-semibold">AI Chat</h2>
            <button onClick={onClose} className="text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]">
              ✕
            </button>
          </div>
          <div className="p-6">
            <ChatSettingsPanel
              standalone
              {...settingsPanelProps}
              onClose={onClose}
            />
          </div>
        </div>
      </div>
    );
  }

  // ── Configured State ────────────────────────────────────────────
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="bg-[var(--color-bg-secondary)] rounded-xl border border-[var(--color-bg-tertiary)] shadow-2xl w-[620px] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Title bar */}
        <div className="flex items-center justify-between p-4 border-b border-[var(--color-bg-tertiary)]">
          <div className="flex items-center gap-2">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" className="text-[var(--color-text-secondary)]">
              <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2v10z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            <h2 className="text-sm font-semibold">AI Chat</h2>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                setShowPrinterMemory(true);
                // Clear any stale proposal when opening manually
                setProposedMemory(null);
              }}
              className="px-2 py-1 rounded text-[10px] font-medium bg-[var(--color-bg-primary)] border border-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] transition-colors"
              title="View and edit printer memory"
            >
              Printer Memory
            </button>
            <button
              onClick={() => setShowChatHistory(true)}
              className="px-2 py-1 rounded text-[10px] font-medium bg-[var(--color-bg-primary)] border border-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] transition-colors"
              title="View and load past conversations"
            >
              Chat History
            </button>
            <button
              onClick={handleNewChatWithSave}
              disabled={loading || messages.length === 0}
              className="px-2 py-1 rounded text-[10px] font-medium bg-[var(--color-bg-primary)] border border-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] disabled:opacity-40 disabled:cursor-not-allowed"
              title="Start a new chat"
            >
              New Chat
            </button>
            <button
              onClick={() => setShowSettings(!showSettings)}
              className="text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] transition-colors"
              title="AI Settings"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.5"/>
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </button>
            <button onClick={onClose} className="text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]">
              ✕
            </button>
          </div>
        </div>

        {/* Inline Settings Panel */}
        {showSettings && (
          <ChatSettingsPanel standalone={false} {...settingsPanelProps} />
        )}

        {/* Messages area */}
        <div className="flex-1 overflow-y-auto p-4" style={{ minHeight: 350, maxHeight: 450 }}>
          <ChatMessageList
            messages={messages}
            loading={loading}
            error={connectionLost ? 'Connection lost — the last question will resend automatically when the network returns.' : error}
            onRetry={handleRetry}
            activeFile={activeFile}
            assistantDraftApplicableMessages={assistantDraftApplicableMessages}
            assistantDraftPreviewLoading={assistantDraftPreviewLoading}
            onApplyEdit={handleApplyEdit}
            onReviewPrinterMemory={handleReviewPrinterMemory}
            onEditMessage={handleEditMessage}
            messagesEndRef={messagesEndRef}
          />
        </div>

        {/* File input (hidden) */}
        <input
          ref={fileInputRef}
          type="file"
          accept=".cfg,text/plain"
          multiple
          className="hidden"
          onChange={handleAttachConfigFiles}
        />

        {/* Input bar */}
        <ChatInputBar
          input={input}
          loading={loading}
          selectedConfigContextFiles={selectedConfigContextFiles}
          loadedConfigFilenames={loadedConfigFilenames}
          activeFile={activeFile}
          attachedConfigFiles={attachedConfigFiles}
          onInputChange={setInput}
          onSend={handleSend}
          onStop={handleStop}
          onKeyDown={handleKeyDown}
          onAttachFiles={handleAttachConfigFiles}
          onRemoveAttachedFile={handleRemoveAttachedFile}
          onSelectedContextFilesChange={setSelectedConfigContextFiles}
          inputRef={inputRef}
          fileInputRef={fileInputRef}
        />
      </div>

      {/* Draft Preview Dialog */}
      {assistantDraftPreview && (
        <AiDraftPreviewDialog
          filePreviews={assistantDraftPreview.filePreviews.map((fp) => ({
            filename: fp.filename,
            originalText: fp.originalText,
            mergedText: fp.mergedText,
          }))}
          changes={flattenAssistantDraftChanges(assistantDraftPreview.filePreviews)}
          selectedChangeIds={assistantDraftPreview.selectedChangeIds}
          previewUpdating={assistantDraftPreview.previewUpdating}
          repairedSections={assistantDraftPreview.repairedSections}
          onSelectionChange={(ids) => { void handleAssistantDraftSelectionChange(ids); }}
          onAccept={() => { void handleAcceptDraft(); }}
          onClose={() => setAssistantDraftPreview(null)}
        />
      )}

      {/* Chat History Dialog */}
      {showChatHistory && (
        <ChatHistoryDialog
          onClose={() => setShowChatHistory(false)}
          onLoadConversation={handleLoadConversation}
          currentMessageCount={messages.length}
        />
      )}

      {/* Printer Memory Dialog */}
      {showPrinterMemory && (
        <PrinterMemoryDialog
          open={showPrinterMemory}
          onClose={() => { setShowPrinterMemory(false); setProposedMemory(null); }}
          proposedMemory={proposedMemory}
          onAcceptProposal={handleAcceptPrinterMemoryProposal}
        />
      )}

      {/* Interrupted-conversation carry-over prompt */}
      {showCarryOverPrompt && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50" onClick={() => setShowCarryOverPrompt(false)}>
          <div
            className="bg-[var(--color-bg-secondary)] rounded-xl border border-[var(--color-bg-tertiary)] shadow-2xl w-[420px] p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-sm font-semibold mb-1">Your last message didn't get a response</h2>
            <p className="text-[11px] text-[var(--color-text-secondary)] leading-relaxed mb-4">
              The conversation was interrupted — the model may have timed out or been unloaded.
              Keep the previous conversation so your next message still has full context, or
              start completely fresh.
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={handleStartFreshChat}
                className="px-3 py-1.5 rounded text-xs font-medium border border-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] transition-colors"
              >
                Start Fresh
              </button>
              <button
                onClick={handleCarryOverContext}
                className="px-3 py-1.5 rounded text-xs font-medium bg-blue-600 text-white hover:bg-blue-500 transition-colors"
              >
                Keep Context &amp; Continue
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ChatDialog;
