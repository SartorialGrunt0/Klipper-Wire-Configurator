import React, { useState, useRef, useEffect, type ComponentPropsWithoutRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useAiStore, AiProvider, ChatMessage } from '../../stores/aiStore';
import * as api from '../../services/api';

interface ProviderInfo {
  label: string;
  defaultUrl: string;
  requiresKey: boolean;
  defaultHost: string;
  defaultPort: string;
}

const PROVIDER_OPTIONS: Array<{ value: AiProvider; label: string }> = [
  { value: 'chatgpt', label: 'ChatGPT (OpenAI)' },
  { value: 'google', label: 'Google (Gemini)' },
  { value: 'anthropic', label: 'Anthropic (Claude)' },
  { value: 'github', label: 'GitHub Copilot' },
  { value: 'openai-compatible', label: 'OpenAI Compatible' },
  { value: 'lm-studio', label: 'LM Studio (Local)' },
  { value: 'ollama', label: 'Ollama (Local)' },
];

const PROVIDER_DEFAULTS: Record<AiProvider, ProviderInfo> = {
  chatgpt: {
    label: 'ChatGPT (OpenAI)',
    defaultUrl: 'https://api.openai.com/v1/chat/completions',
    requiresKey: true,
    defaultHost: 'localhost',
    defaultPort: '1234',
  },
  google: {
    label: 'Google (Gemini)',
    defaultUrl: '',
    requiresKey: true,
    defaultHost: 'localhost',
    defaultPort: '1234',
  },
  anthropic: {
    label: 'Anthropic (Claude)',
    defaultUrl: 'https://api.anthropic.com/v1/messages',
    requiresKey: true,
    defaultHost: 'localhost',
    defaultPort: '1234',
  },
  github: {
    label: 'GitHub Copilot',
    defaultUrl: 'https://api.github.com/copilot/internal/v1/chat/completions',
    requiresKey: true,
    defaultHost: 'localhost',
    defaultPort: '1234',
  },
  'openai-compatible': {
    label: 'OpenAI Compatible',
    defaultUrl: 'http://localhost:1234/v1/chat/completions',
    requiresKey: false,
    defaultHost: 'localhost',
    defaultPort: '1234',
  },
  'lm-studio': {
    label: 'LM Studio (Local)',
    defaultUrl: '',
    requiresKey: false,
    defaultHost: 'localhost',
    defaultPort: '1234',
  },
  ollama: {
    label: 'Ollama (Local)',
    defaultUrl: '',
    requiresKey: false,
    defaultHost: 'localhost',
    defaultPort: '11434',
  },
};

const isLocalProvider = (provider: AiProvider) => provider === 'lm-studio' || provider === 'ollama';

type ParagraphProps = ComponentPropsWithoutRef<'p'>;
type ListProps = ComponentPropsWithoutRef<'ul'>;
type OrderedListProps = ComponentPropsWithoutRef<'ol'>;
type ListItemProps = ComponentPropsWithoutRef<'li'>;
type AnchorProps = ComponentPropsWithoutRef<'a'>;
type BlockquoteProps = ComponentPropsWithoutRef<'blockquote'>;
type TableProps = ComponentPropsWithoutRef<'table'>;
type TableCellProps = ComponentPropsWithoutRef<'th'>;
type TableDataCellProps = ComponentPropsWithoutRef<'td'>;
type CodeProps = ComponentPropsWithoutRef<'code'>;

interface ChatDialogProps {
  open: boolean;
  onClose: () => void;
}

