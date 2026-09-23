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
import { usePrinterMemoryStore, DEFAULT_PRINTER_MEMORY, type PrinterMemory } from '../../stores/printerMemoryStore';
import * as api from '../../services/api';
import { extractPrinterMemoryBlock } from '../../utils/printerMemory';
import { planApprovedEditApply } from '../../utils/approvalApply';
import {
  PROVIDER_DEFAULTS,
  isLocalProvider,
  resolveProviderApiUrl,
  getProviderModel,
} from '../../utils/chatProviders';
import { runReplyValidationPipeline, createPrinterMemoryReplyValidator } from '../../utils/replyValidation';
import { useAssistantDraft } from '../../hooks/useAssistantDraft';
import ChatSettingsPanel from './ChatSettingsPanel';
import ChatHistoryDialog from './ChatHistoryDialog';
import PrinterMemoryDialog from './PrinterMemoryDialog';
import ChatMessageList from './ChatMessageList';
import ChatApprovalCard from './ChatApprovalCard';
import ApprovalDiffPreview from './ApprovalDiffPreview';
import type { ApprovalCard } from '../../services/api';
import ChatInputBar from './ChatInputBar';
import type { PendingAiChatRequest } from '../../types/ai';
import type { AiChatRole } from '../../services/api';
import type { SavedConversation } from '../../stores/chatHistoryStore';

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
    updateConfigFile,
    removeConfigFile,
    markDirty,
  } = useConfigStore();

  // ── Draft Hook (request helper) ─────────────────────────────────
  const {
    requestAssistantMessage: draftRequestMessage,
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
  // ── Approval gate (Phase 2) ──
  // While a chat request is loading, poll for a pending approval card
  // (validated tool-mediated writes suspend the backend loop). The
  // backend timer auto-declines; this UI just displays and decides.
  const [approvalCard, setApprovalCard] = useState<ApprovalCard | null>(null);
  const [approvalReceivedAt, setApprovalReceivedAt] = useState(0);
  const [approvalNow, setApprovalNow] = useState(0);
  const [approvalBusy, setApprovalBusy] = useState(false);
  const [approvalInvalidation, setApprovalInvalidation] = useState<string | null>(null);
  // Full-file diff preview opened from the approval card ("show full
  // file"). Snapshot on open: the live card clears the moment the
  // decision lands, the preview stays readable while it's open.
  const [approvalDiffPreview, setApprovalDiffPreview] = useState<ApprovalCard | null>(null);
  const approvalCardRef = useRef<ApprovalCard | null>(null);
  // In-flight chat request id as STATE so the approval poll effect can
  // key on it (stopRequestIdRef alone never re-renders).
  const [stopRequestId, setStopRequestId] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  // EXPERIMENT (auto-attach off): don't auto-select the active file.
  // Context only includes files the user explicitly checks in "Include Files".
  const [selectedConfigContextFiles, setSelectedConfigContextFiles] = useState<string[]>([]);
  const [attachedConfigFiles, setAttachedConfigFiles] = useState<AttachedConfigFile[]>([]);
  const [showChatHistory, setShowChatHistory] = useState(false);
  const [showCarryOverPrompt, setShowCarryOverPrompt] = useState(false);
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
  // (Removed with the Phase-4 ratchet: the "Apply and Review Changes"
  // affordance is gone — writes arrive as approval cards and land in the
  // dirty store on approve; there is no prose draft to mark applicable.)

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

  // ── Approved tool edits → editor draft ──────────────────────────
  // The approval card gate (Phase 2) stages validated writes SERVER-side;
  // once the user approves, the resuming backend loop returns the final
  // assistant message carrying `pendingEdits` (full post-apply file text,
  // backend truth — never model prose). Applying them here marks the
  // editor dirty like any other edit: approved ≠ saved, the Save flow
  // (and its validation gate) remains the only path to disk.
  const applyApprovedToolEdits = useCallback(
    async (edits: NonNullable<ChatMessage['pendingEdits']>): Promise<void> => {
      const { upserts, deletes } = planApprovedEditApply(edits);
      if (upserts.length === 0 && deletes.length === 0) return;
      for (const { file, newText } of upserts) {
        try {
          const parsed = await api.parseConfigText(newText, file);
          const config = { ...parsed.config, raw_text: newText };
          // updateConfigFile (NOT setConfigFile + single-file validateConfig):
          // the store's debounced revalidation validates the WHOLE project,
          // so include-graph-aware findings (gcode registry macros defined in
          // included files, cross-file dups/pins) re-derive correctly. A
          // single-file result written here flags every included-file macro
          // as unknown_gcode_command (live report 2026-09-20: CLEAN_NOZZLE,
          // AUX_FAN_ON/OFF from clean.cfg / aux_fan.cfg).
          updateConfigFile(file, config);
        } catch (err: unknown) {
          // Should not happen: newText comes from the backend's own
          // writer. Surface rather than silently drop the approved change.
          console.error('[Approval] Failed to apply approved edit to', file, err);
          setError(`Approved change to ${file} could not be applied to the editor — check the diff before saving.`);
        }
      }
      deletes.forEach((file) => removeConfigFile(file));
      if (upserts.length > 0 || deletes.length > 0) markDirty();
      if (deletes.length > 0) {
        // Deletion alone schedules nothing (removeConfigFile only drops the
        // file's own entry) — re-derive the OTHER files' findings (e.g. a
        // dangling include) against the surviving project now. Upsert-only
        // flows are already covered by updateConfigFile's debounced pass.
        void useConfigStore.getState().revalidateAll();
      }
    },
    [updateConfigFile, removeConfigFile, markDirty],
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
      setStopRequestId(stopRequestId);
      // Reset the approval card state for the new request; the poll
      // effect below picks up any card this request suspends on.
      setApprovalCard(null);
      approvalCardRef.current = null;
      setApprovalInvalidation(null);
      setApprovalBusy(false);

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
        };

        // EXPERIMENT (auto-attach off): mentioned files are NOT auto-injected.
        // Only files the user explicitly checks in "Include Files" are sent
        // as context.
        const contextTargets = Array.from(new Set(selectedConfigContextFiles));

        // Phase 4: collect the candidate files (checked in "Include Files" +
        // manually attached) with their content and labels. Content is sent
        // to the backend as contextFiles for the edit session's working state
        // — nothing is dumped into the prompt; the model fetches via
        // read_user_config.
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

        // Context files sent to the backend for the edit session / approval
        // re-validation (content never lands in the prompt here — the model
        // must fetch).
        const contextFilesPayload: Record<string, { content: string; label: string }> = {};
        for (const [filename, candidate] of candidateFiles) {
          contextFilesPayload[filename] = { content: candidate.text, label: candidate.label };
        }

        // Phase-5 gate sweep (2026-09): no frontend-injected system messages
        // remain — the handholding injections (regex-targeted sections +
        // file-targeting reinforcement, VITE_KWC_HANDHOLDING) were deleted;
        // the model discovers config content and its edit target through its
        // MCP tools plus the backend SYSTEM_PROMPT edit law.
        const requestConversation: Array<{ role: AiChatRole; content: string }> = [
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
        // Runs the printer-memory validator over the reply. The config-draft
        // validator retired with the Phase-4 ratchet (2026-09-22): config
        // edits go through the write tools + approval card, so there is no
        // prose draft to validate or retry.
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
            createPrinterMemoryReplyValidator(),
          ],
        });

        if (pipelineResult.warnings) setError(pipelineResult.warnings);
        setMessages([...newMessages, pipelineResult.finalMessage]);
        // Approved tool edits (Phase 2 gate): the resuming loop's final
        // reply carries the staged writes — put them into the editor draft
        // (dirty, save-gated). Declines/timeouts arrive with no staged
        // edits, so plain Q&A and declined flows are untouched.
        const stagedEdits = pipelineResult.finalMessage.pendingEdits;
        if (stagedEdits && stagedEdits.length > 0) {
          await applyApprovedToolEdits(stagedEdits);
        }
        // Background completion signal: if the dialog is closed when the reply
        // lands, flag the toolbar button so the user knows it's ready.
        if (!openRef.current) {
          useAiStore.getState().setChatStatus('success');
        }
      } catch (err: unknown) {
        const stopped = stopController.signal.aborted || err instanceof api.ChatStoppedError;
        if (stopped) {
          // User pressed Stop — keep the user message in history, no error banner.
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
      applyApprovedToolEdits,
      attachedConfigFiles,
      draftRequestMessage,
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

  // ── Approval card polling (Phase 2) ────────────────────────────
  // While a chat request is loading AND no decision is in flight, poll
  // for a suspended approval. Appears when the backend loop suspends on
  // a validated write; disappears once resolved (approved/declined/
  // timeout/stop — the next poll returns pending:false).
  useEffect(() => {
    if (!loading || !stopRequestId) return undefined;
    let cancelled = false;
    const tick = async () => {
      const poll = await api.pollChatApproval(stopRequestId);
      if (cancelled) return;
      if (poll.pending) {
        const existing = approvalCardRef.current;
        if (!existing || existing.approvalId !== poll.approvalId) {
          approvalCardRef.current = poll;
          setApprovalCard(poll);
          setApprovalReceivedAt(Date.now());
          setApprovalNow(Date.now());
          setApprovalInvalidation(null);
          // A NEW card is a fresh decision: busy is per-card, never
          // inherited. Without this, approving op 1 strands approvalBusy
          // (the ok path clears the card, not the flag) and op 2's card
          // renders with disabled buttons until timeout.
          setApprovalBusy(false);
        } else {
          // Same card: refresh remaining-time + advisories only when
          // unchanged fields don't matter; keep decision-in-flight view.
          setApprovalCard((prev) => (prev && prev.approvalId === poll.approvalId && !approvalBusy
            ? { ...poll }
            : prev));
        }
      } else if (approvalCardRef.current && !approvalBusy) {
        // Card resolved/closed server-side (e.g. timeout auto-decline):
        // drop it. A decision POST in flight keeps it visible until the
        // main request completes and loading clears.
        approvalCardRef.current = null;
        setApprovalCard(null);
      }
    };
    void tick();
    const interval = window.setInterval(() => { void tick(); }, 1000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [loading, stopRequestId, approvalBusy]);

  // Countdown tick while a card is visible (display only; the backend
  // timer auto-declines authoritatively).
  useEffect(() => {
    if (!approvalCard) return undefined;
    const interval = window.setInterval(() => setApprovalNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [approvalCard]);

  const buildDecisionContext = useCallback(async (): Promise<Record<string, { content: string; label: string }>> => {
    // Latest working content for re-validation: all loaded files (drafts
    // win over saved), plus anything attached to this conversation.
    const ctx: Record<string, { content: string; label: string }> = {};
    for (const filename of Object.keys(configFiles)) {
      const text = await getConfigText(filename);
      if (text != null) ctx[filename] = { content: text, label: getConfigContextLabel(filename) };
    }
    for (const file of attachedConfigFiles) {
      ctx[file.name] = { content: file.content, label: 'User-attached local Klipper config file' };
    }
    return ctx;
  }, [configFiles, getConfigText, getConfigContextLabel, attachedConfigFiles]);

  const handleApprovalDecision = useCallback(async (decision: 'approve' | 'decline') => {
    const card = approvalCardRef.current;
    if (!card || approvalBusy) return;
    setApprovalBusy(true);
    setApprovalInvalidation(null);
    try {
      const contextFiles = await buildDecisionContext();
      const result = await api.decideChatApproval(card.approvalId, decision, contextFiles);
      if (result.status === 'invalidated') {
        setApprovalInvalidation(
          `Config changed since this proposal — ${result.reason || 'the change no longer applies'}. `
          + 'Decline this card or approve again after resolving the conflict.',
        );
        setApprovalBusy(false);
        return;
      }
      if (result.status === 'ok') {
        // Decision recorded; the suspended backend loop resumes and the
        // main /ai/chat fetch completes through the normal pipeline.
        // busy only guards the POST in flight — clear it or the NEXT
        // card of a multi-op request inherits it (greyed buttons,
        // chat stuck until timeout).
        approvalCardRef.current = null;
        setApprovalCard(null);
        setApprovalBusy(false);
      } else {
        setApprovalInvalidation(
          result.status === 'already_decided'
            ? 'Already decided (timeout or another tab).'
            : 'Could not record the decision.',
        );
        approvalCardRef.current = null;
        setApprovalCard(null);
      }
    } catch {
      setApprovalInvalidation('Approval request failed — check the backend connection.');
      setApprovalBusy(false);
    }
  }, [approvalBusy, buildDecisionContext]);

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

  // Start a fresh conversation. (The old draft-preview reset retired with
  // the Phase-4 ratchet — there is no prose draft to drop.)
  const handleStartNewChat = useCallback(() => {
    clearMessages();
  }, [clearMessages]);

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
    handleStartNewChat();
    setAttachedConfigFiles([]);
  }, [saveCurrentConversation, handleStartNewChat]);

  // Carry the existing conversation into the "new" chat so the next prompt
  // appends to it — the model keeps all prior context.
  const handleCarryOverContext = useCallback(() => {
    saveCurrentConversation();
    setAttachedConfigFiles([]);
    setError(null);
    setShowCarryOverPrompt(false);
  }, [saveCurrentConversation]);

  const handleStartFreshChat = useCallback(() => {
    saveCurrentConversation();
    handleStartNewChat();
    setAttachedConfigFiles([]);
    setError(null);
    setShowCarryOverPrompt(false);
  }, [saveCurrentConversation, handleStartNewChat]);

  const handleLoadConversation = useCallback(
    (conversation: SavedConversation) => {
      // Save current conversation before loading a different one
      saveCurrentConversation();
      setMessages(conversation.messages);
      setSettings(conversation.settings);
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
            onReviewPrinterMemory={handleReviewPrinterMemory}
            onEditMessage={handleEditMessage}
            messagesEndRef={messagesEndRef}
          />
          {approvalCard && (
            <ChatApprovalCard
              card={approvalCard}
              receivedAtMs={approvalReceivedAt}
              nowMs={approvalNow}
              busy={approvalBusy}
              invalidation={approvalInvalidation}
              onApprove={() => { void handleApprovalDecision('approve'); }}
              onDecline={() => { void handleApprovalDecision('decline'); }}
              onShowFullDiff={() => { if (approvalCard) setApprovalDiffPreview(approvalCard); }}
            />
          )}
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

      {/* Full-file diff preview for a pending approval card */}
      {approvalDiffPreview && (
        <ApprovalDiffPreview
          card={approvalDiffPreview}
          onClose={() => setApprovalDiffPreview(null)}
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
