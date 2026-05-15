export interface LmStudioMcpStatus {
  requested: boolean;
  pluginId: string | null;
  route: 'api-v1-chat' | 'openai-compatible';
  toolUsed: boolean;
  toolNames: string[];
  fallbackUsed: boolean;
  fallbackReason: string | null;
}

export interface LmStudioContextStatus {
  requestChars: number;
  truncated: boolean;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  estimatedPromptTokens: number | null;
  contextWindow: number | null;
  usedTokens: number | null;
  utilization: number | null;
}

export interface PendingAiChatRequest {
  id: string;
  prompt: string;
}