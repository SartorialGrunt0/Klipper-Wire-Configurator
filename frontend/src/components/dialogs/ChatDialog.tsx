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
import { useConfigStore } from '../../stores/configStore';
import { useGraphStore } from '../../stores/graphStore';
import * as api from '../../services/api';
import {
  buildConfigContextMessage,
  extractMentionedConfigFilenames,
  PROVIDER_DEFAULTS,
  isLocalProvider,
  resolveProviderApiUrl,
  getProviderModel,
} from '../../utils/chatUtils';
import { buildProjectGraph } from '../../utils/graphBuilder';
import { useAssistantDraft } from '../../hooks/useAssistantDraft';
import ChatSettingsPanel from './ChatSettingsPanel';
import ChatMessageList from './ChatMessageList';
import ChatInputBar from './ChatInputBar';
import AiDraftPreviewDialog from './AiDraftPreviewDialog';
import type { PendingAiChatRequest } from '../../types/ai';
import type { AiChatRole } from '../../services/api';

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

  // ── Settings Editing State (single source of truth) ─────────────
  const [editApiKey, setEditApiKey] = useState(settings.apiKey);
  const [editProviderModels, setEditProviderModels] = useState(settings.providerModels);
  const [editModel, setEditModel] = useState(() =>
    getProviderModel(settings.apiProvider, settings.providerModels, settings.model, settings.apiProvider),
  );
  const [editApiUrl, setEditApiUrl] = useState(settings.apiUrl);
  const [editApiProvider, setEditApiProvider] = useState<AiProvider>(settings.apiProvider);
  const [editLmStudioHost, setEditLmStudioHost] = useState(settings.lmStudioHost);
  const [editLmStudioPort, setEditLmStudioPort] = useState(settings.lmStudioPort);
  const [editLmStudioMcpPluginId, setEditLmStudioMcpPluginId] = useState(settings.lmStudioMcpPluginId);
  const [editOllamaHost, setEditOllamaHost] = useState(settings.ollamaHost);
  const [editOllamaPort, setEditOllamaPort] = useState(settings.ollamaPort);

  const resolvedEditApiUrl = resolveProviderApiUrl(
    editApiProvider,
    editApiUrl,
    editLmStudioHost,
    editLmStudioPort,
    editOllamaHost,
    editOllamaPort,
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
      setEditLmStudioHost(settings.lmStudioHost);
      setEditLmStudioPort(settings.lmStudioPort);
      setEditLmStudioMcpPluginId(settings.lmStudioMcpPluginId);
      setEditOllamaHost(settings.ollamaHost);
      setEditOllamaPort(settings.ollamaPort);
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
      lmStudioHost: editLmStudioHost,
      lmStudioPort: editLmStudioPort,
      lmStudioMcpPluginId: editLmStudioMcpPluginId,
      ollamaHost: editOllamaHost,
      ollamaPort: editOllamaPort,
    });
    setShowSettings(false);
  }, [
    editApiKey,
    editApiProvider,
    editLmStudioHost,
    editLmStudioMcpPluginId,
    editLmStudioPort,
    editModel,
    editOllamaHost,
    editOllamaPort,
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
          lmStudioMcpPluginId: editApiProvider === 'lm-studio' ? editLmStudioMcpPluginId : undefined,
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
            content: `The user explicitly referenced these loaded config files: ${mentionedConfigFiles.join(', ')}. Apply requested edits to those files instead of defaulting to the active text-view file. When you return cfg sections for a specific file, add a first comment line exactly like "# file: <filename>" before the changed sections. If changes span multiple files, return one separate fenced cfg block per file.`,
          });
        } else if (activeFile) {
          contextMessages.push({
            role: 'system',
            content: `If the user asks you to modify ${activeFile}, or does not name a different config file, return only the changed, new, or deleted sections for ${activeFile} inside a single fenced code block labeled cfg. Include full section headers and the full contents of each changed section. To COMMENT OUT / DISABLE a section, include its header commented out with existing params: #[extruder]. To DELETE a section entirely (remove from file), write *[section_name] on its own line inside the cfg block — the * before the bracket tells the app to remove that section. Do NOT use # for deletions: # means comment out, * means delete. Example: *[extruder]. You can mix deletion markers with normal sections in the same cfg block. If a different loaded config file is clearly requested, target that file instead and start that cfg block with a first comment line exactly like "# file: <filename>". If changes span multiple files, return one separate fenced cfg block per file. Do not return the entire file unless the user explicitly asks for a full replacement.`,
          });
        }

        const requestConversation: Array<{ role: AiChatRole; content: string }> = [
          ...contextMessages,
          ...newMessages.map((m) => ({ role: m.role, content: m.content })),
        ];
        const validationConversation = [...newMessages];

        // First request
        const assistantAttempt = await draftRequestMessage(chatRequestBase, requestConversation);

        // Validation retry loop
        const result = await draftValidationRetryLoop(
          chatRequestBase,
          requestConversation,
          validationConversation,
          assistantAttempt,
        );

        if (result.warningMessage) setError(result.warningMessage);
        setMessages([...newMessages, result.finalMessage]);
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
      editLmStudioMcpPluginId,
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
      buildProjectGraph(configFiles, graphStore, schemas, validation);
      setError(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to accept assistant changes.');
    }
  }, [configFiles, handleAcceptAssistantEdit, schemas, validation]);

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
    editLmStudioHost,
    setEditLmStudioHost,
    editLmStudioPort,
    setEditLmStudioPort,
    editLmStudioMcpPluginId,
    setEditLmStudioMcpPluginId,
    editOllamaHost,
    setEditOllamaHost,
    editOllamaPort,
    setEditOllamaPort,
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
              onClick={handleNewChat}
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
    </div>
  );
};

export default ChatDialog;
