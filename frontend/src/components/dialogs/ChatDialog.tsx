import React, { useState, useRef, useEffect, useCallback, type ComponentPropsWithoutRef } from 'react';
import KeyboardArrowDownRounded from '@mui/icons-material/KeyboardArrowDownRounded';
import UploadFileRounded from '@mui/icons-material/UploadFileRounded';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import { useAiStore, AiProvider, ChatMessage, providerRequiresApiKey } from '../../stores/aiStore';
import { useConfigStore } from '../../stores/configStore';
import { useGraphStore } from '../../stores/graphStore';
import * as api from '../../services/api';
import AiDraftPreviewDialog from './AiDraftPreviewDialog';
import { mergeAssistantSectionsIntoConfig, preprocessDeleteMarkers, type AssistantDraftChange } from '../../utils/assistantDraftMerge';
import { normalizeDiffText } from '../../utils/configDiff';
import { buildProjectGraph } from '../../utils/graphBuilder';
import type { LmStudioContextStatus, LmStudioMcpStatus, PendingAiChatRequest } from '../../types/ai';
import type { ConfigFile, ConfigSection, ValidationError, ValidationResult } from '../../types/config';

interface ProviderInfo {
  label: string;
  defaultUrl: string;
  requiresKey: boolean;
  defaultHost: string;
  defaultPort: string;
  defaultModel: string;
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
    defaultModel: 'gpt-4o',
  },
  google: {
    label: 'Google (Gemini)',
    defaultUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    requiresKey: true,
    defaultHost: 'localhost',
    defaultPort: '1234',
    defaultModel: 'gemini-1.5-pro',
  },
  anthropic: {
    label: 'Anthropic (Claude)',
    defaultUrl: 'https://api.anthropic.com/v1/messages',
    requiresKey: true,
    defaultHost: 'localhost',
    defaultPort: '1234',
    defaultModel: 'claude-3-5-sonnet',
  },
  github: {
    label: 'GitHub Copilot',
    defaultUrl: 'https://models.github.ai/inference/chat/completions',
    requiresKey: true,
    defaultHost: 'localhost',
    defaultPort: '1234',
    defaultModel: 'gpt-4o',
  },
  'openai-compatible': {
    label: 'OpenAI Compatible',
    defaultUrl: 'http://localhost:11434/api/chat',
    requiresKey: true,
    defaultHost: 'localhost',
    defaultPort: '11434',
    defaultModel: 'gpt-4o',
  },
  'lm-studio': {
    label: 'LM Studio (Local)',
    defaultUrl: '',
    requiresKey: true,
    defaultHost: 'localhost',
    defaultPort: '1234',
    defaultModel: '',
  },
  ollama: {
    label: 'Ollama (Local)',
    defaultUrl: '',
    requiresKey: true,
    defaultHost: 'localhost',
    defaultPort: '11434',
    defaultModel: '',
  },
};

const isLocalProvider = (provider: AiProvider) => provider === 'lm-studio' || provider === 'ollama' || provider === 'openai-compatible';

function buildLocalProviderApiUrl(host: string, port: string): string {
  return `http://${host}:${port}/v1/chat/completions`;
}

function resolveProviderApiUrl(
  provider: AiProvider,
  apiUrl: string,
  lmStudioHost: string,
  lmStudioPort: string,
  ollamaHost: string,
  ollamaPort: string,
): string {
  if (provider === 'lm-studio') {
    return buildLocalProviderApiUrl(lmStudioHost, lmStudioPort);
  }

  if (provider === 'ollama') {
    return buildLocalProviderApiUrl(ollamaHost, ollamaPort);
  }

  // For openai-compatible, use the provided URL or default to Ollama
  if (provider === 'openai-compatible') {
    return apiUrl || buildLocalProviderApiUrl(ollamaHost, ollamaPort);
  }

  return apiUrl;
}

function getProviderModel(
  provider: AiProvider,
  providerModels: Partial<Record<AiProvider, string>>,
  fallbackModel = '',
  fallbackProvider?: AiProvider,
): string {
  const providerModel = providerModels[provider]?.trim();
  if (providerModel) {
    return providerModel;
  }
  if (fallbackProvider === provider && fallbackModel.trim()) {
    return fallbackModel;
  }
  return '';
}

type ParagraphProps = ComponentPropsWithoutRef<'p'>;
type ListProps = ComponentPropsWithoutRef<'ul'>;
type OrderedListProps = ComponentPropsWithoutRef<'ol'>;
type ListItemProps = ComponentPropsWithoutRef<'li'>;
type AnchorProps = ComponentPropsWithoutRef<'a'>;
type BlockquoteProps = ComponentPropsWithoutRef<'blockquote'>;
type TableProps = ComponentPropsWithoutRef<'table'>;
type TableCellProps = ComponentPropsWithoutRef<'th'>;
type TableDataCellProps = ComponentPropsWithoutRef<'td'>;
type CodeProps = ComponentPropsWithoutRef<'code'> & {
  children?: React.ReactNode;
  className?: string;
  inline?: boolean;
  node?: unknown;
};

