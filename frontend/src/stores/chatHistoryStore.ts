import { create } from 'zustand';
import { loadAiHistory, saveAiHistory } from '../services/api';
import type { ChatMessage, AiSettings } from './aiStore';

const STORAGE_KEY = 'klipper-wire-chat-history';
const MAX_SAVED_CONVERSATIONS = 50;

export interface SavedConversation {
  id: string;
  title: string;
  timestamp: number;
  messages: ChatMessage[];
  settings: AiSettings;
  /** Config files that were attached during the original chat, so a loaded
   * conversation can be continued with the same file context. */
  attachedConfigFiles?: Array<{ name: string; content: string }>;
}

interface ChatHistoryState {
  conversations: SavedConversation[];
  _loaded: boolean;
  saveConversation: (
    messages: ChatMessage[],
    settings: AiSettings,
    attachedConfigFiles?: Array<{ name: string; content: string }>,
  ) => string;
  deleteConversation: (id: string) => void;
  loadConversations: () => Promise<void>;
  clearHistory: () => void;
}

function generateTitle(messages: ChatMessage[]): string {
  for (const msg of messages) {
    if (msg.role === 'user' && !msg.hiddenFromUser) {
      const text = msg.content.trim();
      // Take first ~60 chars of the first user message
      const truncated = text.length > 60 ? text.slice(0, 57) + '...' : text;
      return truncated;
    }
  }
  return 'Empty conversation';
}

function isSavedConversation(value: unknown): value is SavedConversation {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as SavedConversation).id === 'string' &&
    typeof (value as SavedConversation).title === 'string' &&
    typeof (value as SavedConversation).timestamp === 'number' &&
    Array.isArray((value as SavedConversation).messages)
  );
}

function loadFromStorage(): SavedConversation[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isSavedConversation);
  } catch {
    return [];
  }
}

// Debounced save to the backend file so rapid save/delete actions coalesce
// into a single POST.
let historySaveTimer: ReturnType<typeof setTimeout> | null = null;
let pendingHistory: SavedConversation[] | null = null;

function scheduleSaveToFile(conversations: SavedConversation[]): void {
  pendingHistory = conversations;
  if (historySaveTimer !== null) return;
  historySaveTimer = setTimeout(() => {
    historySaveTimer = null;
    const toSave = pendingHistory;
    pendingHistory = null;
    if (toSave) {
      void saveAiHistory({ conversations: toSave });
    }
  }, 400);
}

export const useChatHistoryStore = create<ChatHistoryState>()((set, get) => ({
  conversations: [],
  _loaded: false,

  loadConversations: async () => {
    if (get()._loaded) return;
    // Prefer the backend file; fall back to localStorage migration.
    const file = await loadAiHistory();
    const fileConversations = Array.isArray(file?.conversations)
      ? file.conversations.filter(isSavedConversation)
      : null;
    if (fileConversations !== null && fileConversations.length > 0) {
      set({ conversations: fileConversations, _loaded: true });
      return;
    }
    const local = loadFromStorage();
    set({ conversations: local, _loaded: true });
    if (local.length > 0) {
      scheduleSaveToFile(local);
    }
  },

  saveConversation: (
    messages: ChatMessage[],
    settings: AiSettings,
    attachedConfigFiles?: Array<{ name: string; content: string }>,
  ): string => {
    const nonEmptyMessages = messages.filter(
      (m) => m.content.trim().length > 0 && (m.role === 'user' || m.role === 'assistant'),
    );
    if (nonEmptyMessages.length === 0) return '';

    const id = `chat_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const title = generateTitle(nonEmptyMessages);
    const entry: SavedConversation = {
      id,
      title,
      timestamp: Date.now(),
      messages: nonEmptyMessages,
      settings,
      attachedConfigFiles: attachedConfigFiles && attachedConfigFiles.length > 0 ? attachedConfigFiles : undefined,
    };

    const conversations = get().conversations;
    const updated = [entry, ...conversations].slice(0, MAX_SAVED_CONVERSATIONS);
    scheduleSaveToFile(updated);
    set({ conversations: updated });
    return id;
  },

  deleteConversation: (id: string) => {
    const conversations = get().conversations.filter((c) => c.id !== id);
    scheduleSaveToFile(conversations);
    set({ conversations });
  },

  clearHistory: () => {
    scheduleSaveToFile([]);
    set({ conversations: [] });
  },
}));
