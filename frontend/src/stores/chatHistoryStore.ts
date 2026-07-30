import { create } from 'zustand';
import type { ChatMessage, AiSettings } from './aiStore';

const STORAGE_KEY = 'klipper-wire-chat-history';
const MAX_SAVED_CONVERSATIONS = 50;

export interface SavedConversation {
  id: string;
  title: string;
  timestamp: number;
  messages: ChatMessage[];
  settings: AiSettings;
}

interface ChatHistoryState {
  conversations: SavedConversation[];
  _loaded: boolean;
  saveConversation: (messages: ChatMessage[], settings: AiSettings) => string;
  deleteConversation: (id: string) => void;
  loadConversations: () => void;
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

function loadFromStorage(): SavedConversation[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (c: unknown): c is SavedConversation =>
        typeof c === 'object' &&
        c !== null &&
        typeof (c as SavedConversation).id === 'string' &&
        typeof (c as SavedConversation).title === 'string' &&
        typeof (c as SavedConversation).timestamp === 'number' &&
        Array.isArray((c as SavedConversation).messages),
    );
  } catch {
    return [];
  }
}

function saveToStorage(conversations: SavedConversation[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(conversations));
  } catch {
    // Storage full or unavailable — silently fail
  }
}

export const useChatHistoryStore = create<ChatHistoryState>()((set, get) => ({
  conversations: [],
  _loaded: false,

  loadConversations: () => {
    if (get()._loaded) return;
    const conversations = loadFromStorage();
    set({ conversations, _loaded: true });
  },

  saveConversation: (messages: ChatMessage[], settings: AiSettings): string => {
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
    };

    const conversations = get().conversations;
    const updated = [entry, ...conversations].slice(0, MAX_SAVED_CONVERSATIONS);
    saveToStorage(updated);
    set({ conversations: updated });
    return id;
  },

  deleteConversation: (id: string) => {
    const conversations = get().conversations.filter((c) => c.id !== id);
    saveToStorage(conversations);
    set({ conversations });
  },

  clearHistory: () => {
    saveToStorage([]);
    set({ conversations: [] });
  },
}));
