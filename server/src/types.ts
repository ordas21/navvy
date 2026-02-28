// WebSocket message types between extension and server

export type Mode = 'auto' | 'screenshot' | 'dom' | 'accessibility' | 'network' | 'console';

export interface ClientMessage {
  type: 'prompt' | 'cancel' | 'ping' | 'approval_response' | 'checkpoint_resume';
  sessionId: string;
  prompt?: string;
  attachments?: Attachment[];
  mode?: Mode;
  // Approval response fields
  approvalId?: string;
  approvalResponse?: 'approve' | 'deny' | 'approve_always';
  toolName?: string;
  // Checkpoint resume fields
  checkpointId?: string;
}

export interface Attachment {
  type: 'file' | 'page_context';
  name: string;
  mimeType: string;
  /** base64 data for files, or text content for page context */
  data: string;
}

export interface ApprovalRequestData {
  id: string;
  toolName: string;
  toolInput: string;
  trustLevel: string;
  reason: string;
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
    | 'pong'
    | 'approval_request'
    | 'checkpoint_created'
    | 'scheduled_task_update';
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
  approval?: ApprovalRequestData;
  checkpoint?: { id: string; stepIndex: number; description: string };
  scheduledTask?: { id: string; name: string; status: string; lastResult?: string };
}

export interface CostInfo {
  totalCostUsd: number;
  inputTokens: number;
  outputTokens: number;
  numTurns: number;
  durationMs: number;
}
