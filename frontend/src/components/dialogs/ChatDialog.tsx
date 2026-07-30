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
import { useAiStore, AiProvider, providerRequiresApiKey } from '../../stores/aiStore';
import { useChatHistoryStore } from '../../stores/chatHistoryStore';
import { useConfigStore } from '../../stores/configStore';
import { useGraphStore } from '../../stores/graphStore';
import { usePrinterMemoryStore, DEFAULT_PRINTER_MEMORY, type PrinterMemory } from '../../stores/printerMemoryStore';
import * as api from '../../services/api';
import {
  buildConfigContextMessage,
  extractMentionedConfigFilenames,
  extractPrinterMemoryBlock,
  validatePrinterMemoryContent,
  buildPrinterMemoryValidationFeedback,
  type PrinterMemoryValidationIssue,
  MAX_PRINTER_MEMORY_VALIDATION_ATTEMPTS,
  hasPrinterMemoryBlock,
  PROVIDER_DEFAULTS,
  isLocalProvider,
  resolveProviderApiUrl,
  getProviderModel,
} from '../../utils/chatUtils';
import { buildProjectGraph } from '../../utils/graphBuilder';
import { useAssistantDraft } from '../../hooks/useAssistantDraft';
import ChatSettingsPanel from './ChatSettingsPanel';
import ChatHistoryDialog from './ChatHistoryDialog';
import PrinterMemoryDialog from './PrinterMemoryDialog';
import ChatMessageList from './ChatMessageList';
import ChatInputBar from './ChatInputBar';
import AiDraftPreviewDialog from './AiDraftPreviewDialog';
import type { PendingAiChatRequest } from '../../types/ai';
import type { AiChatRole } from '../../services/api';
import type { SavedConversation } from '../../stores/chatHistoryStore';

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

const CONTEXT_TRUNCATION_LIMIT = 40000;

