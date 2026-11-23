import { create } from 'zustand';
import { loadAiState, saveAiState, type AiToolCallDetail, type ChangeSetPayload, type PendingConfigEdit } from '../services/api';

const STORAGE_KEY = 'klipper-wire-ai-state';
const LEGACY_SETTINGS_KEY = 'klipper-wire-ai-settings';
const DEFAULT_PROVIDER: AiProvider = 'chatgpt';

export type AiProvider = 'google' | 'chatgpt' | 'anthropic' | 'github' | 'openai-compatible';
type ProviderModels = Partial<Record<AiProvider, string>>;

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  hiddenFromUser?: boolean;
  mcpToolNames?: string[];
  /** Executed tool calls with arguments + output, in execution order. */
  toolCalls?: AiToolCallDetail[];
  /** Number of macro sections whose trailing Jinja closers were auto-appended. */
  /** Number of retries the reply pipeline performed before accepting. */
  retryCount?: number;
  /** Number of backend empty-response re-prompts for this reply. */
  repromptCount?: number;
  /** Changes staged by the config_edit/config_write write tools (server-validated). */
  pendingEdits?: PendingConfigEdit[];
  /**
   * Post-hoc edit review: the reply's whole change set (one record per edit
   * plus the summary grouped by file/section). The dialog feeds it to the
   * change-set store; the transcript rows and the footer bar both read it
   * from there, so they can never disagree.
   */
  changeSet?: ChangeSetPayload | null;
  /** Mid-loop steers this request received while it was running. */
  steers?: Array<{ turn: number; text: string }>;
  /**
   * This message is a steer the user sent into an in-flight request, shown
   * in the transcript at the point it landed (the user's own words).
   */
  steer?: boolean;
  /**
   * The request that produced this reply. The post-hoc review's rows are
   * looked up by it, so a reply's edits stay with that reply in the
   * transcript even after later messages join the running total.
   */
  requestId?: string;
  /** Per-reply context telemetry for the Context chip (see MessageContextUsage). */
  contextUsage?: MessageContextUsage;
}

/**
 * The provider's own numbers for the call that produced a reply, plus what
 * the client measured. Persisted with the message (plain JSON) so a reloaded
 * conversation keeps its receipts instead of losing them with the live store.
 *
 * Null means "not reported", never zero: a provider that omits cache numbers
 * must not render as a 0% hit rate.
 */
export interface MessageContextUsage {
  /** usage.lastPromptTokens of the reply's last provider call. */
  promptTokens: number | null;
  /** usage.lastCachedTokens of that same call. */
  cachedTokens: number | null;
  /** The model's real window, when the session had probed it. */
  contextWindow: number | null;
  /**
   * Provider+model identity this reply was sent under (`apiUrl::model`, no
   * key material). Lets a chip drawn before the window probe settled borrow
   * the probe later — but only when the identity still matches.
   */
  windowKey?: string | null;
  /** Wall-clock duration of the reply as the client measured it. */
  replyMs: number | null;
  /** Model that answered (survives a later model switch in settings). */
  model: string | null;
}

export interface AiSettings {
  apiKey: string;
  /**
   * View-only flag from GET /ai/state: a key is stored on the server and
   * the apiKey field carries the sentinel instead of the value (the key
   * value never travels to the browser again). See utils/apiKeyMask.
   */
  hasApiKey?: boolean;
  model: string;
  providerModels: ProviderModels;
  apiUrl: string;
  apiProvider: AiProvider;
  host: string;
  port: string;
  /** Maximum tokens the AI is allowed to generate per response. */
  maxTokens: number;
  /** Sampling temperature for AI responses (0-2; 0.7 default). */
  temperature: number;
  /**
   * Tool-calling protocol for openai-compatible providers:
   * 'auto' (default) keeps the scheme split — plain http → text ```tool,
   * https → native function calling; 'native'/'text' force either.
   */
  toolProtocol: 'auto' | 'native' | 'text';
  /**
   * Reasoning effort for openai-compatible providers (the ONLY provider
   * this is wired for, scope 2026-11-21). 'default' (default value) sends
   * nothing at all — the model decides. Any other string is forwarded
   * verbatim as top-level `reasoning_effort`. Offered levels come from
   * the /ai/reasoning-levels probe (utils/chatReasoning); a level saved
   * under another endpoint survives a provider switch in this store but
   * is never sent to non-openai-compatible providers (backend-gated).
   */
  reasoningEffort: string;
}

