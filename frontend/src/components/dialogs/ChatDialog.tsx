import React, { useState, useRef, useEffect, type ComponentPropsWithoutRef } from 'react';
import KeyboardArrowDownRounded from '@mui/icons-material/KeyboardArrowDownRounded';
import UploadFileRounded from '@mui/icons-material/UploadFileRounded';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useAiStore, AiProvider, ChatMessage } from '../../stores/aiStore';
import { useConfigStore } from '../../stores/configStore';
import { useGraphStore } from '../../stores/graphStore';
import * as api from '../../services/api';
import AiDraftPreviewDialog from './AiDraftPreviewDialog';
import { mergeAssistantSectionsIntoConfig, type AssistantDraftChange } from '../../utils/assistantDraftMerge';
import { normalizeDiffText } from '../../utils/configDiff';
import { buildProjectGraph } from '../../utils/graphBuilder';
import type { LmStudioMcpStatus } from '../../types/ai';
import type { ConfigFile, ConfigSection } from '../../types/config';

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
    defaultUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
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
    defaultUrl: 'https://models.github.ai/inference/chat/completions',
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

interface AttachedConfigFile {
  id: string;
  name: string;
  content: string;
}

const CONTEXT_TRUNCATION_LIMIT = 40000;
const CONFIG_CODE_LANGUAGES = new Set(['', 'cfg', 'conf', 'ini', 'klipper', 'printercfg']);
const ASSISTANT_FILE_HINT_RE = /^[#;]\s*file\s*:\s*(.+?)\s*$/i;
const KLIPPER_DOC_FILENAME_RE = /(^|[^A-Za-z0-9_-])([A-Za-z0-9][A-Za-z0-9_-]*\.md)(?=$|[^A-Za-z0-9_.-])/g;
const KLIPPER_DOC_REQUEST_RE = /\b(?:can you|could you|would you|please|provide|send|share|paste|show me|include|load|fetch|pull|give me|i need|i would need|i'd need)\b/i;
const MAX_AUTO_FETCHED_KLIPPER_DOCS = 2;

function truncateConfigContext(content: string): string {
  if (content.length <= CONTEXT_TRUNCATION_LIMIT) {
    return content;
  }

  return `${content.slice(0, CONTEXT_TRUNCATION_LIMIT)}\n\n# Context truncated after ${CONTEXT_TRUNCATION_LIMIT} characters.`;
}

function buildConfigContextMessage(filename: string, content: string, label: string): string {
  return `${label}: ${filename}\n\n\`\`\`cfg\n${truncateConfigContext(content)}\n\`\`\``;
}

function extractConfigCodeBlocks(content: string): string[] {
  const codeBlockPattern = /```([^\n`]*)\n([\s\S]*?)```/g;
  const configBlocks: string[] = [];
  const fallbackBlocks: string[] = [];

  for (const match of content.matchAll(codeBlockPattern)) {
    const language = match[1].trim().toLowerCase();
    const block = match[2].trim();
    if (!block) {
      continue;
    }

    if (CONFIG_CODE_LANGUAGES.has(language)) {
      configBlocks.push(block);
      continue;
    }

    fallbackBlocks.push(block);
  }

  if (configBlocks.length > 0) {
    return configBlocks;
  }

  return fallbackBlocks.length > 0 ? [fallbackBlocks[0]] : [];
}

function extractConfigCodeBlock(content: string): string | null {
  return extractConfigCodeBlocks(content)[0] ?? null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractMentionedConfigFilenames(texts: string[], availableFilenames: string[]): string[] {
  const matches: string[] = [];

  for (const filename of availableFilenames) {
    const pattern = new RegExp(`(^|[^A-Za-z0-9_.-])${escapeRegExp(filename)}(?=$|[^A-Za-z0-9_.-])`, 'i');
    if (texts.some((text) => pattern.test(text))) {
      matches.push(filename);
    }
  }

  return matches;
}

function extractAssistantFileHint(
  configBlock: string,
  availableFilenames: string[],
): { configText: string; fileHint: string | null } {
  const availableByLower = new Map(availableFilenames.map((filename) => [filename.toLowerCase(), filename]));
  const lines = configBlock.split(/\r?\n/);
  let fileHint: string | null = null;
  let fileHintLineIndex = -1;

  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();

    if (!trimmed) {
      continue;
    }

    const hintMatch = ASSISTANT_FILE_HINT_RE.exec(trimmed);
    if (hintMatch) {
      fileHint = availableByLower.get(hintMatch[1].trim().toLowerCase()) ?? null;
      fileHintLineIndex = index;
    }

    break;
  }

  if (fileHintLineIndex === -1) {
    return { configText: configBlock, fileHint };
  }

  return {
    configText: lines.filter((_, index) => index !== fileHintLineIndex).join('\n').trim(),
    fileHint,
  };
}

function scoreAssistantTargetFile(config: ConfigFile, assistantSections: ConfigSection[]): {
  exactMatches: number;
  sectionTypeMatches: number;
} {
  const fullHeaders = new Set(config.sections.map((section) => section.full_header));
  const sectionTypes = new Set(config.sections.map((section) => section.section_type));
  let exactMatches = 0;
  let sectionTypeMatches = 0;

  assistantSections.forEach((section) => {
    if (fullHeaders.has(section.full_header)) {
      exactMatches += 1;
      return;
    }

    if (sectionTypes.has(section.section_type)) {
      sectionTypeMatches += 1;
    }
  });

  return { exactMatches, sectionTypeMatches };
}

function resolveAssistantTargetFile(
  assistantConfig: ConfigFile,
  configFiles: Record<string, ConfigFile>,
  activeFile: string,
  hintedFilenames: string[],
): string | null {
  const availableFilenames = Object.keys(configFiles);
  if (availableFilenames.length === 0) {
    return null;
  }

  const uniqueHints = Array.from(new Set(hintedFilenames.filter((filename) => Boolean(configFiles[filename]))));
  if (uniqueHints.length === 1) {
    return uniqueHints[0];
  }

  const scores = availableFilenames
    .map((filename) => {
      const { exactMatches, sectionTypeMatches } = scoreAssistantTargetFile(
        configFiles[filename],
        assistantConfig.sections,
      );

      return {
        filename,
        exactMatches,
        sectionTypeMatches,
        hinted: uniqueHints.includes(filename),
        active: filename === activeFile,
      };
    })
    .sort((left, right) => {
      if (right.exactMatches !== left.exactMatches) {
        return right.exactMatches - left.exactMatches;
      }
      if (right.hinted !== left.hinted) {
        return Number(right.hinted) - Number(left.hinted);
      }
      if (right.sectionTypeMatches !== left.sectionTypeMatches) {
        return right.sectionTypeMatches - left.sectionTypeMatches;
      }
      if (right.active !== left.active) {
        return Number(right.active) - Number(left.active);
      }
      return left.filename.localeCompare(right.filename);
    });

  const bestScore = scores[0];
  if (bestScore.exactMatches > 0 || bestScore.sectionTypeMatches > 0) {
    return bestScore.filename;
  }

  if (configFiles[activeFile]) {
    return activeFile;
  }

  return availableFilenames[0] ?? null;
}

function getLmStudioMcpStatusPresentation(status: LmStudioMcpStatus): {
  label: string;
  className: string;
  title: string;
} {
  const pluginText = status.pluginId ?? 'disabled';

  if (!status.requested) {
    return {
      label: 'Docs MCP off',
      className: 'border-[var(--color-bg-tertiary)] bg-[var(--color-bg-secondary)] text-[var(--color-text-secondary)]',
      title: 'LM Studio docs MCP was disabled for this request.',
    };
  }

  if (status.fallbackUsed) {
    return {
      label: 'Docs MCP fallback',
      className: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
      title: `${status.fallbackReason ?? 'The proxy retried on the OpenAI-compatible endpoint.'} Plugin: ${pluginText}.`,
    };
  }

  if (status.toolUsed) {
    const toolText = status.toolNames.length > 0 ? ` Tools: ${status.toolNames.join(', ')}.` : '';
    return {
      label: 'Docs MCP used',
      className: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
      title: `LM Studio used ${pluginText} through /api/v1/chat.${toolText}`,
    };
  }

  return {
    label: 'Docs MCP not used',
    className: 'border-[var(--color-bg-tertiary)] bg-[var(--color-bg-secondary)] text-[var(--color-text-secondary)]',
    title: `LM Studio enabled ${pluginText}, but the model answered without calling it.`,
  };
}

function extractRequestedKlipperDocFilenames(content: string): string[] {
  const requestedDocs = new Set<string>();
  const segments = content
    .split(/\r?\n+/)
    .flatMap((line) => line.split(/(?<=[.!?])\s+/))
    .map((segment) => segment.trim())
    .filter(Boolean);

  for (const segment of segments) {
    if (!KLIPPER_DOC_REQUEST_RE.test(segment)) {
      continue;
    }

    for (const match of segment.matchAll(KLIPPER_DOC_FILENAME_RE)) {
      requestedDocs.add(match[2]);
      if (requestedDocs.size >= MAX_AUTO_FETCHED_KLIPPER_DOCS) {
        return Array.from(requestedDocs);
      }
    }
  }

  return Array.from(requestedDocs);
}

function buildAutoLoadedKlipperDocMessage(documents: api.KlipperDocResponse[]): string {
  return [
    'The app automatically fetched the full bundled Klipper markdown document(s) you requested. Answer the user\'s previous request directly now using these documents. Do not ask the user to paste the same documentation again unless you need a different source document.',
    ...documents.map((document) => `Full bundled Klipper document: ${document.filename}\n\n${document.content}`),
  ].join('\n\n---\n\n');
}

interface ChatDialogProps {
  open: boolean;
  onClose: () => void;
}

interface AssistantDraftFilePreview {
  filename: string;
  originalText: string;
  baseConfig: ConfigFile;
  assistantConfig: ConfigFile;
  mergedText: string;
  changes: AssistantDraftChange[];
}

interface AssistantDraftPreview {
  filePreviews: AssistantDraftFilePreview[];
  selectedChangeIds: string[];
  previewUpdating: boolean;
}

const ChatDialog: React.FC<ChatDialogProps> = ({ open, onClose }) => {
  const { settings, setSettings, isConfigured, messages, setMessages, clearMessages } = useAiStore();
  const {
    configFiles,
    activeFile,
    validation,
    schemas,
    textEditorDirty,
    textDraftFile,
    textDraftText,
    setConfigFile,
    setValidation,
    clearTextDraft,
    setTextDraft,
    setTextEditorDirty,
    markDirty,
  } = useConfigStore();
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [selectedConfigContextFiles, setSelectedConfigContextFiles] = useState<string[]>(activeFile ? [activeFile] : []);
  const [attachedConfigFiles, setAttachedConfigFiles] = useState<AttachedConfigFile[]>([]);
  const [assistantDraftPreview, setAssistantDraftPreview] = useState<AssistantDraftPreview | null>(null);
  const [assistantDraftPreviewLoading, setAssistantDraftPreviewLoading] = useState<string | null>(null);
  const [assistantDraftApplicableMessages, setAssistantDraftApplicableMessages] = useState<Record<number, boolean>>({});
  const [includeFilesMenuOpen, setIncludeFilesMenuOpen] = useState(false);

  // Settings editing state
  const [editApiKey, setEditApiKey] = useState(settings.apiKey);
  const [editModel, setEditModel] = useState(settings.model);
  const [editApiUrl, setEditApiUrl] = useState(settings.apiUrl);
  const [editApiProvider, setEditApiProvider] = useState<AiProvider>(settings.apiProvider);
  const [editLmStudioHost, setEditLmStudioHost] = useState(settings.lmStudioHost);
  const [editLmStudioPort, setEditLmStudioPort] = useState(settings.lmStudioPort);
  const [editLmStudioMcpPluginId, setEditLmStudioMcpPluginId] = useState(settings.lmStudioMcpPluginId);
  const [editOllamaHost, setEditOllamaHost] = useState(settings.ollamaHost);
  const [editOllamaPort, setEditOllamaPort] = useState(settings.ollamaPort);

  // Available models from local server
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);

  // Fetch available models from local server
  const fetchAvailableModels = async (
    provider: AiProvider = editApiProvider,
    apiUrl: string = editApiUrl,
    apiKey: string = editApiKey,
  ) => {
    if (!isLocalProvider(provider)) {
      setAvailableModels([]);
      return;
    }
    setModelsLoading(true);
    setModelsError(null);
    try {
      const result = await api.listModels(apiUrl, apiKey);
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
      void fetchAvailableModels(editApiProvider, editApiUrl, editApiKey);
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
      setEditLmStudioMcpPluginId(settings.lmStudioMcpPluginId);
      setEditOllamaHost(settings.ollamaHost);
      setEditOllamaPort(settings.ollamaPort);
      setError(null);
      if (isLocalProvider(settings.apiProvider)) {
        void fetchAvailableModels(settings.apiProvider, settings.apiUrl, settings.apiKey);
      }
    }
  }, [open, settings]);

  useEffect(() => {
    if (!open) {
      setIncludeFilesMenuOpen(false);
      return;
    }

    setSelectedConfigContextFiles((prev) => {
      if (prev.length > 0 || !activeFile) {
        return prev;
      }

      return [activeFile];
    });
  }, [open, activeFile]);

  useEffect(() => {
    const availableFiles = new Set(Object.keys(configFiles));

    setSelectedConfigContextFiles((prev) => {
      const next = prev.filter((filename) => availableFiles.has(filename));
      return next.length === prev.length ? prev : next;
    });
  }, [configFiles]);

  useEffect(() => {
    if (!includeFilesMenuOpen) {
      return;
    }

    const handlePointerDown = (event: MouseEvent) => {
      if (includeFilesMenuRef.current?.contains(event.target as Node)) {
        return;
      }

      setIncludeFilesMenuOpen(false);
    };

    document.addEventListener('mousedown', handlePointerDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
    };
  }, [includeFilesMenuOpen]);

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    let cancelled = false;

    if (!open || !activeFile) {
      setAssistantDraftApplicableMessages({});
      return () => {
        cancelled = true;
      };
    }

    const assistantMessages = messages
      .map((msg, index) => ({ msg, index }))
      .filter(({ msg }) => msg.role === 'assistant' && extractConfigCodeBlock(msg.content));

    if (assistantMessages.length === 0) {
      setAssistantDraftApplicableMessages({});
      return () => {
        cancelled = true;
      };
    }

    void (async () => {
      const availabilityEntries = await Promise.all(
        assistantMessages.map(async ({ msg, index }) => [index, await canAssistantMessageAffectDraft(msg.content, index)] as const),
      );

      if (cancelled) {
        return;
      }

      setAssistantDraftApplicableMessages(Object.fromEntries(availabilityEntries));
    })();

    return () => {
      cancelled = true;
    };
  }, [open, messages, activeFile, configFiles, textDraftFile, textDraftText]);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const includeFilesMenuRef = useRef<HTMLDivElement>(null);
  const assistantDraftPreviewRequestRef = useRef(0);

  const loadedConfigFilenames = Object.keys(configFiles);

  const handleAttachConfigFiles = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) {
      return;
    }

    try {
      const loadedFiles = await Promise.all(files.map(async (file, index) => ({
        id: `${file.name}-${file.lastModified}-${index}`,
        name: file.name,
        content: await file.text(),
      })));
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

  const getConfigText = async (filename: string): Promise<string | null> => {
    if (!filename) {
      return null;
    }

    if (textDraftFile === filename) {
      return textDraftText;
    }

    const config = configFiles[filename];
    if (!config) {
      return null;
    }

    return api.exportConfig(config);
  };

  const getActiveConfigText = async (): Promise<string | null> => {
    if (!activeFile) {
      return null;
    }

    return getConfigText(activeFile);
  };

  const getConfigContexts = async (filenames: string[]): Promise<string[]> => {
    if (filenames.length === 0) {
      return [];
    }

    const contexts = await Promise.all(
      Array.from(new Set(filenames)).map(async (filename) => {
        const configText = await getConfigText(filename);
        if (configText == null) {
          return null;
        }

        const label = filename === activeFile
          ? (
            textDraftFile === activeFile && textEditorDirty
              ? 'Active Klipper config draft with unapplied text-view changes'
              : 'Active Klipper config draft'
          )
          : 'Loaded Klipper config file';

        return buildConfigContextMessage(filename, configText, label);
      }),
    );

    return contexts.filter((context): context is string => context != null);
  };

  const getSelectedConfigContexts = async (): Promise<string[]> => getConfigContexts(selectedConfigContextFiles);

  const buildAssistantDraftMergedText = async (
    baseConfig: ConfigFile,
    assistantConfig: ConfigFile,
    originalText: string,
    selectedChangeIds: string[],
  ): Promise<string> => {
    if (selectedChangeIds.length === 0) {
      return originalText;
    }

    const { mergedConfig } = mergeAssistantSectionsIntoConfig(baseConfig, assistantConfig, selectedChangeIds);
    return api.exportConfig({ ...mergedConfig, raw_text: originalText });
  };

  const getAssistantMessageHintTexts = (content: string, messageIndex?: number): string[] => {
    if (messageIndex == null) {
      return [content];
    }

    const hintTexts = [content];

    for (let index = messageIndex - 1; index >= 0; index -= 1) {
      const candidate = messages[index];
      if (candidate?.role === 'user') {
        hintTexts.push(candidate.content);
        break;
      }
    }

    return hintTexts;
  };

  const flattenAssistantDraftChanges = (filePreviews: AssistantDraftFilePreview[]): AssistantDraftChange[] =>
    filePreviews.flatMap((filePreview) => filePreview.changes);

  const buildAssistantDraftTargetConfigs = async (
    content: string,
    messageIndex?: number,
  ): Promise<ConfigFile[]> => {
    const configBlocks = extractConfigCodeBlocks(content);
    if (configBlocks.length === 0) {
      throw new Error('The assistant response did not include a config code block to review.');
    }

    const hintTexts = getAssistantMessageHintTexts(content, messageIndex);
    const mentionedFilenames = extractMentionedConfigFilenames(hintTexts, loadedConfigFilenames);
    const groupedTargets = new Map<string, ConfigFile>();

    for (const configBlock of configBlocks) {
      const { configText, fileHint } = extractAssistantFileHint(configBlock, loadedConfigFilenames);
      if (!configText.trim()) {
        continue;
      }

      const assistantParseFilename = fileHint ?? mentionedFilenames[0] ?? activeFile ?? loadedConfigFilenames[0] ?? 'printer.cfg';
      const assistantResult = await api.parseConfigText(configText, assistantParseFilename);

      if (assistantResult.config.sections.length === 0) {
        continue;
      }

      const targetFile = resolveAssistantTargetFile(
        assistantResult.config,
        configFiles,
        activeFile,
        fileHint ? [fileHint] : mentionedFilenames,
      );

      if (!targetFile) {
        throw new Error('Unable to determine which config file should receive the assistant changes.');
      }

      const existingTarget = groupedTargets.get(targetFile);
      if (existingTarget) {
        groupedTargets.set(targetFile, {
          ...existingTarget,
          includes: Array.from(new Set([...existingTarget.includes, ...assistantResult.config.includes])),
          header_comments: existingTarget.header_comments.length > 0
            ? existingTarget.header_comments
            : assistantResult.config.header_comments,
          sections: [...existingTarget.sections, ...assistantResult.config.sections],
        });
        continue;
      }

      groupedTargets.set(targetFile, {
        ...assistantResult.config,
        filename: targetFile,
        includes: [...assistantResult.config.includes],
        header_comments: [...assistantResult.config.header_comments],
        sections: [...assistantResult.config.sections],
      });
    }

    if (groupedTargets.size === 0) {
      throw new Error('The assistant response did not include any complete config sections to merge.');
    }

    return Array.from(groupedTargets.values());
  };

  const prepareAssistantDraftPreview = async (
    content: string,
    messageIndex?: number,
  ): Promise<AssistantDraftPreview> => {
    const assistantConfigs = await buildAssistantDraftTargetConfigs(content, messageIndex);
    const filePreviews: AssistantDraftFilePreview[] = [];

    for (const assistantConfig of assistantConfigs) {
      const targetFile = assistantConfig.filename;
      const baseText = await getConfigText(targetFile);
      if (baseText == null) {
        throw new Error(`Unable to load ${targetFile} for preview.`);
      }

      const baseResult = await api.parseConfigText(baseText, targetFile);
      const baseConfig = { ...baseResult.config, raw_text: baseText };
      const { mergedConfig, changes } = mergeAssistantSectionsIntoConfig(baseConfig, assistantConfig);
      const mergedText = await api.exportConfig({ ...mergedConfig, raw_text: baseText });

      if (normalizeDiffText(baseText) === normalizeDiffText(mergedText)) {
        continue;
      }

      filePreviews.push({
        filename: targetFile,
        originalText: baseText,
        baseConfig,
        assistantConfig,
        mergedText,
        changes,
      });
    }

    if (filePreviews.length === 0) {
      throw new Error('The assistant response does not change the current draft.');
    }

    return {
      filePreviews,
      selectedChangeIds: flattenAssistantDraftChanges(filePreviews).map((change) => change.id),
      previewUpdating: false,
    };
  };

  const canAssistantMessageAffectDraft = async (
    content: string,
    messageIndex?: number,
  ): Promise<boolean> => {
    try {
      await prepareAssistantDraftPreview(content, messageIndex);
      return true;
    } catch {
      return false;
    }
  };

  const handleApplyAssistantEdit = async (content: string, messageIndex?: number) => {
    setAssistantDraftPreviewLoading(content);
    setError(null);

    try {
      setAssistantDraftPreview(await prepareAssistantDraftPreview(content, messageIndex));
    } catch (err: unknown) {
      setAssistantDraftPreview(null);
      setError(err instanceof Error ? err.message : 'Failed to prepare assistant changes.');
    } finally {
      setAssistantDraftPreviewLoading(null);
    }
  };

  const handleAssistantDraftSelectionChange = async (selectedChangeIds: string[]) => {
    const currentPreview = assistantDraftPreview;
    if (!currentPreview) {
      return;
    }

    if (
      selectedChangeIds.length === currentPreview.selectedChangeIds.length &&
      selectedChangeIds.every((id, index) => id === currentPreview.selectedChangeIds[index])
    ) {
      return;
    }

    const requestId = ++assistantDraftPreviewRequestRef.current;
    setAssistantDraftPreview({
      ...currentPreview,
      selectedChangeIds,
      previewUpdating: true,
    });

    try {
      const filePreviews = await Promise.all(
        currentPreview.filePreviews.map(async (filePreview) => ({
          ...filePreview,
          mergedText: await buildAssistantDraftMergedText(
            filePreview.baseConfig,
            filePreview.assistantConfig,
            filePreview.originalText,
            selectedChangeIds,
          ),
        })),
      );

      if (requestId !== assistantDraftPreviewRequestRef.current) {
        return;
      }

      setAssistantDraftPreview((preview) => {
        if (!preview) {
          return preview;
        }

        return {
          ...preview,
          selectedChangeIds,
          filePreviews,
          previewUpdating: false,
        };
      });
      setError(null);
    } catch (err: unknown) {
      if (requestId !== assistantDraftPreviewRequestRef.current) {
        return;
      }

      setAssistantDraftPreview((preview) => {
        if (!preview) {
          return preview;
        }

        return {
          ...preview,
          previewUpdating: false,
        };
      });
      setError(err instanceof Error ? err.message : 'Failed to update the assistant preview.');
    }
  };

  const handleAcceptAssistantEdit = async () => {
    if (!assistantDraftPreview) {
      return;
    }

    try {
      const selectedChangeIds = new Set(assistantDraftPreview.selectedChangeIds);
      const updatedConfigs = { ...configFiles };
      const updatedValidation = { ...validation };
      const touchedFiles: string[] = [];

      for (const filePreview of assistantDraftPreview.filePreviews) {
        const hasSelectedChanges = filePreview.changes.some((change) => selectedChangeIds.has(change.id));
        if (!hasSelectedChanges) {
          continue;
        }

        if (normalizeDiffText(filePreview.originalText) === normalizeDiffText(filePreview.mergedText)) {
          continue;
        }

        const result = await api.parseConfigText(filePreview.mergedText, filePreview.filename);
        updatedConfigs[filePreview.filename] = result.config;
        updatedValidation[filePreview.filename] = result.validation;
        touchedFiles.push(filePreview.filename);
      }

      if (touchedFiles.length === 0) {
        setAssistantDraftPreview(null);
        setError(null);
        return;
      }

      touchedFiles.forEach((filename) => {
        setConfigFile(filename, updatedConfigs[filename]);
        setValidation(filename, updatedValidation[filename]);
      });

      if (textDraftFile && touchedFiles.includes(textDraftFile)) {
        clearTextDraft();
        setTextEditorDirty(false);
      }
      markDirty();

      const graphStore = useGraphStore.getState();
      graphStore.clearGraph();
      buildProjectGraph(updatedConfigs, graphStore, schemas, updatedValidation);

      setAssistantDraftPreview(null);
      setError(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to accept assistant changes.');
    }
  };

  const handleNewChat = () => {
    clearMessages();
    setAssistantDraftPreview(null);
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
      const contextMessages: Array<{ role: 'system'; content: string }> = [];
      const chatRequestBase = {
        apiKey: editApiKey,
        model: editModel,
        apiUrl: editApiUrl,
        apiProvider: editApiProvider,
        lmStudioMcpPluginId: editApiProvider === 'lm-studio' ? editLmStudioMcpPluginId : undefined,
      };
      const mentionedConfigFiles = extractMentionedConfigFilenames([userMsg.content], loadedConfigFilenames);
      const selectedConfigContexts = await getConfigContexts([
        ...selectedConfigContextFiles,
        ...mentionedConfigFiles,
      ]);

      for (const configContext of selectedConfigContexts) {
        contextMessages.push({ role: 'system', content: configContext });
      }

      for (const attachedFile of attachedConfigFiles) {
        contextMessages.push({
          role: 'system',
          content: buildConfigContextMessage(attachedFile.name, attachedFile.content, 'User-attached local Klipper config file'),
        });
      }

      if (mentionedConfigFiles.length > 0) {
        contextMessages.push({
          role: 'system',
          content: `The user explicitly referenced these loaded config files: ${mentionedConfigFiles.join(', ')}. Apply requested edits to those files instead of defaulting to the active text-view file. When you return cfg sections for a specific file, add a first comment line exactly like "# file: <filename>" before the changed sections. If changes span multiple files, return one separate fenced cfg block per file.`,
        });
      } else if (activeFile) {
        contextMessages.push({
          role: 'system',
          content: `If the user asks you to modify ${activeFile}, or does not name a different config file, return only the changed or new sections for ${activeFile} inside a single fenced code block labeled cfg. Include full section headers and the full contents of each changed section. If a different loaded config file is clearly requested, target that file instead and start that cfg block with a first comment line exactly like "# file: <filename>". If changes span multiple files, return one separate fenced cfg block per file. Do not return the entire file unless the user explicitly asks for a full replacement.`,
        });
      }

      const response = await api.aiChat({
        ...chatRequestBase,
        messages: [
          ...contextMessages,
          ...newMessages.map((m) => ({ role: m.role, content: m.content })),
        ],
      });

      if (response.error) {
        throw new Error(response.error);
      }

      let assistantMsg: ChatMessage = {
        role: 'assistant',
        content: response.content || 'No response.',
        lmStudioMcp: response.lmStudioMcp,
      };

      const requestedKlipperDocs = extractRequestedKlipperDocFilenames(assistantMsg.content);
      if (requestedKlipperDocs.length > 0) {
        try {
          const docResults = await Promise.allSettled(
            requestedKlipperDocs.map((filename) => api.getKlipperDoc(filename)),
          );
          const loadedDocs = docResults
            .flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []));

          if (loadedDocs.length > 0) {
            const followUpResponse = await api.aiChat({
              ...chatRequestBase,
              messages: [
                ...contextMessages,
                ...newMessages.map((m) => ({ role: m.role, content: m.content })),
                { role: 'assistant', content: assistantMsg.content },
                { role: 'user', content: buildAutoLoadedKlipperDocMessage(loadedDocs) },
              ],
            });

            if (followUpResponse.error) {
              throw new Error(followUpResponse.error);
            }

            assistantMsg = {
              role: 'assistant',
              content: followUpResponse.content || assistantMsg.content,
              lmStudioMcp: followUpResponse.lmStudioMcp ?? assistantMsg.lmStudioMcp,
              autoLoadedDocs: loadedDocs.map((document) => document.filename),
            };
          } else {
            setError(`The assistant requested full Klipper docs (${requestedKlipperDocs.join(', ')}), but none of those bundled markdown files were available from the backend.`);
          }
        } catch (autoDocErr: unknown) {
          const autoDocMessage = autoDocErr instanceof Error
            ? autoDocErr.message
            : 'Automatic Klipper doc loading failed.';
          setError(`Automatic full-doc follow-up failed: ${autoDocMessage}`);
        }
      }

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
      lmStudioMcpPluginId: editLmStudioMcpPluginId,
      ollamaHost: editOllamaHost,
      ollamaPort: editOllamaPort,
    });
    if (isLocalProvider(editApiProvider)) {
      void fetchAvailableModels(editApiProvider, editApiUrl, editApiKey);
    }
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
    const showLocalFields = isLocalProvider(editApiProvider);
    const showLmStudioMcpField = editApiProvider === 'lm-studio';

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

              {showLmStudioMcpField && (
                <div>
                  <label className="block text-[10px] font-semibold text-[var(--color-text-secondary)] uppercase tracking-wider mb-1.5">
                    LM Studio MCP Plugin ID
                  </label>
                  <input
                    type="text"
                    className="w-full px-3 py-2 rounded-lg text-xs font-mono bg-[var(--color-bg-primary)] border border-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none transition-colors"
                    value={editLmStudioMcpPluginId}
                    onChange={(e) => setEditLmStudioMcpPluginId(e.target.value)}
                    placeholder="mcp/klipper-docs"
                  />
                  <p className="mt-1 text-[10px] text-[var(--color-text-secondary)]">
                    Leave blank to disable MCP docs lookup for LM Studio.
                  </p>
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
                {/* Model selector */}
                {isLocalProvider(editApiProvider) && (
                  <div>
                    <label className="block text-[10px] text-[var(--color-text-secondary)] mb-1">Model</label>
                    {availableModels.length > 0 ? (
                      <select
                        className="w-full px-3 py-1.5 rounded text-xs font-mono bg-[var(--color-bg-secondary)] border border-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none transition-colors"
                        value={editModel}
                        onChange={(e) => setEditModel(e.target.value)}
                      >
                        {availableModels.map((m) => (
                          <option key={m} value={m}>{m}</option>
                        ))}
                      </select>
                    ) : (
                      <input
                        type="text"
                        className="w-full px-3 py-1.5 rounded text-xs font-mono bg-[var(--color-bg-secondary)] border border-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none transition-colors"
                        value={editModel}
                        onChange={(e) => setEditModel(e.target.value)}
                        placeholder="Model name"
                      />
                    )}
                    <button
                      onClick={() => {
                        void fetchAvailableModels(editApiProvider, editApiUrl, editApiKey);
                      }}
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
                {editApiProvider === 'lm-studio' && (
                  <div>
                    <label className="block text-[10px] text-[var(--color-text-secondary)] mb-1">LM Studio MCP Plugin ID</label>
                    <input
                      type="text"
                      className="w-full px-3 py-1.5 rounded text-xs font-mono bg-[var(--color-bg-secondary)] border border-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none transition-colors"
                      value={editLmStudioMcpPluginId}
                      onChange={(e) => setEditLmStudioMcpPluginId(e.target.value)}
                      placeholder="mcp/klipper-docs"
                    />
                    <p className="mt-1 text-[10px] text-[var(--color-text-secondary)]">
                      Leave blank to disable MCP docs lookup for LM Studio.
                    </p>
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
            (() => {
              const assistantConfigBlock = msg.role === 'assistant' ? extractConfigCodeBlock(msg.content) : null;
              const hasApplicableAssistantDraft = assistantDraftApplicableMessages[i] === true;
              const lmStudioMcpStatus = msg.role === 'assistant' ? msg.lmStudioMcp : undefined;
              const lmStudioMcpPresentation = lmStudioMcpStatus ? getLmStudioMcpStatusPresentation(lmStudioMcpStatus) : null;
              return (
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
                    {msg.role === 'assistant' && lmStudioMcpPresentation && (
                      <div className="mt-3 flex">
                        <span
                          className={`inline-flex items-center rounded-full border px-2 py-1 text-[10px] font-medium ${lmStudioMcpPresentation.className}`}
                          title={lmStudioMcpPresentation.title}
                        >
                          {lmStudioMcpPresentation.label}
                        </span>
                      </div>
                    )}
                    {msg.role === 'assistant' && Array.isArray(msg.autoLoadedDocs) && msg.autoLoadedDocs.length > 0 && (
                      <div className="mt-3 flex">
                        <span
                          className="inline-flex items-center rounded-full border border-sky-500/30 bg-sky-500/10 px-2 py-1 text-[10px] font-medium text-sky-300"
                          title={`The app automatically fetched full Klipper docs for this answer: ${msg.autoLoadedDocs.join(', ')}`}
                        >
                          Auto-loaded docs: {msg.autoLoadedDocs.join(', ')}
                        </span>
                      </div>
                    )}
                    {msg.role === 'assistant' && assistantConfigBlock && activeFile && hasApplicableAssistantDraft && (
                      <div className="mt-3 flex justify-end">
                        <button
                          onClick={() => {
                            void handleApplyAssistantEdit(msg.content, i);
                          }}
                          disabled={assistantDraftPreviewLoading === msg.content}
                          className="rounded-md border border-[var(--color-bg-tertiary)] px-2 py-1 text-[10px] font-medium text-[var(--color-text-secondary)] transition-colors hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-60"
                          title="Preview how the assistant sections would merge into the matching config file"
                        >
                          {assistantDraftPreviewLoading === msg.content ? 'Preparing Review...' : 'Apply and Review Changes'}
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              );
            })()
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

        <input
          ref={fileInputRef}
          type="file"
          accept=".cfg,text/plain"
          multiple
          className="hidden"
          onChange={handleAttachConfigFiles}
        />

        {/* Input bar */}
        <div className="border-t border-[var(--color-bg-tertiary)]">
          <div className="flex flex-wrap items-center gap-2 px-4 pt-3 pb-2 text-[10px] text-[var(--color-text-secondary)]">
            <div className="relative" ref={includeFilesMenuRef}>
              <button
                type="button"
                onClick={() => setIncludeFilesMenuOpen((prev) => !prev)}
                className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 font-medium transition-colors ${
                  includeFilesMenuOpen
                    ? 'border-[var(--color-accent)] text-[var(--color-accent)]'
                    : 'border-[var(--color-bg-tertiary)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]'
                }`}
                title="Choose which loaded config files to include in chat context"
              >
                Include Files
                <KeyboardArrowDownRounded
                  sx={{ fontSize: 16 }}
                  className={`transition-transform ${includeFilesMenuOpen ? 'rotate-180' : ''}`}
                />
              </button>
              {includeFilesMenuOpen && (
                <div className="absolute bottom-full left-0 z-20 mb-2 w-72 rounded-lg border border-[var(--color-bg-tertiary)] bg-[var(--color-bg-secondary)] p-2 shadow-2xl">
                  <div className="mb-2 flex items-center justify-between gap-2 border-b border-[var(--color-bg-tertiary)] pb-2">
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-secondary)]">
                      Loaded .cfg files
                    </span>
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      className="rounded-md border border-[var(--color-bg-tertiary)] p-1 text-[var(--color-text-secondary)] transition-colors hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
                      title="Import local .cfg files"
                    >
                      <UploadFileRounded sx={{ fontSize: 16 }} />
                    </button>
                  </div>
                  {loadedConfigFilenames.length > 0 ? (
                    <div className="max-h-56 space-y-1 overflow-y-auto pr-1">
                      {loadedConfigFilenames.map((filename) => {
                        const checked = selectedConfigContextFiles.includes(filename);
                        const isActiveSelection = filename === activeFile;

                        return (
                          <label
                            key={filename}
                            className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-[var(--color-bg-primary)]"
                          >
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={(e) => {
                                setSelectedConfigContextFiles((prev) => {
                                  if (e.target.checked) {
                                    return prev.includes(filename) ? prev : [...prev, filename];
                                  }

                                  return prev.filter((value) => value !== filename);
                                });
                              }}
                              className="rounded border-[var(--color-bg-tertiary)] bg-[var(--color-bg-primary)]"
                            />
                            <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--color-text-primary)]">
                              {filename}
                            </span>
                            {isActiveSelection && (
                              <span className="rounded-full bg-[var(--color-bg-primary)] px-1.5 py-0.5 text-[9px] font-medium text-[var(--color-text-secondary)]">
                                Active
                              </span>
                            )}
                          </label>
                        );
                      })}
                    </div>
                  ) : (
                    <p className="px-2 py-3 text-[10px] text-[var(--color-text-secondary)]">
                      No loaded .cfg files. Use the import button to attach local files.
                    </p>
                  )}
                </div>
              )}
            </div>
          </div>
          {attachedConfigFiles.length > 0 && (
            <div className="flex flex-wrap gap-2 px-4 pb-2">
              {attachedConfigFiles.map((file) => (
                <button
                  key={file.id}
                  onClick={() => handleRemoveAttachedFile(file.id)}
                  className="rounded-full border border-[var(--color-bg-tertiary)] px-2 py-1 text-[10px] text-[var(--color-text-secondary)] hover:border-[var(--color-error)] hover:text-[var(--color-error)] transition-colors"
                  title="Remove imported file from chat context"
                >
                  {file.name} ×
                </button>
              ))}
            </div>
          )}
        <div className="flex items-center gap-2 p-4 pt-2">
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

      {assistantDraftPreview && (
        <AiDraftPreviewDialog
          filePreviews={assistantDraftPreview.filePreviews.map((filePreview) => ({
            filename: filePreview.filename,
            originalText: filePreview.originalText,
            mergedText: filePreview.mergedText,
          }))}
          changes={flattenAssistantDraftChanges(assistantDraftPreview.filePreviews)}
          selectedChangeIds={assistantDraftPreview.selectedChangeIds}
          previewUpdating={assistantDraftPreview.previewUpdating}
          onSelectionChange={(selectedChangeIds) => {
            void handleAssistantDraftSelectionChange(selectedChangeIds);
          }}
          onAccept={handleAcceptAssistantEdit}
          onClose={() => setAssistantDraftPreview(null)}
        />
      )}
    </div>
  );
};

export default ChatDialog;