function truncateConfigContext(content: string): string {
  if (content.length <= CONTEXT_TRUNCATION_LIMIT) return content;
  return `${content.slice(0, CONTEXT_TRUNCATION_LIMIT)}\n\n# Context truncated after ${CONTEXT_TRUNCATION_LIMIT} characters.`;
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
    textEditorDirty,
    textDrafts,
    setConfigFile,
    setValidation,
    clearTextDraft,
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
    runValidationRetryLoop: draftValidationRetryLoop,
    flattenAssistantDraftChanges,
    updateAssistantDraftApplicableMessages,
  } = useAssistantDraft({
    messages,
    setMessages,
    configFiles,
    activeFile,
    validation,
    schemas,
    textDrafts,
    textEditorDirty,
    setConfigFile,
    setValidation,
    clearTextDraft,
    markDirty,
    clearMessages,
    loadedConfigFilenames: Object.keys(configFiles),
  });

  // ── Component State ─────────────────────────────────────────────
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [selectedConfigContextFiles, setSelectedConfigContextFiles] = useState<string[]>(
    activeFile ? [activeFile] : [],
  );
  const [attachedConfigFiles, setAttachedConfigFiles] = useState<AttachedConfigFile[]>([]);
  const [showChatHistory, setShowChatHistory] = useState(false);
  const [showPrinterMemory, setShowPrinterMemory] = useState(false);
  const [proposedMemory, setProposedMemory] = useState<PrinterMemory | null>(null);

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
      setError(null);
    }
  }, [open, settings]);

  // ── Reset file menu on close ────────────────────────────────────
  useEffect(() => {
    if (!open) return;
    setSelectedConfigContextFiles((prev) => (prev.length > 0 || !activeFile ? prev : [activeFile]));
  }, [open, activeFile]);

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
  }, [open, messages, activeFile, configFiles, textDrafts]);

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
    });
    setShowSettings(false);
  }, [
    editApiKey,
    editApiProvider,
    editHost,
    editPort,
    editModel,
    editProviderModels,
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
      const draftText = textDrafts[filename];
      if (typeof draftText === 'string') return draftText;
      const config = configFiles[filename];
      if (!config) return null;
      return api.exportConfig(config);
    },
    [configFiles, textDrafts],
  );

  // ── Build context messages ──────────────────────────────────────
  const getConfigContexts = useCallback(
    async (filenames: string[]): Promise<string[]> => {
      if (filenames.length === 0) return [];
      const contexts = await Promise.all(
        Array.from(new Set(filenames)).map(async (filename) => {
          const configText = await getConfigText(filename);
          if (configText == null) return null;
          const label =
            filename === activeFile
              ? typeof textDrafts[activeFile] === 'string' && textEditorDirty
                ? 'Active Klipper config draft with unapplied text-view changes'
                : 'Active Klipper config draft'
              : 'Loaded Klipper config file';
          return buildConfigContextMessage(filename, configText, label);
        }),
      );
      return contexts.filter((ctx): ctx is string => ctx != null);
    },
    [activeFile, getConfigText, textDrafts, textEditorDirty],
  );

  // ── Submit Message ──────────────────────────────────────────────
  const submitMessage = useCallback(
    async (messageText: string, options?: { hiddenFromUser?: boolean }) => {
      const trimmedMessage = messageText.trim();
      if (!trimmedMessage || loading) return;

      const userMsg = { role: 'user' as const, content: trimmedMessage, hiddenFromUser: options?.hiddenFromUser === true };
      const previousMessages = options?.hiddenFromUser ? [] : messages;
      const newMessages = [...previousMessages, userMsg];
      setMessages(newMessages);
      setInput('');
      if (inputRef.current) inputRef.current.textContent = '';
      setLoading(true);
      setError(null);

      try {
        const chatRequestBase = {
          apiKey: editApiKey,
          model: editModel,
          apiUrl: resolvedEditApiUrl,
          apiProvider: editApiProvider,
        };

        // Build context messages
        const contextMessages: Array<{ role: 'system'; content: string }> = [];
        const mentionedConfigFiles = extractMentionedConfigFilenames([userMsg.content], loadedConfigFilenames);
        const selectedConfigContexts = await getConfigContexts([
          ...selectedConfigContextFiles,
          ...mentionedConfigFiles,
        ]);

        for (const ctx of selectedConfigContexts) {
          contextMessages.push({ role: 'system', content: ctx });
        }
        for (const file of attachedConfigFiles) {
          contextMessages.push({
            role: 'system',
            content: buildConfigContextMessage(file.name, file.content, 'User-attached local Klipper config file'),
          });
        }

        // File targeting instructions
        if (mentionedConfigFiles.length > 0) {
          contextMessages.push({
            role: 'system',
            content: `The user explicitly referenced these loaded config files: ${mentionedConfigFiles.join(', ')}. Apply requested edits to those files instead of defaulting to the active text-view file. When you return cfg sections for a specific file, add a first comment line exactly like "# file: <filename>" before the changed sections. If changes span multiple files, return one separate fenced cfg block per file. To create a new file, use "# file: <newfilename>" with a filename that does not exist yet.`,
          });
        } else if (activeFile) {
          contextMessages.push({
            role: 'system',
            content: `If the user asks you to modify ${activeFile}, or does not name a different config file, return only the changed, new, or deleted sections for ${activeFile} inside a single fenced code block labeled cfg. Include full section headers and the full contents of each changed section. To COMMENT OUT / DISABLE a section, include its header commented out with existing params: #[extruder]. To DELETE a section entirely (remove from file), write *[section_name] on its own line inside the cfg block — the * before the bracket tells the app to remove that section. Do NOT use # for deletions: # means comment out, * means delete. Example: *[extruder]. You can mix deletion markers with normal sections in the same cfg block. If a different loaded config file is clearly requested, target that file instead and start that cfg block with a first comment line exactly like "# file: <filename>". If changes span multiple files, return one separate fenced cfg block per file. To create a new file, use "# file: <newfilename>" with a filename that does not exist yet. Do not return the entire file unless the user explicitly asks for a full replacement.`,
          });
        }

        const requestConversation: Array<{ role: AiChatRole; content: string }> = [
          ...contextMessages,
          ...newMessages.map((m) => ({ role: m.role, content: m.content })),
        ];
        const validationConversation = [...newMessages];

        // First request
        const assistantAttempt = await draftRequestMessage(chatRequestBase, requestConversation);

        // Validation retry loop (config drafts)
        const result = await draftValidationRetryLoop(
          chatRequestBase,
          requestConversation,
          validationConversation,
          assistantAttempt,
        );

        // ── Printer memory validation retry loop ─────────────────
        // If the AI included a printer-memory block, validate it thoroughly:
        // - JSON must parse correctly
        // - Must be a flat object (not an array or primitive)
        // - Only the 7 defined fields are allowed
        // If validation fails, tell the AI what's wrong and ask for a fix.
        let printerMemoryAttempt = result.finalMessage;
        let printerMemoryWarnings = result.warningMessage;
        let printerMemoryAttemptsUsed = 0;

        while (printerMemoryAttemptsUsed < MAX_PRINTER_MEMORY_VALIDATION_ATTEMPTS) {
          const validationResult = validatePrinterMemoryContent(printerMemoryAttempt.content);
          if (!validationResult) break; // No printer-memory block in this message, nothing to validate
          if (validationResult.issues.length === 0) break; // Block is valid

          printerMemoryAttemptsUsed += 1;
          if (printerMemoryAttemptsUsed >= MAX_PRINTER_MEMORY_VALIDATION_ATTEMPTS) {
            const issueMessages = validationResult.issues
              .map((i) => `- ${i.message}`)
              .join('\n');
            printerMemoryWarnings = [
              printerMemoryWarnings,
              `The AI returned an invalid printer-memory block after ${MAX_PRINTER_MEMORY_VALIDATION_ATTEMPTS} attempts:\n${issueMessages}`,
            ].filter(Boolean).join('\n');
            break;
          }

          // Build feedback telling the AI what to fix
          const validationFeedback = buildPrinterMemoryValidationFeedback(validationResult.issues);

          // Append the feedback and re-request
          const pmRequestConversation: Array<{ role: AiChatRole; content: string }> = [
            ...requestConversation,
            ...result.finalConversation.map((m) => ({ role: m.role as AiChatRole, content: m.content })),
            { role: 'user' as AiChatRole, content: validationFeedback },
          ];

          try {
            const pmRetry = await draftRequestMessage(chatRequestBase, pmRequestConversation);
            printerMemoryAttempt = pmRetry.assistantMessage;
          } catch (pmErr: unknown) {
            const pmErrorMessage = pmErr instanceof Error ? pmErr.message : 'Unknown error';
            const issueMessages = validationResult.issues
              .map((i) => `- ${i.message}`)
              .join('\n');
            printerMemoryWarnings = [
              printerMemoryWarnings,
              `Failed to retry after invalid printer memory block (${pmErrorMessage}):\n${issueMessages}`,
            ].filter(Boolean).join('\n');
            break;
          }
        }

        if (printerMemoryWarnings) setError(printerMemoryWarnings);
        setMessages([...newMessages, printerMemoryAttempt]);
        setAssistantDraftApplicableMessages({}); // Will be re-evaluated by the useEffect
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Failed to get response.';
        setError(message);
        setMessages(previousMessages); // Roll back on failure
      } finally {
        setLoading(false);
      }
    },
    [
      activeFile,
      attachedConfigFiles,
      draftRequestMessage,
      draftValidationRetryLoop,
      setAssistantDraftApplicableMessages,
      editApiKey,
      editApiProvider,

      editModel,
      getConfigContexts,
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

  // ── Chat History ────────────────────────────────────────────────
  const saveCurrentConversation = useCallback(() => {
    const { settings, messages } = useAiStore.getState();
    if (messages.length > 0) {
      useChatHistoryStore.getState().saveConversation(messages, settings);
    }
  }, []);

  const handleNewChatWithSave = useCallback(() => {
    saveCurrentConversation();
    handleNewChat();
    setAttachedConfigFiles([]);
  }, [saveCurrentConversation, handleNewChat]);

  const handleLoadConversation = useCallback(
    (conversation: SavedConversation) => {
      // Save current conversation before loading a different one
      saveCurrentConversation();
      setMessages(conversation.messages);
      setSettings(conversation.settings);
      setAssistantDraftPreview(null);
      setAttachedConfigFiles([]);
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
    editHost,
    setEditHost,
    editPort,
    setEditPort,
    resolvedEditApiUrl,
    onSaveSettings: handleSaveSettings,
  };

  // ═════════════════════════════════════════════════════════════════
  // RENDER
  // ═════════════════════════════════════════════════════════════════

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
            error={error}
            activeFile={activeFile}
            assistantDraftApplicableMessages={assistantDraftApplicableMessages}
            assistantDraftPreviewLoading={assistantDraftPreviewLoading}
            onApplyEdit={handleApplyEdit}
            onReviewPrinterMemory={handleReviewPrinterMemory}
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
    </div>
  );
};

export default ChatDialog;