interface PersistedAiState {
  settings?: Partial<AiSettings>;
  messages?: ChatMessage[];
}

function isChatMessage(value: unknown): value is ChatMessage {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const message = value as Partial<ChatMessage>;
  return (
    (message.role === 'user' || message.role === 'assistant')
    && typeof message.content === 'string'
  );
}

function loadPersistedState(): { settings: Partial<AiSettings>; messages: ChatMessage[] } {
  // PR #48: these localStorage blobs are migration SOURCES only — the
  // server holds state now, and a pre-masking copy of these keys held
  // the provider key IN PLAINTEXT. Nothing writes them any more, so
  // after this one read they are wiped: no cleartext key residue for
  // XSS or a shared machine's DevTools to find.
  const migrate = (): { settings: Partial<AiSettings>; messages: ChatMessage[] } => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as PersistedAiState | Partial<AiSettings>;
        if (parsed && typeof parsed === 'object' && ('settings' in parsed || 'messages' in parsed)) {
          const persisted = parsed as PersistedAiState;
          return {
            settings: persisted.settings ?? {},
            messages: Array.isArray(persisted.messages) ? persisted.messages.filter(isChatMessage) : [],
          };
        }
        return {
          settings: parsed as Partial<AiSettings>,
          messages: [],
        };
      }

      const legacyRaw = localStorage.getItem(LEGACY_SETTINGS_KEY);
      if (legacyRaw) {
        return {
          settings: JSON.parse(legacyRaw) as Partial<AiSettings>,
          messages: [],
        };
      }
    } catch {}

    return {
      settings: {},
      messages: [],
    };
  };
  const migrated = migrate();
  try {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(LEGACY_SETTINGS_KEY);
  } catch {}
  return migrated;
}

function validateToolCallDetail(value: unknown): value is AiToolCallDetail {
  if (!value || typeof value !== 'object') return false;
  const call = value as Partial<AiToolCallDetail>;
  return typeof call.name === 'string' && typeof call.arguments === 'string' && typeof call.output === 'string';
}

// Debounced save to the backend file. Chat updates can be bursty (validation
// retries append several messages quickly), so coalesce writes to one POST.
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let pendingState: { settings: AiSettings; messages: ChatMessage[] } | null = null;

function schedulePersistState(state: { settings: AiSettings; messages: ChatMessage[] }): void {
  pendingState = state;
  if (saveTimer !== null) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const toSave = pendingState;
    pendingState = null;
    if (toSave) {
      void saveAiState({ settings: toSave.settings, messages: toSave.messages });
    }
  }, 400);
}

const DEFAULT_PROVIDER_MODELS: ProviderModels = {
  chatgpt: 'gpt-4o',
  google: '',
  anthropic: '',
  github: '',
  'openai-compatible': 'gpt-4o',

};

function normalizeProviderModels(settings: Partial<AiSettings>): ProviderModels {
  const mergedProviderModels: ProviderModels = {
    ...DEFAULT_PROVIDER_MODELS,
    ...(settings.providerModels ?? {}),
  };
  const activeProvider = settings.apiProvider ?? DEFAULT_PROVIDER;
  const activeModel = typeof settings.model === 'string' ? settings.model.trim() : '';

  if (activeModel && !mergedProviderModels[activeProvider]?.trim()) {
    mergedProviderModels[activeProvider] = activeModel;
  }

  return mergedProviderModels;
}

function buildAiSettings(settings: Partial<AiSettings>): AiSettings {
  const merged = { ...DEFAULT_SETTINGS, ...settings };
  const providerModels = normalizeProviderModels(merged);
  const modelToUse = providerModels[merged.apiProvider] ?? DEFAULT_PROVIDER_MODELS[merged.apiProvider] ?? '';
  return {
    ...merged,
    providerModels,
    model: modelToUse,
    // A persisted state file with a missing/blank/garbage value must land
    // on 'default' (send-nothing), never on an accidental level.
    reasoningEffort:
      typeof merged.reasoningEffort === 'string' && merged.reasoningEffort.trim()
        ? merged.reasoningEffort.trim()
        : 'default',
  };
}

