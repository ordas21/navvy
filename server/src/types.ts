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
  type: 'assistant_text' | 'tool_use' | 'tool_result' | 'done' | 'error' | 'status' | 'pong';
  sessionId: string;
  text?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolResult?: string;
  error?: string;
  status?: string;
}