const ChatDialog: React.FC<ChatDialogProps> = ({ open, onClose }) => {
  const { settings, setSettings, isConfigured, messages, setMessages, clearMessages } = useAiStore();
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);

  // Settings editing state
  const [editApiKey, setEditApiKey] = useState(settings.apiKey);
  const [editModel, setEditModel] = useState(settings.model);
  const [editApiUrl, setEditApiUrl] = useState(settings.apiUrl);
  const [editApiProvider, setEditApiProvider] = useState<AiProvider>(settings.apiProvider);
  const [editLmStudioHost, setEditLmStudioHost] = useState(settings.lmStudioHost);
  const [editLmStudioPort, setEditLmStudioPort] = useState(settings.lmStudioPort);
  const [editOllamaHost, setEditOllamaHost] = useState(settings.ollamaHost);
  const [editOllamaPort, setEditOllamaPort] = useState(settings.ollamaPort);

  // Available models from local server
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);

  // Fetch available models from local server
  const fetchAvailableModels = async () => {
    if (!isLocalProvider(editApiProvider)) {
      setAvailableModels([]);
      return;
    }
    setModelsLoading(true);
    setModelsError(null);
    try {
      const result = await api.listModels(editApiUrl, editApiKey);
      setAvailableModels(result.models || []);
      if (result.error) setModelsError(result.error);
    } catch (err: unknown) {
      setModelsError(err instanceof Error ? err.message : 'Failed to fetch models');
      setAvailableModels([]);
    } finally {
      setModelsLoading(false);
    }
  };

  // Fetch models when local provider settings change
  useEffect(() => {
    if (isLocalProvider(editApiProvider)) {
      fetchAvailableModels();
    } else {
      setAvailableModels([]);
    }
  }, [editApiProvider, editApiUrl]);

  // Sync when settings change
  useEffect(() => {
    if (open) {
      setEditApiKey(settings.apiKey);
      setEditModel(settings.model);
      setEditApiUrl(settings.apiUrl);
      setEditApiProvider(settings.apiProvider);
      setEditLmStudioHost(settings.lmStudioHost);
      setEditLmStudioPort(settings.lmStudioPort);
      setEditOllamaHost(settings.ollamaHost);
      setEditOllamaPort(settings.ollamaPort);
      setError(null);
    }
  }, [open, settings]);

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLDivElement>(null);

  const handleNewChat = () => {
    clearMessages();
    setError(null);
    setInput('');
    if (inputRef.current) {
      inputRef.current.textContent = '';
    }
  };

  const handleSend = async () => {
    if (!input.trim() || loading) return;

    const previousMessages = messages;
    const userMsg: ChatMessage = { role: 'user', content: input.trim() };
    const newMessages = [...previousMessages, userMsg];
    setMessages(newMessages);
    setInput('');
    if (inputRef.current) {
      inputRef.current.textContent = '';
    }
    setLoading(true);
    setError(null);

    try {
      const response = await api.aiChat({
        apiKey: editApiKey,
        model: editModel,
        apiUrl: editApiUrl,
        apiProvider: editApiProvider,
        messages: newMessages.map((m) => ({ role: m.role, content: m.content })),
      });

      if (response.error) {
        throw new Error(response.error);
      }

      const assistantMsg: ChatMessage = {
        role: 'assistant',
        content: response.content || 'No response.',
      };
      setMessages([...newMessages, assistantMsg]);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to get response.';
      setError(message);
      // Remove the user message that failed so it doesn't pollute history
      setMessages(previousMessages);
    } finally {
      setLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleSaveSettings = () => {
    setSettings({
      apiKey: editApiKey,
      model: editModel,
      apiUrl: editApiUrl,
      apiProvider: editApiProvider,
      lmStudioHost: editLmStudioHost,
      lmStudioPort: editLmStudioPort,
      ollamaHost: editOllamaHost,
      ollamaPort: editOllamaPort,
    });
    setShowSettings(false);
  };

  // Compute whether the save button should be enabled
  const isSaveEnabled = (() => {
    if (isLocalProvider(editApiProvider)) {
      return true;
    }
    return !!editApiKey.trim();
  })();

  // Update URL when provider changes
  const handleProviderChange = (provider: AiProvider) => {
    setEditApiProvider(provider);
    const defaults = PROVIDER_DEFAULTS[provider];
    if (isLocalProvider(provider)) {
      // Build URL from host/port
      const url = `http://${defaults.defaultHost}:${defaults.defaultPort}/v1/chat/completions`;
      setEditApiUrl(url);
    } else {
      setEditApiUrl(defaults.defaultUrl);
    }
  };

  // Update URL when host/port changes for local providers
  const updateLocalUrl = () => {
    if (isLocalProvider(editApiProvider)) {
      const host = editApiProvider === 'lm-studio' ? editLmStudioHost : editOllamaHost;
      const port = editApiProvider === 'lm-studio' ? editLmStudioPort : editOllamaPort;
      setEditApiUrl(`http://${host}:${port}/v1/chat/completions`);
    }
  };

  // Unconfigured state — show settings panel in the center
  if (!isConfigured()) {
    const providerInfo = PROVIDER_DEFAULTS[editApiProvider];
    const showLocalFields = isLocalProvider(editApiProvider);

    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
        <div
          className="bg-[var(--color-bg-secondary)] rounded-xl border border-[var(--color-bg-tertiary)] shadow-2xl w-[520px] overflow-hidden"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center justify-between p-4 border-b border-[var(--color-bg-tertiary)]">
            <h2 className="text-sm font-semibold">AI Chat</h2>
            <button onClick={onClose} className="text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]">
              ✕
            </button>
          </div>

          <div className="p-6">
            {/* Greyed-out placeholder */}
            <div
              className="flex items-center justify-center py-12 opacity-30 pointer-events-none mb-4"
            >
              <div className="text-center">
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" className="mx-auto mb-3 text-[var(--color-text-secondary)]">
                  <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2v10z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
                <p className="text-sm text-[var(--color-text-secondary)]">Configure your AI settings below to enable chat</p>
              </div>
            </div>

            {/* Settings form */}
            <div className="space-y-4">
              {/* API Provider selector */}
              <div>
                <label className="block text-[10px] font-semibold text-[var(--color-text-secondary)] uppercase tracking-wider mb-1.5">
                  AI Provider
                </label>
                <select
                  className="w-full px-3 py-2 rounded-lg text-xs font-mono bg-[var(--color-bg-primary)] border border-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none transition-colors"
                  value={editApiProvider}
                  onChange={(e) => handleProviderChange(e.target.value as AiProvider)}
                >
                  {PROVIDER_OPTIONS.map((p) => (
                    <option key={p.value} value={p.value}>{p.label}</option>
                  ))}
                </select>
              </div>

              {/* Model name (text input) */}
              <div>
                <label className="block text-[10px] font-semibold text-[var(--color-text-secondary)] uppercase tracking-wider mb-1.5">
                  Model
                </label>
                <input
                  type="text"
                  className="w-full px-3 py-2 rounded-lg text-xs font-mono bg-[var(--color-bg-primary)] border border-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none transition-colors"
                  value={editModel}
                  onChange={(e) => setEditModel(e.target.value)}
                  placeholder="e.g. gpt-4o, llama3.1, phi3"
                />
              </div>

              {/* API URL */}
              <div>
                <label className="block text-[10px] font-semibold text-[var(--color-text-secondary)] uppercase tracking-wider mb-1.5">
                  API URL
                </label>
                <input
                  type="text"
                  className="w-full px-3 py-2 rounded-lg text-xs font-mono bg-[var(--color-bg-primary)] border border-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none transition-colors"
                  value={editApiUrl}
                  onChange={(e) => setEditApiUrl(e.target.value)}
                  placeholder="https://api.openai.com/v1/chat/completions"
                />
              </div>

              {/* Local server host/port fields */}
              {showLocalFields && (
                <div className="flex gap-3">
                  <div className="flex-1">
                    <label className="block text-[10px] font-semibold text-[var(--color-text-secondary)] uppercase tracking-wider mb-1.5">
                      Host
                    </label>
                    <input
                      type="text"
                      className="w-full px-3 py-2 rounded-lg text-xs font-mono bg-[var(--color-bg-primary)] border border-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none transition-colors"
                      value={editApiProvider === 'lm-studio' ? editLmStudioHost : editOllamaHost}
                      onChange={(e) => {
                        const newHost = e.target.value;
                        const port = editApiProvider === 'lm-studio' ? editLmStudioPort : editOllamaPort;
                        if (editApiProvider === 'lm-studio') setEditLmStudioHost(newHost);
                        else setEditOllamaHost(newHost);
                        setEditApiUrl(`http://${newHost}:${port}/v1/chat/completions`);
                      }}
                      placeholder="localhost"
                    />
                  </div>
                  <div className="w-20">
                    <label className="block text-[10px] font-semibold text-[var(--color-text-secondary)] uppercase tracking-wider mb-1.5">
                      Port
                    </label>
                    <input
                      type="text"
                      className="w-full px-3 py-2 rounded-lg text-xs font-mono bg-[var(--color-bg-primary)] border border-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none transition-colors"
                      value={editApiProvider === 'lm-studio' ? editLmStudioPort : editOllamaPort}
                      onChange={(e) => {
                        const newPort = e.target.value;
                        const host = editApiProvider === 'lm-studio' ? editLmStudioHost : editOllamaHost;
                        if (editApiProvider === 'lm-studio') setEditLmStudioPort(newPort);
                        else setEditOllamaPort(newPort);
                        setEditApiUrl(`http://${host}:${newPort}/v1/chat/completions`);
                      }}
                      placeholder="1234"
                    />
                  </div>
                </div>
              )}

              {/* API Key (always shown) */}
              <div>
                <label className="block text-[10px] font-semibold text-[var(--color-text-secondary)] uppercase tracking-wider mb-1.5">
                  API Key
                </label>
                <input
                  type="password"
                  className="w-full px-3 py-2 rounded-lg text-xs font-mono bg-[var(--color-bg-primary)] border border-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none transition-colors"
                  value={editApiKey}
                  onChange={(e) => setEditApiKey(e.target.value)}
                  placeholder={showLocalFields ? "Leave blank if no auth required" : "sk-..."}
                />
                <p className="text-[10px] text-[var(--color-text-secondary)] mt-1">
                  Your API key is stored only in your browser
                </p>
              </div>
            </div>
          </div>

          <div className="flex justify-end gap-2 p-4 border-t border-[var(--color-bg-tertiary)]">
            <button
              onClick={onClose}
              className="px-4 py-2 rounded-lg text-xs font-medium bg-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] hover:bg-[var(--color-bg-primary)] transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleSaveSettings}
              disabled={!isSaveEnabled}
              className="px-4 py-2 rounded-lg text-xs font-medium bg-[var(--color-accent)] text-white hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Save & Enable Chat
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Configured state — full chat interface
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="bg-[var(--color-bg-secondary)] rounded-xl border border-[var(--color-bg-tertiary)] shadow-2xl w-[560px] overflow-hidden flex flex-col"
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
            {/* Model name (text input) */}
            <input
              type="text"
              className="w-36 px-2 py-1 rounded text-[10px] font-mono bg-[var(--color-bg-primary)] border border-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none transition-colors"
              value={editModel}
              onChange={(e) => setEditModel(e.target.value)}
              placeholder="Model name"
            />
            {/* Settings toggle */}
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

        {/* Inline settings panel (toggleable) */}
        {showSettings && (
          <div className="px-4 pb-4 border-b border-[var(--color-bg-tertiary)] bg-[var(--color-bg-primary)]">
            <div className="space-y-3 pt-3">
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-semibold text-[var(--color-text-secondary)] uppercase tracking-wider">AI Settings</span>
                <button
                  onClick={handleSaveSettings}
                  disabled={!isSaveEnabled}
                  className="text-[10px] px-2 py-1 rounded bg-[var(--color-accent)] text-white hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Save
                </button>
              </div>
              <div className="space-y-2">
                {/* Provider selector */}
                <div>
                  <label className="block text-[10px] text-[var(--color-text-secondary)] mb-1">Provider</label>
                  <select
                    className="w-full px-3 py-1.5 rounded text-xs font-mono bg-[var(--color-bg-secondary)] border border-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none transition-colors"
                    value={editApiProvider}
                    onChange={(e) => handleProviderChange(e.target.value as AiProvider)}
                  >
                    {PROVIDER_OPTIONS.map((p) => (
                      <option key={p.value} value={p.value}>{p.label}</option>
                    ))}
                  </select>
                </div>
                {/* Model selector - dropdown for local providers, text input for remote */}
                {isLocalProvider(editApiProvider) && availableModels.length > 0 && (
                  <div>
                    <label className="block text-[10px] text-[var(--color-text-secondary)] mb-1">Model</label>
                    <select
                      className="w-full px-3 py-1.5 rounded text-xs font-mono bg-[var(--color-bg-secondary)] border border-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none transition-colors"
                      value={editModel}
                      onChange={(e) => setEditModel(e.target.value)}
                    >
                      {availableModels.map((m) => (
                        <option key={m} value={m}>{m}</option>
                      ))}
                    </select>
                    <button
                      onClick={fetchAvailableModels}
                      className="mt-1 text-[10px] text-[var(--color-accent)] hover:underline"
                    >
                      Refresh models
                    </button>
                  </div>
                )}
                {isLocalProvider(editApiProvider) && modelsLoading && (
                  <p className="text-[10px] text-[var(--color-text-secondary)]">Loading models...</p>
                )}
                {modelsError && (
                  <p className="text-[10px] text-[var(--color-error)]">Error: {modelsError}</p>
                )}
                {/* API URL */}
                <div>
                  <label className="block text-[10px] text-[var(--color-text-secondary)] mb-1">API URL</label>
                  <input
                    type="text"
                    className="w-full px-3 py-1.5 rounded text-xs font-mono bg-[var(--color-bg-secondary)] border border-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none transition-colors"
                    value={editApiUrl}
                    onChange={(e) => setEditApiUrl(e.target.value)}
                  />
                </div>
                {/* Local server host/port */}
                {isLocalProvider(editApiProvider) && (
                  <div className="flex gap-2">
                    <div className="flex-1">
                      <label className="block text-[10px] text-[var(--color-text-secondary)] mb-1">Host</label>
                      <input
                        type="text"
                        className="w-full px-3 py-1.5 rounded text-xs font-mono bg-[var(--color-bg-secondary)] border border-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none transition-colors"
                        value={editApiProvider === 'lm-studio' ? editLmStudioHost : editOllamaHost}
                        onChange={(e) => {
                          const newHost = e.target.value;
                          const port = editApiProvider === 'lm-studio' ? editLmStudioPort : editOllamaPort;
                          if (editApiProvider === 'lm-studio') setEditLmStudioHost(newHost);
                          else setEditOllamaHost(newHost);
                          setEditApiUrl(`http://${newHost}:${port}/v1/chat/completions`);
                        }}
                        placeholder="localhost"
                      />
                    </div>
                    <div className="w-20">
                      <label className="block text-[10px] text-[var(--color-text-secondary)] mb-1">Port</label>
                      <input
                        type="text"
                        className="w-full px-3 py-1.5 rounded text-xs font-mono bg-[var(--color-bg-secondary)] border border-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none transition-colors"
                        value={editApiProvider === 'lm-studio' ? editLmStudioPort : editOllamaPort}
                        onChange={(e) => {
                          const newPort = e.target.value;
                          const host = editApiProvider === 'lm-studio' ? editLmStudioHost : editOllamaHost;
                          if (editApiProvider === 'lm-studio') setEditLmStudioPort(newPort);
                          else setEditOllamaPort(newPort);
                          setEditApiUrl(`http://${host}:${newPort}/v1/chat/completions`);
                        }}
                        placeholder="1234"
                      />
                    </div>
                  </div>
                )}
                {/* API Key (always shown) */}
                <div>
                  <label className="block text-[10px] text-[var(--color-text-secondary)] mb-1">API Key</label>
                  <input
                    type="password"
                    className="w-full px-3 py-1.5 rounded text-xs font-mono bg-[var(--color-bg-secondary)] border border-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none transition-colors"
                    value={editApiKey}
                    onChange={(e) => setEditApiKey(e.target.value)}
                    placeholder={isLocalProvider(editApiProvider) ? "Leave blank if no auth required" : "sk-..."}
                  />
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Messages area */}
        <div className="flex-1 overflow-y-auto p-4" style={{ minHeight: 350, maxHeight: 450 }}>
          {messages.length === 0 && (
            <div className="flex items-center justify-center h-full text-[var(--color-text-secondary)]">
              <div className="text-center">
                <p className="text-xs">Ask a question about your Klipper configuration!</p>
              </div>
            </div>
          )}
          {messages.map((msg, i) => (
            <div
              key={i}
              className={`mb-2 ${msg.role === 'user' ? 'text-right' : 'text-left'}`}
            >
              <div
                className={`inline-block max-w-[80%] px-3 py-2 rounded-lg text-xs leading-6 ${
                  msg.role === 'user'
                    ? 'bg-[var(--color-accent)] text-white'
                    : 'bg-[var(--color-bg-primary)] text-[var(--color-text-primary)] border border-[var(--color-bg-tertiary)]'
                }`}
                style={{ wordBreak: 'break-word' }}
              >
                {msg.role === 'assistant' ? (
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    components={{
                      p: ({ children }: ParagraphProps) => <p className="mb-2 last:mb-0">{children}</p>,
                      ul: ({ children }: ListProps) => <ul className="mb-2 list-disc pl-5 last:mb-0">{children}</ul>,
                      ol: ({ children }: OrderedListProps) => <ol className="mb-2 list-decimal pl-5 last:mb-0">{children}</ol>,
                      li: ({ children }: ListItemProps) => <li className="mb-1 last:mb-0">{children}</li>,
                      a: ({ children, href }: AnchorProps) => (
                        <a className="text-[var(--color-accent)] underline" href={href} target="_blank" rel="noreferrer">
                          {children}
                        </a>
                      ),
                      blockquote: ({ children }: BlockquoteProps) => (
                        <blockquote className="my-2 border-l-2 border-[var(--color-bg-tertiary)] pl-3 text-[var(--color-text-secondary)]">
                          {children}
                        </blockquote>
                      ),
                      table: ({ children }: TableProps) => (
                        <div className="my-2 overflow-x-auto">
                          <table className="min-w-full border-collapse text-left text-[11px]">{children}</table>
                        </div>
                      ),
                      th: ({ children }: TableCellProps) => (
                        <th className="border border-[var(--color-bg-tertiary)] px-2 py-1 font-semibold">{children}</th>
                      ),
                      td: ({ children }: TableDataCellProps) => (
                        <td className="border border-[var(--color-bg-tertiary)] px-2 py-1 align-top">{children}</td>
                      ),
                      code: ({ children, className }: CodeProps) => {
                        const content = String(children).replace(/\n$/, '');
                        const isBlock = Boolean(className) || content.includes('\n');
                        if (!isBlock) {
                          return (
                            <code className="rounded bg-[var(--color-bg-secondary)] px-1 py-0.5 font-mono text-[11px]">
                              {content}
                            </code>
                          );
                        }
                        return (
                          <pre className="my-2 overflow-x-auto rounded-md bg-[var(--color-bg-secondary)] p-3">
                            <code className="font-mono text-[11px]">{content}</code>
                          </pre>
                        );
                      },
                    }}
                  >
                    {msg.content}
                  </ReactMarkdown>
                ) : (
                  <div style={{ whiteSpace: 'pre-wrap' }}>{msg.content}</div>
                )}
              </div>
            </div>
          ))}
          {loading && (
            <div className="text-left mb-2">
              <div className="inline-block px-3 py-2 rounded-lg text-xs bg-[var(--color-bg-primary)] border border-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)]">
                <span className="inline-flex gap-0.5">
                  <span className="animate-bounce">●</span>
                  <span className="animate-bounce" style={{ animationDelay: '0.15s' }}>●</span>
                  <span className="animate-bounce" style={{ animationDelay: '0.3s' }}>●</span>
                </span>
              </div>
            </div>
          )}
          {error && (
            <div className="text-left mb-2 text-[var(--color-error)]">
              <span className="text-[10px]">{error}</span>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* Input bar */}
        <div className="flex items-center gap-2 p-4 border-t border-[var(--color-bg-tertiary)]">
          <div
            ref={inputRef as React.RefObject<HTMLDivElement>}
            className={`flex-1 px-3 py-2 rounded-lg text-xs bg-[var(--color-bg-primary)] border text-[var(--color-text-primary)] focus:outline-none transition-colors resize-none ${
              loading
                ? 'border-[var(--color-bg-tertiary)] opacity-50 cursor-not-allowed'
                : 'border-[var(--color-bg-tertiary)] focus:border-[var(--color-accent)]'
            }`}
            contentEditable
            suppressContentEditableWarning
            onKeyDown={handleKeyDown}
            onInput={(e) => {
              const target = e.target as HTMLDivElement;
              setInput(target.textContent || '');
            }}
            data-placeholder="Type your message..."
            style={{ minHeight: 36, maxHeight: 120, overflow: 'auto' }}
          />
          <button
            onClick={handleSend}
            disabled={loading || !input.trim()}
            className="px-4 py-2 rounded-lg text-xs font-medium bg-[var(--color-accent)] text-white hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {loading ? '...' : 'Send'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default ChatDialog;