function MarkdownCode({ children, className, inline }: CodeProps) {
  const content = String(children ?? '').replace(/\n$/, '');
  const language = className?.match(/language-([^\s]+)/)?.[1] ?? '';
  const isBlock = inline === false || Boolean(className) || content.includes('\n');
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'error'>('idle');
  const resetTimerRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (resetTimerRef.current !== null) {
      window.clearTimeout(resetTimerRef.current);
    }
  }, []);

  if (!isBlock) {
    return (
      <code className="rounded bg-[var(--color-bg-secondary)] px-1 py-0.5 font-mono text-[11px]">
        {content}
      </code>
    );
  }

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(content);
      setCopyState('copied');
    } catch {
      setCopyState('error');
    } finally {
      if (resetTimerRef.current !== null) {
        window.clearTimeout(resetTimerRef.current);
      }
      resetTimerRef.current = window.setTimeout(() => {
        setCopyState('idle');
      }, 2000);
    }
  };

  const buttonLabel = copyState === 'copied' ? 'Copied' : copyState === 'error' ? 'Copy failed' : 'Copy code';

  return (
    <div className="my-2 overflow-hidden rounded-md border border-[var(--color-bg-tertiary)] bg-[var(--color-bg-secondary)]">
      <div className="flex items-center justify-between gap-2 border-b border-[var(--color-bg-tertiary)] px-3 py-1.5">
        <span className="text-[10px] font-medium uppercase tracking-[0.16em] text-[var(--color-text-secondary)]">
          {language || 'code'}
        </span>
        <button
          type="button"
          onClick={() => {
            void handleCopy();
          }}
          className="rounded p-1 text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-bg-primary)] hover:text-[var(--color-text-primary)]"
          aria-label={buttonLabel}
          title={buttonLabel}
        >
          {copyState === 'copied' ? (
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M3 8.5l3 3 7-7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <rect x="5" y="3" width="8" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
              <path d="M3.5 10.5H3A1.5 1.5 0 011.5 9V3A1.5 1.5 0 013 1.5h6A1.5 1.5 0 0110.5 3v0.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
            </svg>
          )}
        </button>
      </div>
      <pre className="overflow-x-auto p-3">
        <code className="font-mono text-[11px]">{content}</code>
      </pre>
    </div>
  );
}

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
const MAX_ASSISTANT_DRAFT_VALIDATION_ATTEMPTS = 3;
const MAX_ASSISTANT_HINT_USER_MESSAGES = 3;

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

function extractEqualsSeparatedConfigLines(content: string): string[] {
  const matches = extractConfigCodeBlocks(content)
    .flatMap((block) => block.split(/\r?\n/))
    .map((line) => line.trim())
    .filter((line) => /^#?\s*[A-Za-z0-9_][A-Za-z0-9_-]*\s*=.*$/.test(line));

  return Array.from(new Set(matches));
}

function buildConfigSeparatorRewritePrompt(offendingLines: string[]): string {
  const examples = offendingLines
    .slice(0, 5)
    .map((line) => `- ${line}`)
    .join('\n');

  return [
    'Rewrite your previous reply so every cfg parameter assignment uses a colon separator instead of an equals sign.',
    'Keep the exact same files, section headers, parameter names, values, ordering, comments, and surrounding explanation.',
    'Do not change gcode command arguments inside multiline values. Only change cfg parameter lines from `key = value` to `key: value`.',
    'Return the full replacement reply.',
    '',
    'Examples that must be rewritten with colons:',
    examples,
  ].join('\n');
}

function appendWarningMessage(current: string | null, next: string): string {
  return current ? `${current}\n${next}` : next;
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

function formatCompactCount(value: number): string {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1).replace(/\.0$/, '')}M`;
  }

  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1).replace(/\.0$/, '')}k`;
  }

  return String(value);
}

function formatCount(value: number): string {
  return value.toLocaleString();
}

