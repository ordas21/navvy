// WebSocket message types between extension and server

export interface ClientMessage {
  type: 'prompt' | 'cancel' | 'ping';
  sessionId: string;
  prompt?: string;
  attachments?: Attachment[];
}

export interface Attachment {
  type: 'file' | 'page_context';
  name: string;
  mimeType: string;
  /** base64 data for files, or text content for page context */
  data: string;
}

export interface ServerMessage {
  type:
    | 'text_delta'
    | 'thinking_delta'
    | 'tool_use_start'
    | 'tool_use_input_delta'
    | 'tool_use_done'
    | 'tool_result'
    | 'turn_complete'
    | 'done'
    | 'error'
    | 'status'
    | 'cost'
    | 'pong';
  sessionId: string;
  text?: string;
  thinking?: string;
  toolName?: string;
  toolId?: string;
  toolInput?: string;
  toolResult?: string;
  error?: string;
  status?: string;
  cost?: CostInfo;
}

export interface CostInfo {
  totalCostUsd: number;
  inputTokens: number;
  outputTokens: number;
  numTurns: number;
  durationMs: number;
}
