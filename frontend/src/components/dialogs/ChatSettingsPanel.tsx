/**
 * AI Chat Settings Panel
 *
 * Used in two contexts:
 * 1. Unconfigured state (standalone=true — full-page centered, before chat is enabled)
 * 2. Inline settings toggle (standalone=false — inside the configured chat interface)
 *
 * Props mirror the editing state from ChatDialog so there's a single source of truth.
 */
import React, { useState, useEffect, useRef, type Dispatch, type SetStateAction } from 'react';
import { useAiStore, AiProvider, providerRequiresApiKey } from '../../stores/aiStore';
import * as api from '../../services/api';
import {
  PROVIDER_OPTIONS,
  PROVIDER_DEFAULTS,
  isLocalProvider,
} from '../../utils/chatProviders';

export interface ChatSettingsPanelProps {
  standalone: boolean;
  editApiKey: string;
  setEditApiKey: (v: string) => void;
  editModel: string;
  setEditModel: Dispatch<SetStateAction<string>>;
  editApiUrl: string;
  setEditApiUrl: (v: string) => void;
  editApiProvider: AiProvider;
  setEditApiProvider: (v: AiProvider) => void;
  editMaxTokens: string;
  setEditMaxTokens: (v: string) => void;
  editTemperature: string;
  setEditTemperature: (v: string) => void;
  resolvedEditApiUrl: string;
  onSaveSettings: () => void;
  onClose?: () => void;
}

// How long to wait after the user stops typing before auto-refreshing the
// model list. 1s keeps keystroke bursts (host/port/api key) from firing a
// request per character.
const MODELS_DEBOUNCE_MS = 1000;

