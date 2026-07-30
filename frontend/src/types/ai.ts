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
  hiddenFromUser?: boolean;
}
