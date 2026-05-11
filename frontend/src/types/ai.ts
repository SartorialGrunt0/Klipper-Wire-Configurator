export interface LmStudioMcpStatus {
  requested: boolean;
  pluginId: string | null;
  route: 'api-v1-chat' | 'openai-compatible';
  toolUsed: boolean;
  toolNames: string[];
  fallbackUsed: boolean;
  fallbackReason: string | null;
}