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
import React, { useState, useRef, useEffect, useLayoutEffect, useCallback, useMemo } from 'react';
import { useAiStore, AiProvider, providerRequiresApiKey, type ChatMessage } from '../../stores/aiStore';
import { useChatHistoryStore } from '../../stores/chatHistoryStore';
import { useConfigStore } from '../../stores/configStore';
import { usePendingEditStore } from '../../stores/pendingEditStore';
import { usePrinterMemoryStore, DEFAULT_PRINTER_MEMORY, type PrinterMemory } from '../../stores/printerMemoryStore';
import * as api from '../../services/api';
import { extractPrinterMemoryBlock } from '../../utils/printerMemory';
import { planApprovedEditApply } from '../../utils/approvalApply';
import {
  foldApprovalCountdown,
  type ApprovalCountdownAnchor,
} from '../../utils/approvalDiff';
import { buildChatRequestCredentials } from '../../utils/chatRequestBase';
import { selectUnsavedDrafts } from '../../utils/chatContext';
import { buildReferenceContext, findingsForScope, mentionMatches, nodeToReference, referenceLabel, type ChatReference, type MentionSource } from '../../utils/chatReferences';
import { isNearBottom, nextStickToBottom } from '../../utils/chatScroll';
import {
  EMPTY_PROGRESS,
  applyProgressSnapshot,
  type ProgressDisplay,
} from '../../utils/chatProgress';
import {
  PROVIDER_OPTIONS,
  PROVIDER_DEFAULTS,
  isLocalProvider,
  resolveProviderApiUrl,
  getProviderModel,
} from '../../utils/chatProviders';
import { runReplyValidationPipeline, createPrinterMemoryReplyValidator } from '../../utils/replyValidation';
import { useAssistantDraft } from '../../hooks/useAssistantDraft';
import { createPortal } from 'react-dom';
import { useUiStore } from '../../stores/uiStore';
import { useChatReferenceStore } from '../../stores/chatReferenceStore';
import { useVisibility } from '../../stores/validationSettingsStore';
import ChatSettingsPanel from './ChatSettingsPanel';
import ChatHistoryDialog from './ChatHistoryDialog';
import PrinterMemoryDialog from './PrinterMemoryDialog';
import ChatMessageList from './ChatMessageList';
import ChatApprovalCard from './ChatApprovalCard';
import ApprovalDiffPreview from './ApprovalDiffPreview';
import type { ApprovalCard } from '../../services/api';
import ChatInputBar, { type ChatReferenceChip } from './ChatInputBar';
import ChatEditRows from './ChatEditRows';
import ChangeSetBar from './ChangeSetBar';
import { useChangeSetStore, changeSetTotals } from '../../stores/changeSetStore';
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
  /**
   * `'modal'` (default) is the overlay the toolbar opens. `'dock'` renders
   * the SAME content tree as a narrow column, portalled into the host
   * element `TextEditor` publishes in the text view's flex row.
   *
   * This is a shell-level switch ONLY. The dialog is deliberately a single
   * mounted instance (`Toolbar` never unmounts it) so that one conversation,
   * one draft and one in-flight request survive folding and view switches;
   * giving the dock its own component would mean two drafts, two approval
   * cards, and an "which instance owns the request?" bug on the first switch.
   */
  variant?: 'modal' | 'dock';
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
  variant = 'modal',
}) => {
  // ── Stores ──────────────────────────────────────────────────────
  const { settings, setSettings, isConfigured, messages, setMessages, clearMessages, chatStatus } = useAiStore();
  const {
    configFiles,
    activeFile,
    validation,
    schemas,
    originalTexts,
    isDirty,
    updateConfigFile,
    removeConfigFile,
    markDirty,
  } = useConfigStore();

  // ── Docked panel (text view) ────────────────────────────────────
  // The dock is this same instance rendered into a host element that the
  // editor's flex row publishes, instead of into a full-screen overlay.
  // `docked` is false when the rail is collapsed or the text view is
  // unmounted — the component stays MOUNTED either way, so an in-flight
  // request keeps running and the reply is there when the panel reopens.
  const dockHost = useUiStore((s) => s.dockHost);
  const showChatDock = useUiStore((s) => s.showChatDock);
  const setShowChatDock = useUiStore((s) => s.setShowChatDock);
  const composerFocusNonce = useUiStore((s) => s.composerFocusNonce);
  const docked = variant === 'dock' && dockHost !== null && showChatDock && isConfigured();

  // ── Attached context references ─────────────────────────────────
  const visibility = useVisibility();
  const pinnedReferences = useChatReferenceStore((s) => s.pinned);
  const selectionReference = useChatReferenceStore((s) => s.selection);
  const previewReference = useChatReferenceStore((s) => s.preview);

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
  // Countdown anchor paired with the payload currently on screen (see
  // foldApprovalCountdown): the poll replaces the payload every second and
  // its timeoutSeconds is already the backend's seconds-remaining, so the
  // anchor must move with the payload — a stale anchor ticks the countdown
  // down twice as fast as the backend's real deadline.
  const [approvalAnchor, setApprovalAnchor] = useState<ApprovalCountdownAnchor | null>(null);
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
  // ── Mid-loop progress (Phase 6.5.4) ──
  // Poll alongside the approval rail while a send is in flight. Display
  // only: narration is the model's own tool-turn text, visually
  // subordinate; it never substitutes for the answer (never-final law).
  const [progress, setProgress] = useState<ProgressDisplay>(EMPTY_PROGRESS);
  // ── Post-hoc edit review (2026-10-02) ──
  // The change set is applied to the editor as it accumulates and reviewed
  // here after the reply: rows in the transcript (from the store, so the
  // transcript and the footer can never disagree) plus a resolve call for
  // every keep/undo. `appliedStagedRef` dedupes the poll's per-file
  // snapshots so the same text is not re-parsed every 1.5s.
  const changeSetView = useChangeSetStore((state) => state.view);
  const changeSetExpanded = useChangeSetStore((state) => state.expanded);
  const changeSetUndone = useChangeSetStore((state) => state.undone);
  const changeSet = useChangeSetStore((state) => state);
  const appliedStagedRef = useRef<string>('');
  const [changeSetBusy, setChangeSetBusy] = useState(false);
  const [changeSetNote, setChangeSetNote] = useState<string | null>(null);
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
  const messagesScrollRef = useRef<HTMLDivElement>(null);
  // Auto-scroll stick state (see utils/chatScroll): follow new content
  // while at the bottom, stop the moment the user scrolls up to read
  // history. Ref (not state): scroll events must not re-render the dialog.
  const stickToBottomRef = useRef(true);
  const lastScrollTopRef = useRef(0);
  const inputRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const handledPendingRequestIdRef = useRef<string | null>(null);
  // Live open state for async completions: the toolbar button only flashes
  // green/red when the dialog is closed at the moment the request finishes.
  const openRef = useRef(open);
  // "The user is looking at the chat right now" — true for the modal and for
  // a folded-out dock. Used only to decide whether a background event needs
  // to hail the toolbar status dot; when the panel is on screen it doesn't.
  openRef.current = open || docked;
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
    } else if (
      approvalCardRef.current &&
      !approvalBusy &&
      useAiStore.getState().chatStatus === 'idle'
    ) {
      // Re-raising: an unresolved approval card is still waiting on a
      // decision — closing the dialog (e.g. after peeking at it) should
      // turn the button green again.
      useAiStore.getState().setChatStatus('awaiting');
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

  // ── Auto-scroll to bottom (sticky) ──────────────────────────────
  // Follows new messages AND content growth (approval cards, progress
  // strip, long markdown reflows) while the user is at the bottom.
  // Scrolling up releases the stick; returning to the bottom re-arms it.
  const handleMessagesScroll = useCallback(() => {
    const el = messagesScrollRef.current;
    if (!el) return;
    const scrolledUp = el.scrollTop < lastScrollTopRef.current;
    lastScrollTopRef.current = el.scrollTop;
    stickToBottomRef.current = nextStickToBottom(
      stickToBottomRef.current,
      isNearBottom(el.scrollTop, el.scrollHeight, el.clientHeight),
      scrolledUp,
    );
  }, []);

  const scrollToBottom = useCallback((behavior: ScrollBehavior) => {
    messagesEndRef.current?.scrollIntoView({ behavior });
  }, []);

  // Mount/layout pass: jump to the newest message with no animation —
  // smooth-scrolling the entire history on every dialog open is what
  // this replace (the old effect animated on every messages change,
  // including dialog open and history load).
  useLayoutEffect(() => {
    if (stickToBottomRef.current) {
      lastScrollTopRef.current = messagesScrollRef.current?.scrollTop ?? 0;
      scrollToBottom('auto');
    }
  }, [messages, progress, approvalCard, scrollToBottom]);

  // When a send starts, always snap to the fresh user message: the user
  // acting is intent to be at the bottom, even while reading history.
  useEffect(() => {
    if (loading) {
      stickToBottomRef.current = true;
      scrollToBottom('auto');
    }
  }, [loading, scrollToBottom]);

  // Re-arm on dialog open: the component stays mounted while closed, so
  // the scroll container remounts fresh at the top of the history.
  useEffect(() => {
    if (open) {
      stickToBottomRef.current = true;
      scrollToBottom('auto');
    }
  }, [open, scrollToBottom]);

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
      // The text view's pending-diff pane follows the same slot: a new
      // request starts with nothing pending.
      usePendingEditStore.getState().clearPending();
      // Post-hoc review: the previous reply's change set is replaced by
      // this request's, and the live-staging dedupe starts over.
      useChangeSetStore.getState().clear();
      appliedStagedRef.current = '';
      setChangeSetNote(null);

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
      // Take the attached context for this message and empty the slots in ONE
      // step. Reading the store and clearing it separately is how the first
      // live build sent an empty list — see takeAttachedReferences. Findings
      // are resolved here because severity visibility is frontend state: a
      // tier the user has hidden must never be sent silently.
      const contextReferences = buildReferenceContext(
        useChatReferenceStore.getState().takeAttachedReferences(),
        validation,
        visibility,
      );

      setMessages(newMessages);
      setInput('');
      if (inputRef.current) inputRef.current.textContent = '';
      setLoading(true);
      setError(null);
      connectionLostRef.current = false;
      setConnectionLost(false);

      try {
        // Credentials come from the COMMITTED store, read fresh at submit
        // time — never the settings-panel mirror. The mirror only syncs in
        // the open-effect, and the AI-Analyze flow submits in the same
        // render pass that opens the dialog, where the sync's state updates
        // aren't visible yet: the request went out with mount-time defaults
        // ("AI settings not configured" on a configured provider, live
        // report 2026-09-27). Typed-but-unsaved panel edits were never
        // meant to drive a send anyway.
        const chatRequestBase = buildChatRequestCredentials(
          useAiStore.getState().settings,
          stopRequestId,
        );

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

        // Unsaved-delta carry-over (live report 2026-09-25): files edited in
        // the editor but not yet saved — INCLUDING files the AI created and
        // the user approved in an EARLIER turn (approved ≠ saved) — were
        // invisible to this request's edit session. The session then kicked
        // back 'Include file not found' for a draft sitting right there in
        // the editor, while the identical manual include validated clean
        // (editor validation runs against the full store). Append every
        // store file whose current export differs from the saved baseline
        // (originalTexts), or that has no baseline at all (never saved).
        // Checked files above win; validation strictness is untouched — a
        // dangling include on a truly nonexistent file still errors.
        // isDirty gates the export sweep: a clean project has no delta.
        if (isDirty) {
          const storeTexts: Record<string, string> = {};
          for (const filename of Object.keys(configFiles)) {
            const text = await getConfigText(filename);
            if (text != null) storeTexts[filename] = text;
          }
          for (const filename of selectUnsavedDrafts(
            configFiles, originalTexts, storeTexts, new Set(Object.keys(contextFilesPayload)),
          )) {
            contextFilesPayload[filename] = {
              content: storeTexts[filename],
              label: getConfigContextLabel(filename),
            };
          }
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
          { ...chatRequestBase, contextFiles: contextFilesPayload, context_references: contextReferences },
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
            { ...chatRequestBase, contextFiles: contextFilesPayload, context_references: contextReferences },
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
        // The reply's change set is authoritative — it is what the resolve
        // endpoint replays — so it replaces whatever the poll last showed
        // (a final edit may have landed after the last poll tick).
        useChangeSetStore.getState().setFromStream(
          stopRequestId,
          pipelineResult.finalMessage.changeSet ?? null,
        );
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
        // The request is over: nothing left to decide. If the flow ended
        // without overwriting the signal (Stop, transient connection loss),
        // a lingering green 'awaiting' would be a lie — drop it to grey.
        // 'success'/'error' set above are untouched.
        if (useAiStore.getState().chatStatus === 'awaiting') {
          useAiStore.getState().setChatStatus('idle');
        }
      }
    },
    [
      activeFile,
      applyApprovedToolEdits,
      attachedConfigFiles,
      configFiles,
      draftRequestMessage,
      getConfigContextLabel,
      getConfigText,
      isDirty,
      loadedConfigFilenames,
      loading,
      messages,
      originalTexts,
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
          setApprovalNow(Date.now());
          setApprovalInvalidation(null);
          // Mirror the card into the text view's pending-diff pane. Keyed on
          // this same "new approvalId" moment so the pane and the card can
          // never disagree about which change is waiting.
          usePendingEditStore.getState().setPending(poll);
          // A NEW card is a fresh decision: busy is per-card, never
          // inherited. Without this, approving op 1 strands approvalBusy
          // (the ok path clears the card, not the flag) and op 2's card
          // renders with disabled buttons until timeout.
          setApprovalBusy(false);
          // Background signal: an edit decision is waiting. Same green
          // as a finished reply — the point is pulling the user back to
          // the dialog. 'awaiting' (not 'success') keeps the distinct
          // tooltip; the request's own completion/error later overwrites
          // it through the normal submitMessage path.
          if (!openRef.current) {
            useAiStore.getState().setChatStatus('awaiting');
          }
        } else {
          // Same card: refresh remaining-time + advisories only when
          // unchanged fields don't matter; keep decision-in-flight view.
          setApprovalCard((prev) => (prev && prev.approvalId === poll.approvalId && !approvalBusy
            ? { ...poll }
            : prev));
        }
        // Every accepted payload carries the backend's CURRENT remainder, so
        // it re-anchors the countdown at its own arrival time (a stale anchor
        // ticks the window down twice as fast — foldApprovalCountdown).
        setApprovalAnchor((prev) => foldApprovalCountdown(
          prev,
          { approvalId: poll.approvalId, timeoutSeconds: poll.timeoutSeconds },
          Date.now(),
          approvalBusy,
        ));
      } else if (approvalCardRef.current && !approvalBusy) {
        // Card resolved/closed server-side (e.g. timeout auto-decline):
        // drop it. A decision POST in flight keeps it visible until the
        // main request completes and loading clears.
        const resolvedId = approvalCardRef.current.approvalId;
        approvalCardRef.current = null;
        setApprovalCard(null);
        setApprovalAnchor(null);
        // The pane mirrors the card slot, so it drops with it — keyed on the
        // card we are dropping so a late poll cannot clear a NEWER one.
        usePendingEditStore.getState().clearPending(resolvedId);
        // The decision is no longer actionable — a lingering green
        // 'awaiting' would keep hailing the user for nothing. Return to
        // grey (only if WE raised the flag; never clobber an 'error').
        // If the resumed request later completes with a final reply, the
        // normal success path re-flags green.
        if (!openRef.current && useAiStore.getState().chatStatus === 'awaiting') {
          useAiStore.getState().setChatStatus('idle');
        }
      }
    };
    void tick();
    const interval = window.setInterval(() => { void tick(); }, 1000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [loading, stopRequestId, approvalBusy]);

  // ── Mid-loop progress polling (Phase 6.5.4) ──────────────────────
  // Same rail pattern as the approval poll, ~1.5s cadence (progress is
  // less time-critical than a decision countdown). Accumulates deduped
  // across polls; cleared when no request is in flight so a new send
  // never inherits the previous run's steps.
  useEffect(() => {
    if (!loading || !stopRequestId) {
      setProgress(EMPTY_PROGRESS);
      return undefined;
    }
    let cancelled = false;
    const tick = async () => {
      const poll = await api.pollChatProgress(stopRequestId);
      if (cancelled || !poll.pending) return;
      setProgress((prev) => applyProgressSnapshot(prev, {
        turn: poll.turn ?? 0,
        narration: poll.narration ?? '',
        toolNames: poll.toolNames ?? [],
        elapsedMs: poll.elapsedMs ?? 0,
      }));
      // ── Live staging (post-hoc review) ──
      // The edit lands in the editor as the model makes it, and the rows in
      // the transcript are the live view of the same accumulating set. The
      // payload is per-file NET text, so applying it repeatedly is a no-op;
      // the signature check keeps the ~1.5s poll from re-parsing every tick.
      if (poll.stagedEdits && poll.stagedEdits.length > 0) {
        const signature = JSON.stringify(poll.stagedEdits);
        if (signature !== appliedStagedRef.current) {
          appliedStagedRef.current = signature;
          void applyApprovedToolEdits(poll.stagedEdits);
        }
      }
      if (poll.changeSet) {
        useChangeSetStore.getState().setFromStream(stopRequestId, poll.changeSet);
      }
    };
    void tick();
    const interval = window.setInterval(() => { void tick(); }, 1500);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [loading, stopRequestId, applyApprovedToolEdits]);

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

  // ── Keep/undo a change set (post-hoc review) ────────────────────
  // Undo is expressed as a KEEP LIST and resolved on the server by REPLAYING
  // the kept ops onto the request's baseline — never by reverting text here,
  // which would leave the residue of a dropped op behind. The returned file
  // texts go through the same apply path the staged edits use, so keep/undo
  // and stage share one mutation surface.
  const resolveChangeSet = useCallback(
    async (keptIds: string[]) => {
      const requestId = useChangeSetStore.getState().requestId;
      if (!requestId) return;
      setChangeSetBusy(true);
      setChangeSetNote(null);
      try {
        const contextFiles = await buildDecisionContext();
        const out = await api.resolveChangeSet({ requestId, keptEditIds: keptIds, contextFiles });
        if (out.status !== 'ok' || !out.files) {
          setChangeSetNote('This change set is no longer available — the changes in the editor stand as they are.');
          return;
        }
        const resolved = Object.entries(out.files).map(([file, entry]) => ({
          file,
          op: entry.deleted ? 'delete_file' : 'update',
          summary: '',
          newText: entry.content,
        }));
        await applyApprovedToolEdits(resolved);
        // A rejected change set leaves the text exactly as it was on disk;
        // the dirty flag must say so rather than flag a project for saving
        // nothing changed.
        useConfigStore.getState().markCleanIfMatchesDisk();
        if (out.stale && out.stale.length > 0) {
          setChangeSetNote(
            `${out.stale.length} change(s) could not be re-applied: `
            + out.stale.map((entry) => entry.reason).join('; '),
          );
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'resolve failed';
        setChangeSetNote(`Could not resolve the change set: ${message}`);
      } finally {
        setChangeSetBusy(false);
      }
    },
    [applyApprovedToolEdits, buildDecisionContext],
  );

  const handleKeepAll = useCallback(() => {
    // Nothing to replay: the working state already holds every kept edit.
    useChangeSetStore.getState().keepAll();
    setChangeSetNote(null);
  }, []);

  const handleUndoAll = useCallback(() => {
    useChangeSetStore.getState().undoAll();
    void resolveChangeSet([]);
  }, [resolveChangeSet]);

  const handleUndoSection = useCallback(
    (file: string, section: string) => {
      useChangeSetStore.getState().undoSection(file, section);
      void resolveChangeSet(useChangeSetStore.getState().keptIds());
    },
    [resolveChangeSet],
  );

  const handleUndoFile = useCallback(
    (file: string) => {
      useChangeSetStore.getState().undoFile(file);
      void resolveChangeSet(useChangeSetStore.getState().keptIds());
    },
    [resolveChangeSet],
  );

  // ── Mid-loop steering ───────────────────────────────────────────
  // While a request is in flight the composer steers it: the message is
  // queued and injected as a real user turn at the next tool-turn boundary,
  // and it is shown in the transcript at the point it landed (the user's own
  // words — never a tool result, never a system nudge).
  const handleSteer = useCallback(async () => {
    const text = input.trim();
    if (!text || !loading) return;
    const requestId = stopRequestIdRef.current;
    if (!requestId) return;
    setInput('');
    if (inputRef.current) inputRef.current.textContent = '';
    const result = await api.steerChat(requestId, text);
    if (!result.accepted) {
      // The reply landed first: the words are still the user's, so do not
      // swallow them — put them back in the composer as a new message.
      setInput(text);
      if (inputRef.current) inputRef.current.textContent = text;
      setError('The reply had already finished — send that as a new message.');
      return;
    }
    setMessages([...messages, { role: 'user', content: text, steer: true }]);
  }, [input, loading, messages, setMessages]);

  const handleApprovalDecision = useCallback(async (decision: 'approve' | 'decline') => {
    const card = approvalCardRef.current;
    if (!card || approvalBusy) return;
    setApprovalBusy(true);
    setApprovalInvalidation(null);
    try {
      const contextFiles = await buildDecisionContext();
      const result = await api.decideChatApproval(card.approvalId, decision, contextFiles);
      // Stale-decision guard (final-pass review 2026-09-29): the two
      // awaits above give a stop/new request room to reset the card slot
      // (or the poll to install a NEW card). If OUR card is gone, this
      // response must touch nothing but the busy flag — clearing or
      // annotating a card the user hasn't decided yet is a phantom.
      // Round-2 review 2026-09-29: busy is GLOBAL, not per-card — if the
      // slot holds a NEWER card whose own decision is in flight
      // (busy=true), dropping our stale response must not unlock it.
      // Only clear busy when nothing owns it anymore (slot empty).
      if (approvalCardRef.current?.approvalId !== card.approvalId) {
        if (approvalCardRef.current === null) setApprovalBusy(false);
        return;
      }
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
        setApprovalAnchor(null);
        setApprovalBusy(false);
        usePendingEditStore.getState().clearPending(card.approvalId);
      } else {
        setApprovalInvalidation(
          result.status === 'already_decided'
            ? 'Already decided (timeout or another tab).'
            : 'Could not record the decision.',
        );
        approvalCardRef.current = null;
        setApprovalCard(null);
        setApprovalAnchor(null);
        usePendingEditStore.getState().clearPending(card.approvalId);
      }
    } catch {
      if (approvalCardRef.current?.approvalId === card.approvalId) {
        setApprovalInvalidation('Approval request failed — check the backend connection.');
        setApprovalBusy(false);
      } else if (approvalCardRef.current === null) {
        setApprovalBusy(false);
      }
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
    useChatReferenceStore.getState().clear();
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
  // A queued request (Save → "Analyze with AI") runs whether the surface
  // showing it is the modal or the docked panel.
  useEffect(() => {
    if ((!open && !docked) || !pendingRequest || loading || !isConfigured()) return;
    if (handledPendingRequestIdRef.current === pendingRequest.id) return;
    handledPendingRequestIdRef.current = pendingRequest.id;
    onPendingRequestHandled?.();
    void submitMessage(pendingRequest.prompt, { hiddenFromUser: pendingRequest.hiddenFromUser });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isConfigured, loading, onPendingRequestHandled, open, docked, pendingRequest]);

  // ── Composer focus requests ─────────────────────────────────────
  // The toolbar's Chat button means "take me to the input" when the panel is
  // already showing; a counter state flag is how that reaches across.
  useEffect(() => {
    if (composerFocusNonce === 0 || !docked) return;
    inputRef.current?.focus();
  }, [composerFocusNonce, docked]);

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

  // ── Composer reference chips ────────────────────────────────────
  // Three sources, in a fixed order: pinned (sent), the single transient
  // preview (NOT sent until `+` promotes it), and the live editor selection
  // (sent). Findings ride along as a coloured badge so the chip shows what
  // the model will also be told.
  const chipFor = useCallback(
    (reference: ChatReference, role: ChatReferenceChip['role']): ChatReferenceChip => {
      const findings = findingsForScope(reference, validation, visibility);
      return {
        id: reference.id,
        label: referenceLabel(reference),
        kind: reference.kind,
        role,
        findingsCount: findings.length,
        // findingsForScope returns worst-first.
        findingsSeverity: findings.length > 0 ? findings[0].severity : null,
      };
    },
    [validation, visibility],
  );

  const attachedReferenceChips = useMemo<ChatReferenceChip[]>(() => {
    const chips = pinnedReferences.map((reference) => chipFor(reference, 'pinned'));
    if (previewReference) chips.push(chipFor(previewReference, 'preview'));
    if (selectionReference) chips.push(chipFor(selectionReference, 'selection'));
    return chips;
  }, [pinnedReferences, previewReference, selectionReference, chipFor]);

  // ── @-mention sources ───────────────────────────────────────────
  // Project files first, then the active file's sections and their params —
  // the three things a Klipper question is ever about.
  const mentionSources = useMemo<MentionSource[]>(() => {
    const sources: MentionSource[] = loadedConfigFilenames.map((file) => ({
      kind: 'file' as const,
      file,
      label: file,
    }));
    const active = activeFile ? configFiles[activeFile] : undefined;
    if (activeFile && active) {
      for (const section of active.sections) {
        sources.push({
          kind: 'section',
          file: activeFile,
          label: section.full_header,
          section: section.full_header,
          line: section.line_number,
        });
        for (const param of section.params) {
          sources.push({
            kind: 'param',
            file: activeFile,
            label: param.key,
            section: section.full_header,
          });
        }
      }
    }
    return sources;
  }, [loadedConfigFilenames, configFiles, activeFile]);

  const mentionSourceMatches = useCallback(
    (query: string) => mentionMatches(query, mentionSources),
    [mentionSources],
  );

  const acceptMention = useCallback((source: MentionSource) => {
    const reference = nodeToReference({
      kind: source.kind,
      id: `${source.kind}:${source.file}:${source.label}`,
      label: source.label,
      file: source.file,
      section: source.section,
      line: source.line,
    });
    if (reference) useChatReferenceStore.getState().addPinned(reference);
  }, []);
  // ═════════════════════════════════════════════════════════════════
  // RENDER
  // ═════════════════════════════════════════════════════════════════

  // The dialog stays MOUNTED when closed so an in-flight request keeps
  // running (validation retries, connection-recovery listener, WIP state).
  // Closing only hides the overlay; reopening shows the finished reply.
  // Folding the dock behaves the same way: `docked` going false renders
  // nothing, but the instance — and therefore the streaming request, the
  // draft and any pending approval card — survives untouched.
  if (!open && !docked) {
    return null;
  }

  // ── Unconfigured State ──────────────────────────────────────────
  // Modal only. With no provider there is no panel to dock: `ChatDock`
  // renders its disabled rail and never publishes a host element, so
  // `docked` is false and this stays the one configuration entry point.
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
  // One content tree, two shells. `docked` swaps the wrapper (overlay vs.
  // column) and the header's density; nothing below this line knows or
  // cares which shell it is in.

  const providerLabel = PROVIDER_OPTIONS.find((option) => option.value === settings.apiProvider)?.label
    ?? String(settings.apiProvider);
  const modelLabel = settings.model || 'default model';
  const statusTitle =
    chatStatus === 'success' ? 'Last response is ready'
      : chatStatus === 'awaiting' ? 'An edit is waiting for your decision'
        : chatStatus === 'error' ? 'The last request failed'
          : 'Idle';
  const statusDotClass =
    chatStatus === 'success' || chatStatus === 'awaiting' ? 'bg-green-500'
      : chatStatus === 'error' ? 'bg-red-500'
        : 'bg-[var(--color-bg-tertiary)]';
  const iconButtonClass =
    'rounded p-1 text-[var(--color-text-secondary)] transition-colors hover:text-[var(--color-text-primary)] disabled:opacity-40 disabled:cursor-not-allowed';

  const header = docked ? (
    // Mirrors ConfigTree's header so the two side panels read as a pair:
    // label + status on the left, controls on the right, `>` to fold.
    <div className="shrink-0 border-b border-[var(--color-bg-tertiary)]">
      <div className="flex items-center justify-between gap-2 px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className={`h-2 w-2 shrink-0 rounded-full ${statusDotClass}`} title={statusTitle} />
          <h2 className="truncate text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-secondary)]">
            AI Chat
          </h2>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            onClick={handleNewChatWithSave}
            disabled={loading || messages.length === 0}
            className={iconButtonClass}
            title="Start a new chat"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
          <button
            onClick={() => setShowChatHistory(true)}
            className={iconButtonClass}
            title="View and load past conversations"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <circle cx="8" cy="8" r="5.5" stroke="currentColor" strokeWidth="1.5" />
              <path d="M8 5v3.2l2 1.3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <button
            onClick={() => {
              setShowPrinterMemory(true);
              // Clear any stale proposal when opening manually
              setProposedMemory(null);
            }}
            className={iconButtonClass}
            title="View and edit printer memory"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <rect x="4.5" y="4.5" width="7" height="7" rx="1" stroke="currentColor" strokeWidth="1.5" />
              <path d="M6.5 4.5v-2h3v2M6.5 11.5v2h3v-2M2.5 6.5h2M11.5 6.5h2M2.5 9.5h2M11.5 9.5h2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
          <button
            onClick={() => setShowSettings(!showSettings)}
            className={iconButtonClass}
            title="AI Settings"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.5" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <button
            onClick={() => setShowChatDock(false)}
            className="rounded border border-[var(--color-bg-tertiary)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--color-text-secondary)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
            title="Collapse AI chat"
          >
            {'>'}
          </button>
        </div>
      </div>
      {/* "Which model answered this?" is the recurring question — answer it
          where the answer is needed, without a trip to Settings. */}
      <div
        className="truncate px-3 pb-2 text-[10px] text-[var(--color-text-secondary)]"
        title={`${providerLabel} · ${modelLabel}`}
      >
        {providerLabel} · {modelLabel}
      </div>
    </div>
  ) : (
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
  );

  const body = (
    <>
      {header}

      {/* Inline Settings Panel */}
      {showSettings && (
        <ChatSettingsPanel standalone={false} {...settingsPanelProps} />
      )}

      {/* Messages area */}
      <div
        ref={messagesScrollRef}
        onScroll={handleMessagesScroll}
        className={docked ? 'flex-1 overflow-y-auto p-3' : 'flex-1 overflow-y-auto p-4'}
        // The dock is a full-height column, so the modal's fixed height band
        // is dropped rather than translated into a shorter window.
        style={docked ? undefined : { minHeight: 350, maxHeight: 450 }}
      >
        <ChatMessageList
          messages={messages}
          loading={loading}
          progress={progress}
          error={connectionLost ? 'Connection lost — the last question will resend automatically when the network returns.' : error}
          onRetry={handleRetry}
          activeFile={activeFile}
          onReviewPrinterMemory={handleReviewPrinterMemory}
          onEditMessage={handleEditMessage}
          messagesEndRef={messagesEndRef}
        />
        {/* Post-hoc review: one row per edit the model made, streaming in as
            it makes them. Read-only — the decision lives in the footer bar. */}
        {changeSetView && (
          <ChatEditRows
            view={changeSetView}
            expanded={changeSetExpanded}
            undone={changeSetUndone}
            onToggle={(id) => useChangeSetStore.getState().toggleExpanded(id)}
          />
        )}
        {approvalCard && (
          <ChatApprovalCard
            card={approvalCard}
            receivedAtMs={approvalAnchor?.receivedAtMs ?? approvalNow}
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
      {/* Post-hoc review footer: totals, keep-all / reject-all, per-file and
          per-section keep/undo, and the "N unreviewed" state that stays
          visible until every edit has been decided (including at Save). */}
      {changeSetView && (
        <ChangeSetBar
          view={changeSetView}
          totals={changeSetTotals(changeSet)}
          unreviewed={changeSet.unreviewedCount()}
          undone={changeSetUndone}
          busy={changeSetBusy}
          note={changeSetNote}
          onKeepAll={handleKeepAll}
          onUndoAll={handleUndoAll}
          onUndoSection={handleUndoSection}
          onUndoFile={handleUndoFile}
          onOpenFile={(file) => {
            const config = configFiles[file];
            if (config) useConfigStore.getState().setActiveFile(file);
          }}
        />
      )}
      <ChatInputBar
        input={input}
        loading={loading}
        onSteer={() => { void handleSteer(); }}
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
        compact={docked}
        references={docked ? attachedReferenceChips : undefined}
        onRemoveReference={(id) => {
          const store = useChatReferenceStore.getState();
          if (store.preview?.id === id) store.setPreview(null);
          else if (store.selection?.id === id) store.dismissSelection();
          else store.removePinned(id);
        }}
        onPromoteReference={() => useChatReferenceStore.getState().promotePreview()}
        onMentionQuery={mentionSourceMatches}
        onMentionAccept={acceptMention}
        onReferenceJump={(id) => {
          const all = [
            ...pinnedReferences,
            ...(previewReference ? [previewReference] : []),
            ...(selectionReference ? [selectionReference] : []),
          ];
          const reference = all.find((candidate) => candidate.id === id);
          if (!reference) return;
          // A lines reference carries its own range; everything else points
          // at the line of the section/param it names.
          const line = reference.startLine ?? reference.line;
          if (line != null) useConfigStore.getState().requestLineJump(reference.file, line);
        }}
      />
    </>
  );

  const overlays = (
    <>
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
    </>
  );

  // ── Docked shell ────────────────────────────────────────────────
  // The panel is a real panel: it occupies its own flex column in the text
  // view and pushes the editor's width. Dialogs it opens (history, printer
  // memory, the diff preview, the carry-over prompt) stay full-screen
  // overlays — they are modal decisions, not part of the column.
  if (docked && dockHost) {
    return (
      <>
        {createPortal(
          <div className="flex h-full w-full flex-col overflow-hidden bg-[var(--color-bg-secondary)]">
            {body}
          </div>,
          dockHost,
        )}
        {overlays}
      </>
    );
  }

  // ── Modal shell (unchanged) ─────────────────────────────────────
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="bg-[var(--color-bg-secondary)] rounded-xl border border-[var(--color-bg-tertiary)] shadow-2xl w-[620px] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {body}
      </div>

      {overlays}
    </div>
  );
};

export default ChatDialog;
