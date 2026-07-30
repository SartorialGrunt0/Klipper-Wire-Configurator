/**
 * AI Chat Settings Panel
 *
 * Used in two contexts:
 * 1. Unconfigured state (standalone=true — full-page centered, before chat is enabled)
 * 2. Inline settings toggle (standalone=false — inside the configured chat interface)
 *
 * Props mirror the editing state from ChatDialog so there's a single source of truth.
 */
import React, { useState, useEffect, useRef } from 'react';
import { useAiStore, AiProvider, providerRequiresApiKey } from '../../stores/aiStore';
import * as api from '../../services/api';
import {
  PROVIDER_OPTIONS,
  PROVIDER_DEFAULTS,
  isLocalProvider,
  resolveProviderApiUrl,
} from '../../utils/chatUtils';

export interface ChatSettingsPanelProps {
  standalone: boolean;
  editApiKey: string;
  setEditApiKey: (v: string) => void;
  editModel: string;
  setEditModel: (v: string) => void;
  editApiUrl: string;
  setEditApiUrl: (v: string) => void;
  editApiProvider: AiProvider;
  setEditApiProvider: (v: AiProvider) => void;
  editHost: string;
  setEditHost: (v: string) => void;
  editPort: string;
  setEditPort: (v: string) => void;
  resolvedEditApiUrl: string;
  onSaveSettings: () => void;
  onClose?: () => void;
}

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
  editHost,
  setEditHost,
  editPort,
  setEditPort,
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
    if (!isLocalProvider(provider)) {
      setAvailableModels([]);
      return;
    }
    setModelsLoading(true);
    setModelsError(null);
    try {
      const result = await api.listLocalModels(apiUrl, apiKey);
      setAvailableModels(result);
      if (result.length === 0) {
        setModelsError('No models found at this endpoint. Make sure a model is loaded.');
      }
    } catch (err: unknown) {
      setModelsError(err instanceof Error ? err.message : 'Failed to fetch models');
      setAvailableModels([]);
    } finally {
      setModelsLoading(false);
    }
  };

  useEffect(() => {
    if (isLocalProvider(editApiProvider)) {
      void fetchAvailableModels(editApiProvider, resolvedEditApiUrl, editApiKey);
    } else {
      setAvailableModels([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editApiProvider, resolvedEditApiUrl, editApiKey]);

  const handleModelChange = (nextModel: string) => {
    setEditModel(nextModel);
    if (isLocalProvider(editApiProvider)) {
      void fetchAvailableModels(editApiProvider, resolvedEditApiUrl, editApiKey);
    }
  };

  const handleProviderChange = (provider: AiProvider) => {
    setEditApiProvider(provider);
    const providerDefaultModel = PROVIDER_DEFAULTS[provider]?.defaultModel;
    const modelToUse = editModel.trim() || providerDefaultModel || settings.model;
    setEditModel(modelToUse);
    if (isLocalProvider(provider)) {
      setEditApiUrl('');
    } else {
      setEditApiUrl(PROVIDER_DEFAULTS[provider].defaultUrl);
    }
  };

  const isSaveEnabled = !providerRequiresApiKey(editApiProvider) || !!editApiKey.trim();
  const hasSelectedModel = !!editModel.trim();
  const showLocalFields = isLocalProvider(editApiProvider);

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
        {showLocalFields && availableModels.length > 0 ? (
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
        {showLocalFields && (
          <button
            type="button"
            onClick={() => void fetchAvailableModels(editApiProvider, resolvedEditApiUrl, editApiKey)}
            disabled={modelsLoading}
            className="px-3 py-2 rounded-lg text-xs font-medium bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-primary)] hover:text-[var(--color-text-primary)] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            title="Refresh available models from the server"
          >
            {modelsLoading ? 'Loading...' : 'Refresh models'}
          </button>
        )}
      </div>
      {showLocalFields && modelsLoading && (
        <p className="text-[10px] text-[var(--color-text-secondary)] mt-1">Loading models...</p>
      )}
      {modelsError && (
        <p className="text-[10px] text-[var(--color-error)] mt-1">Error: {modelsError}</p>
      )}
    </div>
  );

  const apiUrlField = !showLocalFields ? (
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
  ) : null;

  const hostPortFields = showLocalFields ? (
    <>
      <div className="flex gap-3">
        <div className="flex-1">
          <label className="block text-[10px] font-semibold text-[var(--color-text-secondary)] uppercase tracking-wider mb-1.5">Host</label>
          <input
            type="text"
            className="w-full px-3 py-2 rounded-lg text-xs font-mono bg-[var(--color-bg-primary)] border border-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none transition-colors"
            value={editHost}
            onChange={(e) => {
              setEditHost(e.target.value);
              setModelsError(null);
              if (modelsFetchTimerRef.current) clearTimeout(modelsFetchTimerRef.current);
              modelsFetchTimerRef.current = setTimeout(() => {
                void fetchAvailableModels(editApiProvider, resolvedEditApiUrl, editApiKey);
              }, 500);
            }}
            placeholder="localhost"
          />
        </div>
        <div className="w-20">
          <label className="block text-[10px] font-semibold text-[var(--color-text-secondary)] uppercase tracking-wider mb-1.5">Port</label>
          <input
            type="text"
            className="w-full px-3 py-2 rounded-lg text-xs font-mono bg-[var(--color-bg-primary)] border border-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none transition-colors"
            value={editPort}
            onChange={(e) => {
              setEditPort(e.target.value);
              setModelsError(null);
              if (modelsFetchTimerRef.current) clearTimeout(modelsFetchTimerRef.current);
              modelsFetchTimerRef.current = setTimeout(() => {
                void fetchAvailableModels(editApiProvider, resolvedEditApiUrl, editApiKey);
              }, 500);
            }}
            placeholder="1234"
          />
        </div>
      </div>
      <p className="text-[10px] text-[var(--color-text-secondary)]">
        Chat requests use {resolvedEditApiUrl} and model discovery uses the same host and port.
      </p>
    </>
  ) : null;

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
          : 'Optional — only needed if your local server requires authentication'}
      </p>
    </div>
  );

  // ── Render ─────────────────────────────────────────────────────────

  const formContent = (
    <div className="space-y-4">
      {providerSelector}
      {modelField}
      {apiUrlField}
      {hostPortFields}
      {apiKeyField}
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
            {showLocalFields && availableModels.length > 0 ? (
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
          {showLocalFields && modelsLoading && (
            <p className="text-[10px] text-[var(--color-text-secondary)]">Loading models...</p>
          )}
          {modelsError && (
            <p className="text-[10px] text-[var(--color-error)]">Error: {modelsError}</p>
          )}
          {apiUrlField}
          {hostPortFields}
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
        </div>
      </div>
    </div>
  );
};

export default ChatSettingsPanel;
