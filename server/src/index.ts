import express from 'express';
import { createServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import path from 'node:path';
import os from 'node:os';
import { ChildProcess } from 'node:child_process';
import { runClaude } from './claude.js';
import type { ClientMessage, ServerMessage } from './types.js';

const PORT = Number(process.env.PORT) || 3300;
const UPLOAD_DIR = path.join(os.tmpdir(), 'claude-browser-agent-uploads');

const app = express();
app.use(express.json());

// File upload endpoint
const upload = multer({ dest: UPLOAD_DIR });
app.post('/upload', upload.single('file'), (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: 'No file provided' });
    return;
  }
  res.json({
    id: uuidv4(),
    filename: req.file.originalname,
    path: req.file.path,
    mimeType: req.file.mimetype,
    size: req.file.size,
  });
});

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

// Track active Claude processes per session
const activeSessions = new Map<string, ChildProcess>();

wss.on('connection', (ws: WebSocket) => {
  console.log('[ws] Client connected');

  ws.on('message', (data) => {
    try {
      const msg: ClientMessage = JSON.parse(data.toString());
      handleMessage(ws, msg);
    } catch (err) {
      sendMessage(ws, {
        type: 'error',
        sessionId: '',
        error: `Invalid message: ${err}`,
      });
    }
  });

  ws.on('close', () => {
    console.log('[ws] Client disconnected');
  });
});

function handleMessage(ws: WebSocket, msg: ClientMessage): void {
  switch (msg.type) {
    case 'prompt':
      handlePrompt(ws, msg);
      break;
    case 'cancel':
      handleCancel(msg.sessionId);
      break;
    case 'ping':
      sendMessage(ws, { type: 'pong', sessionId: msg.sessionId });
      break;
  }
}

function handlePrompt(ws: WebSocket, msg: ClientMessage): void {
  const sessionId = msg.sessionId;

  // Kill any existing process for this session
  handleCancel(sessionId);

  let prompt = msg.prompt ?? '';

  // Attach file context if provided
  if (msg.attachments?.length) {
    const attachmentText = msg.attachments
      .map((a) => {
        if (a.type === 'page_context') {
          return `\n[Current page context]\n${a.data}`;
        }
        return `\n[Attached file: ${a.name} (${a.mimeType})]`;
      })
      .join('\n');
    prompt += attachmentText;
  }

  sendMessage(ws, { type: 'status', sessionId, status: 'thinking' });

  const proc = runClaude(prompt, {
    onText: (text) => {
      sendMessage(ws, { type: 'assistant_text', sessionId, text });
    },
    onToolUse: (toolName, toolInput) => {
      sendMessage(ws, { type: 'tool_use', sessionId, toolName, toolInput });
    },
    onToolResult: (text) => {
      sendMessage(ws, { type: 'tool_result', sessionId, toolResult: text });
    },
    onDone: (_fullText) => {
      sendMessage(ws, { type: 'done', sessionId });
      activeSessions.delete(sessionId);
    },
    onError: (error) => {
      sendMessage(ws, { type: 'error', sessionId, error });
      activeSessions.delete(sessionId);
    },
  });

  activeSessions.set(sessionId, proc);
}

function handleCancel(sessionId: string): void {
  const proc = activeSessions.get(sessionId);
  if (proc) {
    proc.kill('SIGTERM');
    activeSessions.delete(sessionId);
    console.log(`[session ${sessionId}] Cancelled`);
  }
}

function sendMessage(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

httpServer.listen(PORT, () => {
  console.log(`Claude Browser Agent server running on http://localhost:${PORT}`);
  console.log(`WebSocket endpoint: ws://localhost:${PORT}/ws`);
});