const ChatSettingsPanel: React.FC<ChatSettingsPanelProps> = ({
  standalone,
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
  resolvedEditApiUrl,
  onSaveSettings,
  onClose,
}) => {
  const { settings } = useAiStore();

  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const modelsFetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchAvailableModels = async (
    provider: AiProvider = editApiProvider,
    apiUrl: string = resolvedEditApiUrl,
    apiKey: string = editApiKey,
  ) => {
    setModelsLoading(true);
    setModelsError(null);
    // Model discovery is proxied through the backend (/ai/models) so it works
    // for every provider — cloud APIs (OpenAI, Gemini, Claude, GitHub Models)
    // would CORS-fail from the browser, and the key must not ride in a query
    // string. The model field stays a plain text input until a list arrives.
    const { models, error } = await api.listModels(provider, apiUrl, apiKey);
    setAvailableModels(models);
    if (error) {
      setModelsError(error);
    } else if (models.length === 0) {
      setModelsError('No models found at this endpoint. Make sure a model is loaded.');
    } else {
      // The server is the source of truth for models. If the current
      // selection is not actually served (e.g. a stale saved name, or a
      // cloud placeholder like 'gpt-4o' left over from another provider),
      // select the first available model so the dropdown shows exactly what
      // will be saved — otherwise the user sees one model but Save persists
      // the stale one, and chat requests fail with a model-not-found error.
      setEditModel((prev) => {
        const current = prev.trim();
        if (!current || !models.includes(current)) {
          return models[0];
        }
        return prev;
      });
    }
    setModelsLoading(false);
  };

  useEffect(() => {
    // Auto-refresh the model list, debounced so it fires once the user stops
    // typing (host, port, api key) rather than on every keystroke.
    if (modelsFetchTimerRef.current) clearTimeout(modelsFetchTimerRef.current);
    const trimmedKey = editApiKey.trim();
    if (
      (providerRequiresApiKey(editApiProvider) && !trimmedKey)
      || !resolvedEditApiUrl.trim()
    ) {
      // No point hitting the endpoint without the key it needs (cloud
      // providers 401), or with no URL at all.
      setAvailableModels([]);
      setModelsError(null);
      return;
    }
    modelsFetchTimerRef.current = setTimeout(() => {
      void fetchAvailableModels(editApiProvider, resolvedEditApiUrl, trimmedKey);
    }, MODELS_DEBOUNCE_MS);
    return () => {
      if (modelsFetchTimerRef.current) clearTimeout(modelsFetchTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editApiProvider, resolvedEditApiUrl, editApiKey]);

  const handleModelChange = (nextModel: string) => {
    setEditModel(nextModel);
  };

  const handleProviderChange = (provider: AiProvider) => {
    setEditApiProvider(provider);
    const providerDefaultModel = PROVIDER_DEFAULTS[provider]?.defaultModel;
    const modelToUse = editModel.trim() || providerDefaultModel || settings.model;
    setEditModel(modelToUse);
    setEditApiUrl(PROVIDER_DEFAULTS[provider].defaultUrl);
  };

  const isSaveEnabled = !providerRequiresApiKey(editApiProvider) || !!editApiKey.trim();
  const hasSelectedModel = !!editModel.trim();

  // ── Shared Input Fields ────────────────────────────────────────────

  const providerSelector = (
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
  );

  const modelField = (
    <div>
      <label className="block text-[10px] font-semibold text-[var(--color-text-secondary)] uppercase tracking-wider mb-1.5">
        Model
      </label>
      <div className="flex gap-2">
        {availableModels.length > 0 ? (
          <select
            className="flex-1 px-3 py-2 rounded-lg text-xs font-mono bg-[var(--color-bg-primary)] border border-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none transition-colors"
            value={editModel}
            onChange={(e) => handleModelChange(e.target.value)}
          >
            {availableModels.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
        ) : (
          <input
            type="text"
            className="flex-1 px-3 py-2 rounded-lg text-xs font-mono bg-[var(--color-bg-primary)] border border-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none transition-colors"
            value={editModel}
            onChange={(e) => handleModelChange(e.target.value)}
            placeholder="e.g. gpt-4o, gemini-2.5-pro, llama3.1"
          />
        )}
        <button
          type="button"
          onClick={() => void fetchAvailableModels(editApiProvider, resolvedEditApiUrl, editApiKey)}
          disabled={modelsLoading}
          className="px-3 py-2 rounded-lg text-xs font-medium bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-primary)] hover:text-[var(--color-text-primary)] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          title="Refresh available models from the server"
        >
          {modelsLoading ? 'Loading...' : 'Refresh models'}
        </button>
      </div>
      {modelsLoading && (
        <p className="text-[10px] text-[var(--color-text-secondary)] mt-1">Loading models...</p>
      )}
      {modelsError && (
        <p className="text-[10px] text-[var(--color-error)] mt-1">Error: {modelsError}</p>
      )}
    </div>
  );

  const apiUrlField = (
    <div>
      <label className="block text-[10px] font-semibold text-[var(--color-text-secondary)] uppercase tracking-wider mb-1.5">
        API URL
      </label>
      <input
        type="text"
        className="w-full px-3 py-2 rounded-lg text-xs font-mono bg-[var(--color-bg-primary)] border border-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none transition-colors"
        value={editApiUrl}
        onChange={(e) => setEditApiUrl(e.target.value)}
        placeholder="e.g. http://localhost:11434/v1/chat/completions or https://api.deepseek.com/v1/chat/completions"
      />
    </div>
  );

  const apiKeyField = (
    <div>
      <label className="block text-[10px] font-semibold text-[var(--color-text-secondary)] uppercase tracking-wider mb-1.5">
        API Key {!providerRequiresApiKey(editApiProvider) && <span className="font-normal lowercase">(optional)</span>}
      </label>
      <input
        type="password"
        className="w-full px-3 py-2 rounded-lg text-xs font-mono bg-[var(--color-bg-primary)] border border-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none transition-colors"
        value={editApiKey}
        onChange={(e) => setEditApiKey(e.target.value)}
        placeholder="sk-..."
      />
      <p className="text-[10px] text-[var(--color-text-secondary)] mt-1">
        {providerRequiresApiKey(editApiProvider)
          ? 'Your API key is stored only in your browser'
          : isLocalProvider(editApiProvider)
            ? 'Optional for local servers — required for cloud APIs (DeepSeek, OpenRouter, ...)'
            : 'Optional — only needed if your local server requires authentication'}
      </p>
    </div>
  );

  const maxTokensField = (
    <div>
      <label className="block text-[10px] font-semibold text-[var(--color-text-secondary)] uppercase tracking-wider mb-1.5">
        Max Tokens
      </label>
      <input
        type="number"
        min={256}
        step={256}
        className="w-full px-3 py-2 rounded-lg text-xs font-mono bg-[var(--color-bg-primary)] border border-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none transition-colors"
        value={editMaxTokens}
        onChange={(e) => setEditMaxTokens(e.target.value)}
        placeholder="4096"
      />
      <p className="text-[10px] text-[var(--color-text-secondary)] mt-1">
        Limits the length of AI responses (default 4096). Lower values speed up replies.
      </p>
    </div>
  );

  const temperatureField = (
    <div>
      <label className="block text-[10px] font-semibold text-[var(--color-text-secondary)] uppercase tracking-wider mb-1.5">
        Temperature
      </label>
      <input
        type="number"
        min={0}
        max={2}
        step={0.1}
        className="w-full px-3 py-2 rounded-lg text-xs font-mono bg-[var(--color-bg-primary)] border border-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none transition-colors"
        value={editTemperature}
        onChange={(e) => setEditTemperature(e.target.value)}
        placeholder="0.7"
      />
      <p className="text-[10px] text-[var(--color-text-secondary)] mt-1">
        Controls response randomness (default 0.7). Higher values give more varied output.
      </p>
    </div>
  );

  const maxTokensAndTemperatureRow = (
    <div className="flex gap-3">
      <div className="flex-1">{maxTokensField}</div>
      <div className="flex-1">{temperatureField}</div>
    </div>
  );

  // ── Render ─────────────────────────────────────────────────────────

  const formContent = (
    <div className="space-y-4">
      {providerSelector}
      {modelField}
      {apiUrlField}
      {apiKeyField}
      {maxTokensAndTemperatureRow}
    </div>
  );

  if (standalone) {
    return (
      <>
        <div className="flex items-center justify-center py-12 opacity-30 pointer-events-none mb-4">
          <div className="text-center">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" className="mx-auto mb-3 text-[var(--color-text-secondary)]">
              <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2v10z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            <p className="text-sm text-[var(--color-text-secondary)]">Configure your AI settings below to enable chat</p>
          </div>
        </div>

        {formContent}

        <div className="flex justify-end gap-2 mt-6 pt-4 border-t border-[var(--color-bg-tertiary)]">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg text-xs font-medium bg-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] hover:bg-[var(--color-bg-primary)] transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={onSaveSettings}
            disabled={!isSaveEnabled}
            className="px-4 py-2 rounded-lg text-xs font-medium bg-[var(--color-accent)] text-white hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {hasSelectedModel ? 'Save & Enable Chat' : 'Save Settings'}
          </button>
        </div>
      </>
    );
  }

  return (
    <div className="px-4 pb-4 border-b border-[var(--color-bg-tertiary)] bg-[var(--color-bg-primary)]">
      <div className="space-y-3 pt-3">
        <div className="flex items-center justify-between">
          <span className="text-[10px] font-semibold text-[var(--color-text-secondary)] uppercase tracking-wider">AI Settings</span>
          <button
            onClick={onSaveSettings}
            disabled={!isSaveEnabled}
            className="text-[10px] px-2 py-1 rounded bg-[var(--color-accent)] text-white hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Save
          </button>
        </div>
        <div className="space-y-2">
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
          <div>
            <label className="block text-[10px] text-[var(--color-text-secondary)] mb-1">Model</label>
            {availableModels.length > 0 ? (
              <div className="flex gap-2">
                <select
                  className="flex-1 px-3 py-1.5 rounded text-xs font-mono bg-[var(--color-bg-secondary)] border border-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none transition-colors"
                  value={editModel}
                  onChange={(e) => handleModelChange(e.target.value)}
                >
                  {availableModels.map((m) => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => void fetchAvailableModels(editApiProvider, resolvedEditApiUrl, editApiKey)}
                  disabled={modelsLoading}
                  className="px-3 py-1.5 rounded text-xs font-medium bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-primary)] hover:text-[var(--color-text-primary)] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  title="Refresh available models from the server"
                >
                  {modelsLoading ? 'Loading...' : 'Refresh'}
                </button>
              </div>
            ) : (
              <input
                type="text"
                className="w-full px-3 py-1.5 rounded text-xs font-mono bg-[var(--color-bg-secondary)] border border-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none transition-colors"
                value={editModel}
                onChange={(e) => handleModelChange(e.target.value)}
                placeholder="e.g. gemini-2.5-pro, claude-sonnet-4, gpt-4o"
              />
            )}
          </div>
          {modelsLoading && (
            <p className="text-[10px] text-[var(--color-text-secondary)]">Loading models...</p>
          )}
          {modelsError && (
            <p className="text-[10px] text-[var(--color-error)]">Error: {modelsError}</p>
          )}
          {apiUrlField}
          <div>
            <label className="block text-[10px] text-[var(--color-text-secondary)] mb-1">
              API Key{!providerRequiresApiKey(editApiProvider) && ' (optional)'}
            </label>
            <input
              type="password"
              className="w-full px-3 py-1.5 rounded text-xs font-mono bg-[var(--color-bg-secondary)] border border-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none transition-colors"
              value={editApiKey}
              onChange={(e) => setEditApiKey(e.target.value)}
              placeholder="sk-..."
            />
          </div>
          <div className="flex gap-2">
            <div className="flex-1">
              <label className="block text-[10px] text-[var(--color-text-secondary)] mb-1">Max Tokens</label>
              <input
                type="number"
                min={256}
                step={256}
                className="w-full px-3 py-1.5 rounded text-xs font-mono bg-[var(--color-bg-secondary)] border border-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none transition-colors"
                value={editMaxTokens}
                onChange={(e) => setEditMaxTokens(e.target.value)}
                placeholder="4096"
              />
              <p className="text-[10px] text-[var(--color-text-secondary)] mt-1">Limits AI response length (default 4096).</p>
            </div>
            <div className="flex-1">
              <label className="block text-[10px] text-[var(--color-text-secondary)] mb-1">Temperature</label>
              <input
                type="number"
                min={0}
                max={2}
                step={0.1}
                className="w-full px-3 py-1.5 rounded text-xs font-mono bg-[var(--color-bg-secondary)] border border-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none transition-colors"
                value={editTemperature}
                onChange={(e) => setEditTemperature(e.target.value)}
                placeholder="0.7"
              />
              <p className="text-[10px] text-[var(--color-text-secondary)] mt-1">Response randomness (default 0.7).</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ChatSettingsPanel;
