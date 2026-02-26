import express from 'express';
import { createServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { ChildProcess } from 'node:child_process';
import { runClaude } from './claude.js';
import type { ClientMessage, ServerMessage, Mode } from './types.js';

const PORT = Number(process.env.PORT) || 3300;
const UPLOAD_DIR = path.join(os.tmpdir(), 'navvy-uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

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
  const mode: Mode = msg.mode ?? 'auto';

  // Kill any existing process for this session
  handleCancel(sessionId);

  let prompt = msg.prompt ?? '';

  // Attach file context if provided
  const attachmentPaths: string[] = [];
  if (msg.attachments?.length) {
    const attachmentText = msg.attachments
      .map((a) => {
        if (a.type === 'page_context') {
          return `\n[Current page context]\n${a.data}`;
        }
        // Write file data to disk so Claude CLI can read it
        if (a.data) {
          const safeName = a.name.replace(/[^a-zA-Z0-9._-]/g, '_');
          const filePath = path.join(UPLOAD_DIR, `${uuidv4()}-${safeName}`);
          fs.writeFileSync(filePath, Buffer.from(a.data, 'base64'));
          attachmentPaths.push(filePath);
          console.log(`[session ${sessionId}] Saved attachment: ${a.name} → ${filePath}`);
          return `\n[Attached file: ${a.name} — saved to ${filePath}. Use the Read tool to read this file.]`;
        }
        return `\n[Attached file: ${a.name} (${a.mimeType})]`;
      })
      .join('\n');
    prompt += attachmentText;
  }

  console.log(`[session ${sessionId}] Mode: ${mode}`);
  console.log(`[session ${sessionId}] Prompt: ${prompt.substring(0, 100)}...`);
  sendMessage(ws, { type: 'status', sessionId, status: `Starting (${mode} mode)...` });

  const proc = runClaude(prompt, mode, (partialMsg) => {
    sendMessage(ws, { ...partialMsg, sessionId });

    if (partialMsg.type === 'done') {
      activeSessions.delete(sessionId);
    }
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
    if (msg.type !== 'pong' && msg.type !== 'text_delta' && msg.type !== 'thinking_delta' && msg.type !== 'tool_use_input_delta') {
      console.log(`[ws:send] ${msg.type}${msg.status ? ': ' + msg.status : ''}${msg.toolName ? ': ' + msg.toolName : ''}`);
    }
    ws.send(JSON.stringify(msg));
  }
}

httpServer.listen(PORT, () => {
  console.log(`Navvy server running on http://localhost:${PORT}`);
  console.log(`WebSocket endpoint: ws://localhost:${PORT}/ws`);
});