function getLmStudioContextPresentation(status: LmStudioContextStatus): {
  label: string;
  className: string;
  title: string;
  fillRatio: number | null;
} {
  const fillRatio = typeof status.utilization === 'number'
    ? Math.max(0, Math.min(status.utilization, 1))
    : null;

  let className = 'border-[var(--color-bg-tertiary)] bg-[var(--color-bg-secondary)] text-[var(--color-text-secondary)]';
  if (status.truncated || (fillRatio !== null && fillRatio >= 0.9)) {
    className = 'border-rose-500/30 bg-rose-500/10 text-rose-300';
  } else if (fillRatio !== null && fillRatio >= 0.75) {
    className = 'border-amber-500/30 bg-amber-500/10 text-amber-300';
  } else if (fillRatio !== null && fillRatio >= 0.5) {
    className = 'border-sky-500/30 bg-sky-500/10 text-sky-300';
  } else if (fillRatio !== null) {
    className = 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300';
  }

  const lines: string[] = [];
  if (status.usedTokens !== null && status.contextWindow !== null && fillRatio !== null) {
    lines.push(
      `LM Studio context used for this turn: ${formatCount(status.usedTokens)} / ${formatCount(status.contextWindow)} tokens (${(fillRatio * 100).toFixed(1)}%).`,
    );
  } else if (status.usedTokens !== null) {
    const basis = status.totalTokens !== null
      ? 'total turn tokens'
      : status.promptTokens !== null
        ? 'prompt tokens'
        : 'estimated prompt tokens';
    lines.push(`LM Studio reported ${basis}: ${formatCount(status.usedTokens)}.`);
    if (status.contextWindow === null) {
      lines.push('LM Studio did not expose the model context window for this request, so this is not a true max-context percentage.');
    }
  } else {
    lines.push(`LM Studio request size: ${formatCount(status.requestChars)} characters.`);
    lines.push('LM Studio did not report token usage for this request.');
  }

  if (status.promptTokens !== null || status.completionTokens !== null || status.totalTokens !== null) {
    const usageParts: string[] = [];
    if (status.promptTokens !== null) {
      usageParts.push(`prompt ${formatCount(status.promptTokens)}`);
    }
    if (status.completionTokens !== null) {
      usageParts.push(`completion ${formatCount(status.completionTokens)}`);
    }
    if (status.totalTokens !== null) {
      usageParts.push(`total ${formatCount(status.totalTokens)}`);
    }
    if (usageParts.length > 0) {
      lines.push(`Usage: ${usageParts.join(', ')}.`);
    }
  }

  if (status.estimatedPromptTokens !== null && status.promptTokens === null) {
    lines.push('Prompt tokens are estimated from request size because LM Studio did not return usage stats for this route.');
  }

  lines.push(`Request text sent from the app: ${formatCount(status.requestChars)} characters.`);
  if (status.truncated) {
    lines.push('The app truncated the LM Studio request text before sending it.');
  }

  if (status.truncated) {
    return {
      label: 'Context capped',
      className,
      title: lines.join(' '),
      fillRatio: fillRatio ?? 1,
    };
  }

  if (fillRatio !== null) {
    return {
      label: `Context ${Math.round(fillRatio * 100)}%`,
      className,
      title: lines.join(' '),
      fillRatio,
    };
  }

  if (status.usedTokens !== null) {
    return {
      label: `Context ${formatCompactCount(status.usedTokens)} tok`,
      className,
      title: lines.join(' '),
      fillRatio: null,
    };
  }

  return {
    label: 'Context size',
    className,
    title: lines.join(' '),
    fillRatio: null,
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
  pendingRequest?: PendingAiChatRequest | null;
  onPendingRequestHandled?: () => void;
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

interface AssistantReplyAttempt {
  assistantMessage: ChatMessage;
  conversationMessages: ChatMessage[];
  warningMessage: string | null;
}

interface AssistantDraftValidationIssueGroup {
  filename: string;
  errors: ValidationError[];
}

interface AssistantDraftValidationOutcome {
  applicable: boolean;
  blockingIssues: AssistantDraftValidationIssueGroup[];
  failureReason: string | null;
}

interface SubmitMessageOptions {
  hiddenFromUser?: boolean;
}

const RETRY_EXEMPT_DUPLICATE_SECTION_RE = /^Section \[[^\]]+\] (?:can only be defined once(?: across active included config files)?\.|is reused across active included config files\.)(?: Also defined in: .+)?$/;
const RETRY_EXEMPT_SHARED_PIN_RE = /^Pin '.*' is used by multiple sections: .+$/;

function isBlockingAssistantValidationIssue(error: ValidationError): boolean {
  return error.severity === 'error' || error.severity === 'warning';
}

function isRetryExemptAssistantValidationIssue(error: ValidationError): boolean {
  return RETRY_EXEMPT_DUPLICATE_SECTION_RE.test(error.message)
    || RETRY_EXEMPT_SHARED_PIN_RE.test(error.message);
}

function hasOnlyRetryExemptAssistantValidationIssues(
  blockingIssues: AssistantDraftValidationIssueGroup[],
): boolean {
  const issues = blockingIssues.flatMap((group) => group.errors);
  return issues.length > 0 && issues.every((error) => isRetryExemptAssistantValidationIssue(error));
}

function shouldRetryAssistantValidation(
  validationOutcome: AssistantDraftValidationOutcome,
  attemptsUsed: number,
): boolean {
  if (validationOutcome.applicable) {
    if (validationOutcome.blockingIssues.length === 0) {
      return false;
    }

    return !(attemptsUsed > 1 && hasOnlyRetryExemptAssistantValidationIssues(validationOutcome.blockingIssues));
  }

  return attemptsUsed > 1 && Boolean(validationOutcome.failureReason);
}

function buildValidationErrorKey(filename: string, error: ValidationError): string {
  return [filename, error.severity, error.section, error.param, error.message].join('::');
}

function collectNewValidationErrors(
  baselineValidations: Record<string, ValidationResult>,
  candidateValidations: Record<string, ValidationResult>,
): AssistantDraftValidationIssueGroup[] {
  const baselineCounts = new Map<string, number>();

  Object.entries(baselineValidations).forEach(([filename, result]) => {
    result.errors.forEach((error) => {
      if (!isBlockingAssistantValidationIssue(error)) {
        return;
      }

      const key = buildValidationErrorKey(filename, error);
      baselineCounts.set(key, (baselineCounts.get(key) ?? 0) + 1);
    });
  });

  const blockingByFile = new Map<string, ValidationError[]>();

  Object.entries(candidateValidations)
    .sort(([left], [right]) => left.localeCompare(right))
    .forEach(([filename, result]) => {
      result.errors.forEach((error) => {
        if (!isBlockingAssistantValidationIssue(error)) {
          return;
        }

        const key = buildValidationErrorKey(filename, error);
        const remainingBaselineCount = baselineCounts.get(key) ?? 0;
        if (remainingBaselineCount > 0) {
          baselineCounts.set(key, remainingBaselineCount - 1);
          return;
        }

        const existing = blockingByFile.get(filename);
        if (existing) {
          existing.push(error);
          return;
        }

        blockingByFile.set(filename, [error]);
      });
    });

  return Array.from(blockingByFile.entries()).map(([filename, errors]) => ({ filename, errors }));
}

function formatAssistantDraftValidationIssues(
  blockingIssues: AssistantDraftValidationIssueGroup[],
  failureReason: string | null,
): string {
  const lines: string[] = [];

  if (failureReason) {
    lines.push(`- ${failureReason}`);
  }

  blockingIssues.forEach(({ filename, errors }) => {
    lines.push(`File: ${filename}`);
    errors.forEach((error) => {
      const location = error.param
        ? `[${error.section}] ${error.param}`
        : `[${error.section}]`;
      lines.push(`- ${location}: ${error.message}`);
    });
  });

  return lines.join('\n');
}

function buildAssistantDraftValidationFeedback(
  blockingIssues: AssistantDraftValidationIssueGroup[],
  invalidContent: string,
  failureReason: string | null,
  allowExplanationOnly = false,
): string {
  const formattedIssues = formatAssistantDraftValidationIssues(blockingIssues, failureReason)
    || '- The previous reply did not include a complete applicable cfg draft.';

  return [
    'Your previous assistant reply included cfg changes that failed the app validation after being merged into the current Klipper config project.',
    'Return a corrected replacement reply that fixes every problem below and still satisfies the user request.',
    'If you return config changes, return only complete changed sections inside fenced cfg code blocks and keep any required "# file: <filename>" hint.',
    allowExplanationOnly
      ? 'If the remaining problems are duplicate sections or reused pins and you cannot resolve them safely from the current config, do not return another invalid cfg block. Instead, clearly explain the conflict, mention the exact section or pin involved, and say what must change before a valid config can be produced.'
      : 'Do not ask the user to apply manual fixes for these validation issues.',
    '',
    'Validation problems to fix:',
    formattedIssues,
    '',
    'Previous invalid reply:',
    '````text',
    invalidContent.trim() || 'No content returned.',
    '````',
  ].join('\n');
}

function buildAssistantDraftValidationErrorMessage(
  blockingIssues: AssistantDraftValidationIssueGroup[],
  failureReason: string | null,
  attempts: number,
): string {
  const formattedIssues = formatAssistantDraftValidationIssues(blockingIssues, failureReason);
  const attemptLabel = attempts === 1 ? 'attempt' : 'attempts';

  if (!formattedIssues) {
    return `AI draft failed validation after ${attempts} ${attemptLabel}.`;
  }

  return `AI draft failed validation after ${attempts} ${attemptLabel}.\n${formattedIssues}`;
}

const ChatDialog: React.FC<ChatDialogProps> = ({
  open,
  onClose,
  pendingRequest = null,
  onPendingRequestHandled,
}) => {
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
  const [editProviderModels, setEditProviderModels] = useState(settings.providerModels);
  const [editModel, setEditModel] = useState(() => (
    getProviderModel(settings.apiProvider, settings.providerModels, settings.model, settings.apiProvider)
  ));
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
  const resolvedEditApiUrl = resolveProviderApiUrl(
    editApiProvider,
    editApiUrl,
    editLmStudioHost,
    editLmStudioPort,
    editOllamaHost,
    editOllamaPort,
  );

  const handleModelChange = useCallback((nextModel: string) => {
    setEditModel(nextModel);
    setEditProviderModels((prev) => ({
      ...prev,
      [editApiProvider]: nextModel,
    }));
    // If this provider is local, refresh models
    if (isLocalProvider(editApiProvider)) {
      void fetchAvailableModels(editApiProvider, resolvedEditApiUrl, editApiKey);
    }
  }, [editApiProvider, resolvedEditApiUrl, editApiKey]);

  // Fetch available models from local server
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
      // Use listLocalModels for local providers
      const result = await api.listLocalModels(apiUrl, apiKey, provider);
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

  // Fetch models when local provider settings change
  useEffect(() => {
    if (isLocalProvider(editApiProvider)) {
      void fetchAvailableModels(editApiProvider, resolvedEditApiUrl, editApiKey);
    } else {
      setAvailableModels([]);
    }
  }, [editApiProvider, resolvedEditApiUrl, editApiKey]);

  const handleRefreshModels = useCallback(() => {
    if (isLocalProvider(editApiProvider)) {
      void fetchAvailableModels(editApiProvider, resolvedEditApiUrl, editApiKey);
    }
  }, [editApiProvider, resolvedEditApiUrl, editApiKey]);

  // Sync when settings change
  useEffect(() => {
    if (open) {
      setEditApiKey(settings.apiKey);
      setEditProviderModels(settings.providerModels);
      setEditModel(getProviderModel(
        settings.apiProvider,
        settings.providerModels,
        settings.model,
        settings.apiProvider,
      ));
      setEditApiUrl(settings.apiUrl);
      setEditApiProvider(settings.apiProvider);
      setEditLmStudioHost(settings.lmStudioHost);
      setEditLmStudioPort(settings.lmStudioPort);
      setEditLmStudioMcpPluginId(settings.lmStudioMcpPluginId);
      setEditOllamaHost(settings.ollamaHost);
      setEditOllamaPort(settings.ollamaPort);
      setError(null);
      if (isLocalProvider(settings.apiProvider)) {
        void fetchAvailableModels(
          settings.apiProvider,
          resolveProviderApiUrl(
            settings.apiProvider,
            settings.apiUrl,
            settings.lmStudioHost,
            settings.lmStudioPort,
            settings.ollamaHost,
            settings.ollamaPort,
          ),
          settings.apiKey,
        );
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
  }, [open, messages, activeFile, configFiles, textDrafts]);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const includeFilesMenuRef = useRef<HTMLDivElement>(null);
  const assistantDraftPreviewRequestRef = useRef(0);
  const handledPendingRequestIdRef = useRef<string | null>(null);

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

    const draftText = textDrafts[filename];
    if (typeof draftText === 'string') {
      return draftText;
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
            typeof textDrafts[activeFile] === 'string' && textEditorDirty
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

  const getAssistantMessageHintTexts = (
    content: string,
    messageIndex?: number,
    messageHistory: ChatMessage[] = messages,
  ): string[] => {
    if (messageIndex == null) {
      return [content];
    }

    const hintTexts = [content];
    let collectedUserMessages = 0;

    for (let index = messageIndex - 1; index >= 0; index -= 1) {
      const candidate = messageHistory[index];
      if (candidate?.role === 'user') {
        hintTexts.push(candidate.content);
        collectedUserMessages += 1;
        if (collectedUserMessages >= MAX_ASSISTANT_HINT_USER_MESSAGES) {
          break;
        }
      }
    }

    return hintTexts;
  };

  const flattenAssistantDraftChanges = (filePreviews: AssistantDraftFilePreview[]): AssistantDraftChange[] =>
    filePreviews.flatMap((filePreview) => filePreview.changes);

  const buildAssistantDraftTargetConfigs = async (
    content: string,
    messageIndex?: number,
    messageHistory: ChatMessage[] = messages,
  ): Promise<ConfigFile[]> => {
    const configBlocks = extractConfigCodeBlocks(content);
    if (configBlocks.length === 0) {
      throw new Error('The assistant response did not include a config code block to review.');
    }

    const hintTexts = getAssistantMessageHintTexts(content, messageIndex, messageHistory);
    const mentionedFilenames = extractMentionedConfigFilenames(hintTexts, loadedConfigFilenames);
    const groupedTargets = new Map<string, ConfigFile>();

    for (const configBlock of configBlocks) {
      const { configText, fileHint } = extractAssistantFileHint(configBlock, loadedConfigFilenames);
      if (!configText.trim()) {
        continue;
      }

      const assistantParseFilename = fileHint ?? mentionedFilenames[0] ?? activeFile ?? loadedConfigFilenames[0] ?? 'printer.cfg';
      // Preprocess `*[section_name]` deletion markers before parsing
      const processedConfigText = preprocessDeleteMarkers(configText);
      const assistantResult = await api.parseConfigText(processedConfigText, assistantParseFilename);

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
    messageHistory: ChatMessage[] = messages,
  ): Promise<AssistantDraftPreview> => {
    const assistantConfigs = await buildAssistantDraftTargetConfigs(content, messageIndex, messageHistory);
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
    messageHistory: ChatMessage[] = messages,
  ): Promise<boolean> => {
    try {
      await prepareAssistantDraftPreview(content, messageIndex, messageHistory);
      return true;
    } catch {
      return false;
    }
  };

  const buildCurrentProjectConfigsForValidation = async (): Promise<Record<string, ConfigFile>> => {
    const currentProjectConfigs: Record<string, ConfigFile> = { ...configFiles };
    const draftEntries = Object.entries(textDrafts);

    if (draftEntries.length === 0) {
      return currentProjectConfigs;
    }

    const draftResults = await Promise.all(
      draftEntries.map(async ([filename, draftText]) => {
        const result = await api.parseConfigText(draftText, filename);
        return [filename, draftText, result] as const;
      }),
    );

    draftResults.forEach(([filename, draftText, draftResult]) => {
      currentProjectConfigs[filename] = {
        ...draftResult.config,
        raw_text: draftText,
      };
    });

    return currentProjectConfigs;
  };

  const getAssistantDraftValidationOutcome = async (
    content: string,
    messageIndex?: number,
    messageHistory: ChatMessage[] = messages,
    requireApplicable = false,
  ): Promise<AssistantDraftValidationOutcome> => {
    let preview: AssistantDraftPreview;

    try {
      preview = await prepareAssistantDraftPreview(content, messageIndex, messageHistory);
    } catch (err: unknown) {
      if (!requireApplicable) {
        return {
          applicable: false,
          blockingIssues: [],
          failureReason: null,
        };
      }

      return {
        applicable: false,
        blockingIssues: [],
        failureReason: err instanceof Error
          ? err.message
          : 'The reply did not include a complete applicable cfg draft.',
      };
    }

    const baselineProjectConfigs = await buildCurrentProjectConfigsForValidation();
    preview.filePreviews.forEach((filePreview) => {
      baselineProjectConfigs[filePreview.filename] = filePreview.baseConfig;
    });

    const candidateProjectConfigs = { ...baselineProjectConfigs };
    const mergedConfigs = await Promise.all(
      preview.filePreviews.map(async (filePreview) => {
        const result = await api.parseConfigText(filePreview.mergedText, filePreview.filename);
        return [
          filePreview.filename,
          {
            ...result.config,
            raw_text: filePreview.mergedText,
          },
        ] as const;
      }),
    );

    mergedConfigs.forEach(([filename, config]) => {
      candidateProjectConfigs[filename] = config;
    });

    const [baselineValidations, candidateValidations] = await Promise.all([
      api.validateProject(baselineProjectConfigs),
      api.validateProject(candidateProjectConfigs),
    ]);

    return {
      applicable: true,
      blockingIssues: collectNewValidationErrors(baselineValidations, candidateValidations),
      failureReason: null,
    };
  };

  const requestAssistantMessage = async (
    chatRequestBase: {
      apiKey: string;
      model: string;
      apiUrl: string;
      apiProvider: AiProvider;
      lmStudioMcpPluginId?: string;
    },
    conversationMessages: Array<{ role: api.AiChatRole; content: string }>,
  ): Promise<AssistantReplyAttempt> => {
    const response = await api.aiChat({
      ...chatRequestBase,
      messages: conversationMessages,
    });

    if (response.error) {
      throw new Error(response.error);
    }

    let assistantMessage: ChatMessage = {
      role: 'assistant',
      content: response.content || 'No response.',
      lmStudioMcp: response.lmStudioMcp,
      lmStudioContext: response.lmStudioContext,
      mcpToolNames: response.mcpToolNames,
    };
    let conversationTrail: ChatMessage[] = [{ role: 'assistant', content: assistantMessage.content }];
    let warningMessage: string | null = null;

    const requestedKlipperDocs = extractRequestedKlipperDocFilenames(assistantMessage.content);
    if (requestedKlipperDocs.length === 0) {
      return {
        assistantMessage,
        conversationMessages: conversationTrail,
        warningMessage,
      };
    }

    try {
      const docResults = await Promise.allSettled(
        requestedKlipperDocs.map((filename) => api.getKlipperDoc(filename)),
      );
      const loadedDocs = docResults
        .flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []));

      if (loadedDocs.length === 0) {
        warningMessage = `The assistant requested full Klipper docs (${requestedKlipperDocs.join(', ')}), but none of those bundled markdown files were available from the backend.`;
        return {
          assistantMessage,
          conversationMessages: conversationTrail,
          warningMessage,
        };
      }

      const autoLoadedDocsMessage = buildAutoLoadedKlipperDocMessage(loadedDocs);
      const followUpResponse = await api.aiChat({
        ...chatRequestBase,
        messages: [
          ...conversationMessages,
          ...conversationTrail.map((message) => ({ role: message.role, content: message.content })),
          { role: 'user', content: autoLoadedDocsMessage },
        ],
      });

      if (followUpResponse.error) {
        throw new Error(followUpResponse.error);
      }

      assistantMessage = {
        role: 'assistant',
        content: followUpResponse.content || assistantMessage.content,
        lmStudioMcp: followUpResponse.lmStudioMcp ?? assistantMessage.lmStudioMcp,
        lmStudioContext: followUpResponse.lmStudioContext ?? assistantMessage.lmStudioContext,
        autoLoadedDocs: loadedDocs.map((document) => document.filename),
        mcpToolNames: followUpResponse.mcpToolNames ?? assistantMessage.mcpToolNames,
      };
      conversationTrail = [
        ...conversationTrail,
        { role: 'user', content: autoLoadedDocsMessage },
        { role: 'assistant', content: assistantMessage.content },
      ];
    } catch (autoDocErr: unknown) {
      const autoDocMessage = autoDocErr instanceof Error
        ? autoDocErr.message
        : 'Automatic Klipper doc loading failed.';
      warningMessage = `Automatic full-doc follow-up failed: ${autoDocMessage}`;
    }

    const equalsSeparatedLines = extractEqualsSeparatedConfigLines(assistantMessage.content);
    if (equalsSeparatedLines.length > 0) {
      const rewritePrompt = buildConfigSeparatorRewritePrompt(equalsSeparatedLines);

      try {
        const rewriteResponse = await api.aiChat({
          ...chatRequestBase,
          messages: [
            ...conversationMessages,
            ...conversationTrail.map((message) => ({ role: message.role, content: message.content })),
            { role: 'user', content: rewritePrompt },
          ],
        });

        if (rewriteResponse.error) {
          throw new Error(rewriteResponse.error);
        }

        assistantMessage = {
          role: 'assistant',
          content: rewriteResponse.content || assistantMessage.content,
          lmStudioMcp: rewriteResponse.lmStudioMcp ?? assistantMessage.lmStudioMcp,
          lmStudioContext: rewriteResponse.lmStudioContext ?? assistantMessage.lmStudioContext,
          autoLoadedDocs: assistantMessage.autoLoadedDocs,
          mcpToolNames: rewriteResponse.mcpToolNames ?? assistantMessage.mcpToolNames,
        };
        conversationTrail = [
          ...conversationTrail,
          { role: 'user', content: rewritePrompt },
          { role: 'assistant', content: assistantMessage.content },
        ];

        if (extractEqualsSeparatedConfigLines(assistantMessage.content).length > 0) {
          warningMessage = appendWarningMessage(
            warningMessage,
            'The assistant was asked to rewrite cfg assignments with colons, but the replacement reply still included equals-sign separators.',
          );
        }
      } catch (rewriteErr: unknown) {
        const rewriteMessage = rewriteErr instanceof Error
          ? rewriteErr.message
          : 'Automatic cfg separator rewrite failed.';
        warningMessage = appendWarningMessage(
          warningMessage,
          `Automatic cfg separator rewrite failed: ${rewriteMessage}`,
        );
      }
    }

    return {
      assistantMessage,
      conversationMessages: conversationTrail,
      warningMessage,
    };
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

      touchedFiles.forEach((filename) => clearTextDraft(filename));
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

  const submitMessage = useCallback(async (messageText: string, options?: SubmitMessageOptions) => {
    const trimmedMessage = messageText.trim();
    if (!trimmedMessage || loading) {
      return;
    }

    const userMsg: ChatMessage = {
      role: 'user',
      content: trimmedMessage,
      hiddenFromUser: options?.hiddenFromUser === true,
    };
    // Hidden (auto-submitted) requests start a fresh session so stale history from
    // prior sessions doesn't interfere with draft applicability checks.
    const previousMessages = options?.hiddenFromUser ? [] : messages;
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
        apiUrl: resolvedEditApiUrl,
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
          content: `If the user asks you to modify ${activeFile}, or does not name a different config file, return only the changed, new, or deleted sections for ${activeFile} inside a single fenced code block labeled cfg. Include full section headers and the full contents of each changed section. To COMMENT OUT / DISABLE a section, include its header commented out with existing params: #[extruder]. To DELETE a section entirely (remove from file), write *[section_name] on its own line inside the cfg block — the * before the bracket tells the app to remove that section. Do NOT use # for deletions: # means comment out, * means delete. Example: *[extruder]. You can mix deletion markers with normal sections in the same cfg block. If a different loaded config file is clearly requested, target that file instead and start that cfg block with a first comment line exactly like "# file: <filename>". If changes span multiple files, return one separate fenced cfg block per file. Do not return the entire file unless the user explicitly asks for a full replacement.`,
        });
      }

      let requestConversation: Array<{ role: api.AiChatRole; content: string }> = [
        ...contextMessages,
        ...newMessages.map((message) => ({ role: message.role, content: message.content })),
      ];
      let validationConversation: ChatMessage[] = [...newMessages];
      let assistantAttempt = await requestAssistantMessage(chatRequestBase, requestConversation);
      let pendingWarningMessage = assistantAttempt.warningMessage;
      let candidateConversation = [...validationConversation, ...assistantAttempt.conversationMessages];
      let validationOutcome = await getAssistantDraftValidationOutcome(
        assistantAttempt.assistantMessage.content,
        candidateConversation.length - 1,
        candidateConversation,
        false,
      );
      let attemptsUsed = 1;

      while (shouldRetryAssistantValidation(validationOutcome, attemptsUsed)) {
        if (attemptsUsed >= MAX_ASSISTANT_DRAFT_VALIDATION_ATTEMPTS) {
          throw new Error(
            buildAssistantDraftValidationErrorMessage(
              validationOutcome.blockingIssues,
              validationOutcome.failureReason,
              attemptsUsed,
            ),
          );
        }

        const allowExplanationOnly = hasOnlyRetryExemptAssistantValidationIssues(validationOutcome.blockingIssues);

        const validationFeedback = buildAssistantDraftValidationFeedback(
          validationOutcome.blockingIssues,
          assistantAttempt.assistantMessage.content,
          validationOutcome.failureReason,
          allowExplanationOnly,
        );

        requestConversation = [
          ...requestConversation,
          ...assistantAttempt.conversationMessages.map((message) => ({ role: message.role, content: message.content })),
          { role: 'user', content: validationFeedback },
        ];
        validationConversation = [...candidateConversation, { role: 'user', content: validationFeedback }];
        assistantAttempt = await requestAssistantMessage(chatRequestBase, requestConversation);
        pendingWarningMessage = assistantAttempt.warningMessage ?? pendingWarningMessage;
        candidateConversation = [...validationConversation, ...assistantAttempt.conversationMessages];
        attemptsUsed += 1;
        validationOutcome = await getAssistantDraftValidationOutcome(
          assistantAttempt.assistantMessage.content,
          candidateConversation.length - 1,
          candidateConversation,
          !allowExplanationOnly,
        );
      }

      if (
        validationOutcome.applicable
        && validationOutcome.blockingIssues.length > 0
        && hasOnlyRetryExemptAssistantValidationIssues(validationOutcome.blockingIssues)
      ) {
        const advisoryWarning = [
          `AI draft still has duplicate section or pin-conflict validation issues after ${attemptsUsed} attempts. The assistant response was returned so it can explain the conflict.`,
          formatAssistantDraftValidationIssues(validationOutcome.blockingIssues, null),
        ].join('\n');
        pendingWarningMessage = pendingWarningMessage
          ? `${pendingWarningMessage}\n${advisoryWarning}`
          : advisoryWarning;
      }

      if (!validationOutcome.applicable && validationOutcome.failureReason) {
        throw new Error(
          buildAssistantDraftValidationErrorMessage(
            validationOutcome.blockingIssues,
            validationOutcome.failureReason,
            attemptsUsed,
          ),
        );
      }

      if (pendingWarningMessage) {
        setError(pendingWarningMessage);
      }

      setMessages([...newMessages, assistantAttempt.assistantMessage]);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to get response.';
      setError(message);
      // Remove the user message that failed so it doesn't pollute history
      setMessages(previousMessages);
    } finally {
      setLoading(false);
    }
  }, [
    activeFile,
    attachedConfigFiles,
    clearMessages,
    configFiles,
    editApiKey,
    editApiProvider,
    editLmStudioMcpPluginId,
    editModel,
    getAssistantDraftValidationOutcome,
    getConfigContexts,
    inputRef,
    loadedConfigFilenames,
    loading,
    messages,
    requestAssistantMessage,
    resolvedEditApiUrl,
    selectedConfigContextFiles,
    setMessages,
  ]);

  const handleSend = () => {
    void submitMessage(input);
  };

  useEffect(() => {
    if (!open || !pendingRequest || loading || !isConfigured()) {
      return;
    }

    if (handledPendingRequestIdRef.current === pendingRequest.id) {
      return;
    }

    handledPendingRequestIdRef.current = pendingRequest.id;
    onPendingRequestHandled?.();
    void submitMessage(pendingRequest.prompt, { hiddenFromUser: pendingRequest.hiddenFromUser });
  }, [isConfigured, loading, onPendingRequestHandled, open, pendingRequest, submitMessage]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleSaveSettings = () => {
    const nextModel = editModel.trim();
    const hadEnabledChat = isConfigured();
    const nextProviderModels = {
      ...editProviderModels,
      [editApiProvider]: nextModel,
    };
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
    if (isLocalProvider(editApiProvider)) {
      // Fetch models after saving, so we have the correct URL
      void fetchAvailableModels(editApiProvider, resolvedEditApiUrl, editApiKey);
    }
    if (!nextModel && !hadEnabledChat) {
      onClose();
      return;
    }
    setShowSettings(false);
  };

  const hasSelectedModel = !!editModel.trim();

  // Compute whether the save button should be enabled.
  // Local providers (LM Studio, Ollama, OpenAI Compatible) don't require a key.
  const isSaveEnabled = !providerRequiresApiKey(editApiProvider) || !!editApiKey.trim();

  // Update URL when provider changes
  const handleProviderChange = (provider: AiProvider) => {
    const nextProviderModels = {
      ...editProviderModels,
      [editApiProvider]: editModel,
    };

    setEditProviderModels(nextProviderModels);
    setEditApiProvider(provider);
    // Use the provider's default model if the current model is empty
    const providerDefaultModel = PROVIDER_DEFAULTS[provider]?.defaultModel;
    const modelToUse = editModel.trim() || providerDefaultModel || settings.model;
    setEditModel(modelToUse);
    const defaults = PROVIDER_DEFAULTS[provider];
    if (!isLocalProvider(provider)) {
      setEditApiUrl(defaults.defaultUrl);
    }
  };

  // Unconfigured state — show settings panel in the center
  if (!isConfigured()) {
    const showLocalFields = isLocalProvider(editApiProvider);
    const showLmStudioMcpField = editApiProvider === 'lm-studio';

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
                <div className="flex gap-2">
                  <input
                    type="text"
                    className="flex-1 px-3 py-2 rounded-lg text-xs font-mono bg-[var(--color-bg-primary)] border border-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none transition-colors"
                    value={editModel}
                    onChange={(e) => handleModelChange(e.target.value)}
                    placeholder="e.g. gpt-4o, llama3.1, phi3"
                  />
                  {isLocalProvider(editApiProvider) && (
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
              </div>

              {!showLocalFields && (
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
              )}

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
                        if (editApiProvider === 'lm-studio') setEditLmStudioHost(newHost);
                        else setEditOllamaHost(newHost);
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
                        if (editApiProvider === 'lm-studio') setEditLmStudioPort(newPort);
                        else setEditOllamaPort(newPort);
                      }}
                      placeholder="1234"
                    />
                  </div>
                </div>
              )}

              {showLocalFields && (
                <p className="text-[10px] text-[var(--color-text-secondary)]">
                  Chat requests use {resolvedEditApiUrl} and model discovery uses the same host and port.
                </p>
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

              {/* API Key (only shown for providers that require it) */}
              {providerRequiresApiKey(editApiProvider) && (
                <div>
                  <label className="block text-[10px] font-semibold text-[var(--color-text-secondary)] uppercase tracking-wider mb-1.5">
                    API Key
                  </label>
                  <input
                    type="password"
                    className="w-full px-3 py-2 rounded-lg text-xs font-mono bg-[var(--color-bg-primary)] border border-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none transition-colors"
                    value={editApiKey}
                    onChange={(e) => setEditApiKey(e.target.value)}
                    placeholder="sk-..."
                  />
                  <p className="text-[10px] text-[var(--color-text-secondary)] mt-1">
                    Your API key is stored only in your browser
                  </p>
                </div>
              )}
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
              {hasSelectedModel ? 'Save & Enable Chat' : 'Save Settings'}
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
                <div>
                  <label className="block text-[10px] text-[var(--color-text-secondary)] mb-1">Model</label>
                  {isLocalProvider(editApiProvider) ? (
                    <div className="flex gap-2">
                      {availableModels.length > 0 ? (
                        <select
                          className="flex-1 px-3 py-1.5 rounded text-xs font-mono bg-[var(--color-bg-secondary)] border border-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none transition-colors"
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
                          className="flex-1 px-3 py-1.5 rounded text-xs font-mono bg-[var(--color-bg-secondary)] border border-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none transition-colors"
                          value={editModel}
                          onChange={(e) => handleModelChange(e.target.value)}
                          placeholder="Model name"
                        />
                      )}
                      <button
                        type="button"
                        onClick={() => {
                          void fetchAvailableModels(editApiProvider, resolvedEditApiUrl, editApiKey);
                        }}
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
                {isLocalProvider(editApiProvider) && modelsLoading && (
                  <p className="text-[10px] text-[var(--color-text-secondary)]">Loading models...</p>
                )}
                {modelsError && (
                  <p className="text-[10px] text-[var(--color-error)]">Error: {modelsError}</p>
                )}
                {!isLocalProvider(editApiProvider) && (
                  <div>
                    <label className="block text-[10px] text-[var(--color-text-secondary)] mb-1">API URL</label>
                    <input
                      type="text"
                      className="w-full px-3 py-1.5 rounded text-xs font-mono bg-[var(--color-bg-secondary)] border border-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none transition-colors"
                      value={editApiUrl}
                      onChange={(e) => setEditApiUrl(e.target.value)}
                    />
                  </div>
                )}
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
                          if (editApiProvider === 'lm-studio') setEditLmStudioHost(newHost);
                          else setEditOllamaHost(newHost);
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
                          if (editApiProvider === 'lm-studio') setEditLmStudioPort(newPort);
                          else setEditOllamaPort(newPort);
                        }}
                        placeholder="1234"
                      />
                    </div>
                  </div>
                )}
                {isLocalProvider(editApiProvider) && (
                  <p className="text-[10px] text-[var(--color-text-secondary)]">
                    Chat requests use {resolvedEditApiUrl} and model discovery uses the same host and port.
                  </p>
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
                {/* API Key (only shown for providers that require it) */}
                {providerRequiresApiKey(editApiProvider) && (
                  <div>
                    <label className="block text-[10px] text-[var(--color-text-secondary)] mb-1">API Key</label>
                    <input
                      type="password"
                      className="w-full px-3 py-1.5 rounded text-xs font-mono bg-[var(--color-bg-secondary)] border border-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none transition-colors"
                      value={editApiKey}
                      onChange={(e) => setEditApiKey(e.target.value)}
                      placeholder="sk-..."
                    />
                  </div>
                )}
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
              if (msg.role === 'user' && msg.hiddenFromUser) {
                return null;
              }
              const assistantConfigBlock = msg.role === 'assistant' ? extractConfigCodeBlock(msg.content) : null;
              const hasApplicableAssistantDraft = assistantDraftApplicableMessages[i] === true;
              const lmStudioMcpStatus = msg.role === 'assistant' ? msg.lmStudioMcp : undefined;
              const lmStudioContextStatus = msg.role === 'assistant' ? msg.lmStudioContext : undefined;
              const lmStudioMcpPresentation = lmStudioMcpStatus ? getLmStudioMcpStatusPresentation(lmStudioMcpStatus) : null;
              const lmStudioContextPresentation = lmStudioContextStatus ? getLmStudioContextPresentation(lmStudioContextStatus) : null;
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
                        remarkPlugins={[remarkMath, remarkGfm]}
                        rehypePlugins={[rehypeKatex]}
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
                          code: MarkdownCode,
                        }}
                      >
                        {msg.content}
                      </ReactMarkdown>
                    ) : (
                      <div style={{ whiteSpace: 'pre-wrap' }}>{msg.content}</div>
                    )}
                    {msg.role === 'assistant' && (lmStudioMcpPresentation || lmStudioContextPresentation) && (
                      <div className="mt-3 flex flex-wrap gap-2">
                        {lmStudioMcpPresentation && (
                          <span
                            className={`inline-flex items-center rounded-full border px-2 py-1 text-[10px] font-medium ${lmStudioMcpPresentation.className}`}
                            title={lmStudioMcpPresentation.title}
                          >
                            {lmStudioMcpPresentation.label}
                          </span>
                        )}
                        {lmStudioContextPresentation && (
                          <span
                            className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-1 text-[10px] font-medium ${lmStudioContextPresentation.className}`}
                            title={lmStudioContextPresentation.title}
                          >
                            <span className="relative h-3 w-3 shrink-0 rounded-full" aria-hidden="true">
                              <span className="absolute inset-0 rounded-full bg-current opacity-15" />
                              {lmStudioContextPresentation.fillRatio !== null && lmStudioContextPresentation.fillRatio > 0 && (
                                <span
                                  className="absolute inset-0 rounded-full"
                                  style={{
                                    background: `conic-gradient(currentColor ${Math.max(lmStudioContextPresentation.fillRatio * 360, 6)}deg, transparent 0deg)`,
                                  }}
                                />
                              )}
                            </span>
                            {lmStudioContextPresentation.label}
                          </span>
                        )}
                      </div>
                    )}
                    {msg.role === 'assistant' && Array.isArray(msg.mcpToolNames) && msg.mcpToolNames.length > 0 && (
                      <div className="mt-3 flex flex-wrap gap-2">
                        <span
                          className="inline-flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 text-[10px] font-medium text-emerald-300"
                          title={`The assistant used MCP tools from the application to answer this: ${msg.mcpToolNames.join(', ')}`}
                        >
                          <svg width="10" height="10" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                            <path d="M8 1V3M8 13V15M3 8H1M15 8H13M4.5 4.5L3 3M12.5 12.5L14 14M4.5 12.5L3 14M12.5 4.5L14 3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
                            <circle cx="8" cy="8" r="2.5" stroke="currentColor" strokeWidth="1.3"/>
                          </svg>
                          Tools: {msg.mcpToolNames.join(', ')}
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