export function providerRequiresApiKey(provider: AiProvider): boolean {
  // Only cloud providers require API keys
  return provider === 'chatgpt' || provider === 'google' || provider === 'anthropic' || provider === 'github';
}

interface AiState {
  settings: AiSettings;
  messages: ChatMessage[];
  /**
   * Background completion signal for the toolbar button: 'success' when a
   * request finished while the dialog was closed, 'error' when it failed out
   * (retry limit / unrecoverable error), 'awaiting' when an approval card
   * (edit accept/decline) arrived while the dialog was closed — it renders
   * green like 'success' (the user needs to come look), 'idle' otherwise.
   * Transient UI state — NOT persisted to the backend file.
   */
  chatStatus: 'idle' | 'success' | 'error' | 'awaiting';
  /** Load AI settings + messages from the backend file (migrating localStorage). */
  loadState: () => Promise<void>;
  setSettings: (settings: Partial<AiSettings>) => void;
  setMessages: (messages: ChatMessage[]) => void;
  clearMessages: () => void;
  setChatStatus: (status: 'idle' | 'success' | 'error' | 'awaiting') => void;
  isConfigured: () => boolean;
}

const DEFAULT_SETTINGS: AiSettings = {
  apiKey: '',
  model: 'gpt-4o',
  providerModels: { ...DEFAULT_PROVIDER_MODELS },
  apiUrl: 'https://api.openai.com/v1/chat/completions',
  apiProvider: DEFAULT_PROVIDER,
  host: 'localhost',
  port: '11434',
  maxTokens: 4096,
  temperature: 0.7,
  toolProtocol: 'auto',
  reasoningEffort: 'default',
};

export const useAiStore = create<AiState>()((set, get) => {
  const persisted = loadPersistedState();

  return {
    settings: buildAiSettings(persisted.settings),
    messages: persisted.messages,
    chatStatus: 'idle',
    loadState: async () => {
      const file = await loadAiState();
      const fileSettings = file?.settings && typeof file.settings === 'object'
        ? (file.settings as Partial<AiSettings>)
        : {};
      const fileMessages = Array.isArray(file?.messages)
        ? file.messages.filter(isChatMessage)
        : null;

      // Prefer the backend file; fall back to what localStorage seeded.
      const hasFileSettings = Object.keys(fileSettings).length > 0;
      const hasFileMessages = fileMessages !== null && fileMessages.length > 0;
      if (!hasFileSettings && !hasFileMessages) return;

      set((state) => {
        const nextMessages = fileMessages ?? state.messages;
        const nextSettings = hasFileSettings
          ? buildAiSettings(fileSettings)
          : state.settings;
        // Persist the migrated seed so the backend file becomes the source.
        schedulePersistState({ settings: nextSettings, messages: nextMessages });
        return { settings: nextSettings, messages: nextMessages };
      });
    },
    setSettings: (partial) =>
      set((state) => {
        const nextProvider = partial.apiProvider ?? state.settings.apiProvider;
        const nextProviderModels: ProviderModels = {
          ...state.settings.providerModels,
          ...(partial.providerModels ?? {}),
        };

        if (typeof partial.model === 'string') {
          nextProviderModels[nextProvider] = partial.model;
        }

        const newSettings = buildAiSettings({
          ...state.settings,
          ...partial,
          apiProvider: nextProvider,
          providerModels: nextProviderModels,
        });
        schedulePersistState({ settings: newSettings, messages: state.messages });
        return { settings: newSettings };
      }),
    setMessages: (messages) =>
      set((state) => {
        schedulePersistState({ settings: state.settings, messages });
        return { messages };
      }),
    clearMessages: () =>
      set((state) => {
        schedulePersistState({ settings: state.settings, messages: [] });
        return { messages: [] };
      }),
    setChatStatus: (chatStatus) => set({ chatStatus }),
    isConfigured: () => {
      const s = get().settings;
      if (!s.model.trim()) {
        return false;
      }
      if (!providerRequiresApiKey(s.apiProvider)) {
        return true;
      }
      return !!s.apiKey.trim();
    },
  };
});
