import express from 'express';
import { createServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { ChildProcess } from 'node:child_process';
import { runClaude, selectModel, cleanupStaleProcesses } from './claude.js';
import type { ClientMessage, ServerMessage, Mode } from './types.js';
import {
  checkApproval, createApprovalRequest, waitForApproval, resolveApproval,
  loadPolicies, savePolicies,
} from './approval.js';
import { findMacro, createMacro, listMacros, getMacro, updateMacro, deleteMacro, incrementMacroUseCount } from './macros.js';
import { getCheckpoints, getCheckpointSession, buildResumePrompt, listCheckpointSessions } from './checkpoints.js';
import {
  listWorkflows, getWorkflow, deleteWorkflow, createWorkflow, recordFromSession,
} from './workflows.js';
import { replayWorkflow } from './replay-engine.js';
import {
  createTask, listTasks, getTask, pauseTask, resumeTask, deleteTask,
  getTaskHistory, startScheduler, parseNaturalSchedule,
} from './scheduler.js';
import { executeScheduledTask } from './task-runner.js';
import { getDb, closeDb } from './db.js';
import { authMiddleware, validateWsApiKey, generateApiKey, listApiKeys, revokeApiKey, hasAnyApiKeys } from './auth.js';

const PORT = Number(process.env.PORT) || 3300;
const UPLOAD_DIR = path.join(os.tmpdir(), 'navvy-uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const app = express();
app.use(express.json());

// Initialize database on startup
getDb();

// Clean up any stale process records from previous runs
cleanupStaleProcesses();

// --- Setup endpoint (no auth required) ---

app.post('/api/setup/key', (_req, res) => {
  if (hasAnyApiKeys()) {
    res.status(403).json({ error: 'API keys already exist. Use an authenticated endpoint to create more.' });
    return;
  }
  const { key, record } = generateApiKey('default');
  res.json({ key, ...record });
});

// --- Auth middleware for all /api routes except setup ---

app.use('/api', (req, res, next) => {
  if (req.path.startsWith('/setup/')) {
    next();
    return;
  }
  authMiddleware(req, res, next);
});

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

// ---- API Key Management ----

app.post('/api/keys', (_req, res) => {
  const name = (_req.body?.name as string) || 'unnamed';
  const { key, record } = generateApiKey(name);
  res.json({ key, ...record });
});

app.get('/api/keys', (_req, res) => {
  res.json(listApiKeys());
});

app.delete('/api/keys/:id', (req, res) => {
  const ok = revokeApiKey(req.params.id);
  if (!ok) {
    res.status(404).json({ error: 'Key not found' });
    return;
  }
  res.json({ ok: true });
});

// ---- Conversation Endpoints ----

app.post('/api/conversations', (req, res) => {
  const db = getDb();
  const id = `conv-${uuidv4().substring(0, 12)}`;
  const now = Date.now();
  const url = req.body?.url || '';
  const title = req.body?.title || 'New Conversation';

  db.prepare(`
    INSERT INTO conversations (id, title, url, created_at, updated_at, message_count, preview_text)
    VALUES (?, ?, ?, ?, ?, 0, '')
  `).run(id, title, url, now, now);

  res.json({ id, title, url, createdAt: now, updatedAt: now, messageCount: 0, previewText: '' });
});

app.get('/api/conversations', (req, res) => {
  const db = getDb();
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const offset = Number(req.query.offset) || 0;

  const rows = db.prepare('SELECT * FROM conversations ORDER BY updated_at DESC LIMIT ? OFFSET ?').all(limit, offset) as Array<{
    id: string; title: string; url: string; created_at: number; updated_at: number; message_count: number; preview_text: string;
  }>;

  const total = (db.prepare('SELECT COUNT(*) as c FROM conversations').get() as { c: number }).c;

  res.json({
    conversations: rows.map((r) => ({
      id: r.id,
      title: r.title,
      url: r.url,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      messageCount: r.message_count,
      previewText: r.preview_text,
    })),
    total,
    limit,
    offset,
  });
});

app.get('/api/conversations/:id', (req, res) => {
  const db = getDb();
  const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(req.params.id) as {
    id: string; title: string; url: string; created_at: number; updated_at: number; message_count: number; preview_text: string;
  } | undefined;

  if (!conv) {
    res.status(404).json({ error: 'Conversation not found' });
    return;
  }

  const messages = db.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC').all(req.params.id) as Array<{
    id: number; conversation_id: string; type: string; text: string; data: string | null; created_at: number;
  }>;

  res.json({
    id: conv.id,
    title: conv.title,
    url: conv.url,
    createdAt: conv.created_at,
    updatedAt: conv.updated_at,
    messageCount: conv.message_count,
    previewText: conv.preview_text,
    messages: messages.map((m) => ({
      id: m.id,
      type: m.type,
      text: m.text,
      data: m.data ? JSON.parse(m.data) : undefined,
      createdAt: m.created_at,
    })),
  });
});

app.put('/api/conversations/:id', (req, res) => {
  const db = getDb();
  const { title } = req.body;

  const result = db.prepare('UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?')
    .run(title, Date.now(), req.params.id);

  if (result.changes === 0) {
    res.status(404).json({ error: 'Conversation not found' });
    return;
  }

  res.json({ ok: true });
});

app.delete('/api/conversations/:id', (req, res) => {
  const db = getDb();
  const result = db.prepare('DELETE FROM conversations WHERE id = ?').run(req.params.id);
  if (result.changes === 0) {
    res.status(404).json({ error: 'Conversation not found' });
    return;
  }
  res.json({ ok: true });
});

app.post('/api/conversations/:id/messages', (req, res) => {
  const db = getDb();
  const { type, text, data } = req.body;
  if (!type) {
    res.status(400).json({ error: 'type is required' });
    return;
  }

  const conv = db.prepare('SELECT id FROM conversations WHERE id = ?').get(req.params.id);
  if (!conv) {
    res.status(404).json({ error: 'Conversation not found' });
    return;
  }

  const now = Date.now();
  const result = db.prepare(`
    INSERT INTO messages (conversation_id, type, text, data, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(req.params.id, type, text || '', data ? JSON.stringify(data) : null, now);

  // Update conversation metadata
  const updates: Record<string, unknown> = { updated_at: now };
  const msgCount = (db.prepare('SELECT COUNT(*) as c FROM messages WHERE conversation_id = ?').get(req.params.id) as { c: number }).c;
  updates.message_count = msgCount;

  if (type === 'user' && text) {
    updates.preview_text = text.substring(0, 80);

    // Auto-title from first user message
    const conv = db.prepare('SELECT title FROM conversations WHERE id = ?').get(req.params.id) as { title: string };
    if (conv.title === 'New Conversation') {
      updates.title = text.substring(0, 50) || 'New Conversation';
    }
  }

  const setClauses = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  db.prepare(`UPDATE conversations SET ${setClauses} WHERE id = ?`).run(...Object.values(updates), req.params.id);

  res.json({ id: result.lastInsertRowid, type, text, createdAt: now });
});

// ---- Approval Endpoints ----

app.post('/api/approval/request', async (req, res) => {
  const { toolName, toolInput } = req.body;
  if (!toolName) {
    res.status(400).json({ error: 'toolName is required' });
    return;
  }

  const check = checkApproval(toolName, toolInput || '');
  if (!check) {
    res.json({ approved: true });
    return;
  }

  const request = createApprovalRequest('mcp', toolName, toolInput || '', check.trustLevel, check.reason);

  // Send approval request to all clients subscribed to the relevant session
  broadcastToAll({
    type: 'approval_request',
    sessionId: 'mcp',
    approval: {
      id: request.id,
      toolName: request.toolName,
      toolInput: request.toolInput,
      trustLevel: request.trustLevel,
      reason: request.reason,
    },
  });

  const approved = await waitForApproval(request.id);
  res.json({ approved });
});

app.get('/api/approval/policies', (_req, res) => {
  res.json(loadPolicies());
});

app.put('/api/approval/policies', (req, res) => {
  const store = req.body;
  if (!store || !Array.isArray(store.policies)) {
    res.status(400).json({ error: 'Invalid policy store format' });
    return;
  }
  savePolicies(store);
  res.json({ ok: true });
});

// ---- Macro Endpoints ----

app.get('/api/macros', (_req, res) => {
  res.json(listMacros());
});

app.post('/api/macros', (req, res) => {
  const { name, steps, aliases, mode } = req.body;
  if (!name || !steps) {
    res.status(400).json({ error: 'name and steps are required' });
    return;
  }
  const macro = createMacro(name, steps, aliases, mode);
  res.json(macro);
});

app.put('/api/macros/:id', (req, res) => {
  const macro = updateMacro(req.params.id, req.body);
  if (!macro) {
    res.status(404).json({ error: 'Macro not found' });
    return;
  }
  res.json(macro);
});

app.delete('/api/macros/:id', (req, res) => {
  const deleted = deleteMacro(req.params.id);
  if (!deleted) {
    res.status(404).json({ error: 'Macro not found' });
    return;
  }
  res.json({ ok: true });
});

// ---- Checkpoint Endpoints ----

app.get('/api/checkpoints', (_req, res) => {
  res.json(listCheckpointSessions());
});

app.get('/api/checkpoints/:sessionId', (req, res) => {
  const checkpoints = getCheckpoints(req.params.sessionId);
  res.json(checkpoints);
});

app.post('/api/checkpoints/:sessionId/resume/:checkpointId', (req, res) => {
  const prompt = buildResumePrompt(req.params.sessionId, req.params.checkpointId);
  if (!prompt) {
    res.status(404).json({ error: 'Checkpoint not found' });
    return;
  }
  res.json({ prompt });
});

// ---- Workflow Endpoints ----

app.get('/api/workflows', (_req, res) => {
  res.json(listWorkflows());
});

app.get('/api/workflows/:id', (req, res) => {
  const workflow = getWorkflow(req.params.id);
  if (!workflow) {
    res.status(404).json({ error: 'Workflow not found' });
    return;
  }
  res.json(workflow);
});

app.post('/api/workflows', (req, res) => {
  const { name, steps, variables, tags } = req.body;
  if (!name || !steps) {
    res.status(400).json({ error: 'name and steps are required' });
    return;
  }
  const workflow = createWorkflow(name, steps, variables, tags);
  res.json(workflow);
});

app.post('/api/workflows/record/:sessionId', (req, res) => {
  const { name, tags } = req.body;
  if (!name) {
    res.status(400).json({ error: 'name is required' });
    return;
  }
  const workflow = recordFromSession(req.params.sessionId, name, tags);
  if (!workflow) {
    res.status(404).json({ error: 'Session not found or has no recorded actions' });
    return;
  }
  res.json(workflow);
});

app.delete('/api/workflows/:id', (req, res) => {
  const deleted = deleteWorkflow(req.params.id);
  if (!deleted) {
    res.status(404).json({ error: 'Workflow not found' });
    return;
  }
  res.json({ ok: true });
});

// ---- Schedule Endpoints ----

app.get('/api/schedules', (_req, res) => {
  res.json(listTasks());
});

app.post('/api/schedules', (req, res) => {
  const { name, prompt, schedule, scheduleText, mode } = req.body;
  if (!name || !prompt) {
    res.status(400).json({ error: 'name and prompt are required' });
    return;
  }

  let scheduleConfig = schedule;
  if (!scheduleConfig && scheduleText) {
    scheduleConfig = parseNaturalSchedule(scheduleText);
    if (!scheduleConfig) {
      res.status(400).json({ error: `Could not parse schedule: "${scheduleText}"` });
      return;
    }
  }

  if (!scheduleConfig) {
    res.status(400).json({ error: 'schedule or scheduleText is required' });
    return;
  }

  const task = createTask(name, prompt, scheduleConfig, mode);
  res.json(task);
});

app.put('/api/schedules/:id', (req, res) => {
  const task = getTask(req.params.id);
  if (!task) {
    res.status(404).json({ error: 'Task not found' });
    return;
  }
  res.json(task);
});

app.delete('/api/schedules/:id', (req, res) => {
  const deleted = deleteTask(req.params.id);
  if (!deleted) {
    res.status(404).json({ error: 'Task not found' });
    return;
  }
  res.json({ ok: true });
});

app.post('/api/schedules/:id/pause', (req, res) => {
  const ok = pauseTask(req.params.id);
  if (!ok) {
    res.status(404).json({ error: 'Task not found' });
    return;
  }
  res.json({ ok: true });
});

app.post('/api/schedules/:id/resume', (req, res) => {
  const ok = resumeTask(req.params.id);
  if (!ok) {
    res.status(404).json({ error: 'Task not found' });
    return;
  }
  res.json({ ok: true });
});

app.get('/api/schedules/:id/history', (req, res) => {
  const history = getTaskHistory(req.params.id);
  res.json(history);
});

// ---- WebSocket ----

const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

// Track active Claude processes per session
const activeSessions = new Map<string, ChildProcess>();

// Session-routed client tracking: each client subscribes to specific sessions
interface ClientState {
  subscribedSessions: Set<string>;
}
const clientStates = new Map<WebSocket, ClientState>();

function sendToSession(sessionId: string, msg: ServerMessage): void {
  const data = JSON.stringify(msg);
  for (const [client, state] of clientStates) {
    if (client.readyState === WebSocket.OPEN && state.subscribedSessions.has(sessionId)) {
      client.send(data);
    }
  }
}

function broadcastToAll(msg: ServerMessage): void {
  const data = JSON.stringify(msg);
  for (const [client] of clientStates) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  }
}

wss.on('connection', (ws: WebSocket, req) => {
  // Validate API key from query string
  const url = req.url || '';
  if (!validateWsApiKey(url)) {
    ws.close(4001, 'Invalid API key');
    return;
  }

  console.log('[ws] Client connected');
  clientStates.set(ws, { subscribedSessions: new Set() });

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
    clientStates.delete(ws);
  });
});

function handleMessage(ws: WebSocket, msg: ClientMessage): void {
  // Auto-subscribe the client to the session they're interacting with
  if (msg.sessionId) {
    const state = clientStates.get(ws);
    if (state) {
      state.subscribedSessions.add(msg.sessionId);
    }
  }

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
    case 'approval_response':
      handleApprovalResponse(msg);
      break;
    case 'checkpoint_resume':
      handleCheckpointResume(ws, msg);
      break;
  }
}

function handlePrompt(ws: WebSocket, msg: ClientMessage): void {
  const sessionId = msg.sessionId;
  const mode: Mode = msg.mode ?? 'auto';
  const requestedModel = msg.model ?? process.env.NAVVY_MODEL ?? 'auto';
  const isFollowUp = !!msg.prompt;

  // Kill any existing process for this session
  handleCancel(sessionId);

  let prompt = msg.prompt ?? '';

  // Check if prompt matches a macro
  const macro = findMacro(prompt);
  if (macro) {
    console.log(`[session ${sessionId}] Matched macro: ${macro.name}`);
    incrementMacroUseCount(macro.id);
    const macroModel = requestedModel === 'auto' ? selectModel(prompt, false) : requestedModel;
    runMacroSteps(ws, sessionId, macro.steps, macro.mode as Mode || mode, macroModel);
    return;
  }

  // Attach file context if provided
  if (msg.attachments?.length) {
    const attachmentText = msg.attachments
      .map((a) => {
        if (a.type === 'page_context') {
          return `\n[Current page context]\n${a.data}`;
        }
        if (a.data) {
          const safeName = a.name.replace(/[^a-zA-Z0-9._-]/g, '_');
          const filePath = path.join(UPLOAD_DIR, `${uuidv4()}-${safeName}`);
          fs.writeFileSync(filePath, Buffer.from(a.data, 'base64'));
          console.log(`[session ${sessionId}] Saved attachment: ${a.name} -> ${filePath}`);
          return `\n[Attached file: ${a.name} — saved to ${filePath}. Use the Read tool to read this file.]`;
        }
        return `\n[Attached file: ${a.name} (${a.mimeType})]`;
      })
      .join('\n');
    prompt += attachmentText;
  }

  const model = requestedModel === 'auto' ? selectModel(prompt, false) : requestedModel;
  console.log(`[session ${sessionId}] Mode: ${mode}, Model: ${model}${requestedModel === 'auto' ? ' (auto)' : ''}`);
  console.log(`[session ${sessionId}] Prompt: ${prompt.substring(0, 100)}...`);
  sendMessage(ws, { type: 'status', sessionId, status: `Starting (${mode} mode, ${model})...` });

  const proc = runClaude(prompt, mode, model, sessionId, (partialMsg) => {
    // Send to the originating client and all clients subscribed to this session
    sendMessage(ws, { ...partialMsg, sessionId });
    sendToSession(sessionId, { ...partialMsg, sessionId });

    if (partialMsg.type === 'done') {
      activeSessions.delete(sessionId);
    }
  });

  activeSessions.set(sessionId, proc);
}

async function runMacroSteps(ws: WebSocket, sessionId: string, steps: Array<{ type: string; text: string }>, mode: Mode, model: string): Promise<void> {
  for (const step of steps) {
    if (step.type === 'prompt') {
      sendMessage(ws, { type: 'status', sessionId, status: `Running macro step...` });

      await new Promise<void>((resolve) => {
        const proc = runClaude(step.text, mode, model, sessionId, (partialMsg) => {
          sendMessage(ws, { ...partialMsg, sessionId });
          sendToSession(sessionId, { ...partialMsg, sessionId });
          if (partialMsg.type === 'done') {
            activeSessions.delete(sessionId);
            resolve();
          }
        });
        activeSessions.set(sessionId, proc);
      });
    }
  }
}

function handleCancel(sessionId: string): void {
  const proc = activeSessions.get(sessionId);
  if (proc) {
    proc.kill('SIGTERM');
    activeSessions.delete(sessionId);
    console.log(`[session ${sessionId}] Cancelled`);
  }
}

function handleApprovalResponse(msg: ClientMessage): void {
  if (!msg.approvalId || !msg.approvalResponse) return;

  const approved = msg.approvalResponse === 'approve' || msg.approvalResponse === 'approve_always';
  const alwaysAllow = msg.approvalResponse === 'approve_always'
    ? { toolName: msg.toolName || '' }
    : undefined;

  resolveApproval(msg.approvalId, approved, alwaysAllow);
  console.log(`[approval] ${msg.approvalId}: ${msg.approvalResponse}`);
}

function handleCheckpointResume(ws: WebSocket, msg: ClientMessage): void {
  if (!msg.sessionId || !msg.checkpointId) return;

  const prompt = buildResumePrompt(msg.sessionId, msg.checkpointId);
  if (!prompt) {
    sendMessage(ws, { type: 'error', sessionId: msg.sessionId, error: 'Checkpoint not found' });
    return;
  }

  const mode: Mode = msg.mode ?? 'auto';
  const requestedModel = msg.model ?? process.env.NAVVY_MODEL ?? 'auto';
  const model = requestedModel === 'auto' ? selectModel(prompt, true) : requestedModel;
  sendMessage(ws, { type: 'status', sessionId: msg.sessionId, status: 'Resuming from checkpoint...' });

  const proc = runClaude(prompt, mode, model, msg.sessionId, (partialMsg) => {
    sendMessage(ws, { ...partialMsg, sessionId: msg.sessionId });
    sendToSession(msg.sessionId, { ...partialMsg, sessionId: msg.sessionId });
    if (partialMsg.type === 'done') {
      activeSessions.delete(msg.sessionId);
    }
  });

  activeSessions.set(msg.sessionId, proc);
}

function sendMessage(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState === WebSocket.OPEN) {
    if (msg.type !== 'pong' && msg.type !== 'text_delta' && msg.type !== 'thinking_delta' && msg.type !== 'tool_use_input_delta') {
      console.log(`[ws:send] ${msg.type}${msg.status ? ': ' + msg.status : ''}${msg.toolName ? ': ' + msg.toolName : ''}`);
    }
    ws.send(JSON.stringify(msg));
  }
}

// ---- Graceful Shutdown ----

function gracefulShutdown(signal: string): void {
  console.log(`\n[server] Received ${signal}, shutting down gracefully...`);

  // Kill all active Claude processes
  for (const [sessionId, proc] of activeSessions) {
    console.log(`[server] Terminating session ${sessionId} (PID: ${proc.pid})`);
    proc.kill('SIGTERM');
  }
  activeSessions.clear();

  // Close all WebSocket connections
  for (const [client] of clientStates) {
    client.close(1001, 'Server shutting down');
  }
  clientStates.clear();

  // Close database
  closeDb();

  httpServer.close(() => {
    console.log('[server] HTTP server closed');
    process.exit(0);
  });

  // Force exit after 10 seconds
  setTimeout(() => {
    console.log('[server] Force exiting after timeout');
    process.exit(1);
  }, 10000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

httpServer.listen(PORT, () => {
  console.log(`Navvy server running on http://localhost:${PORT}`);
  console.log(`WebSocket endpoint: ws://localhost:${PORT}/ws`);

  if (!hasAnyApiKeys()) {
    console.log('\n  No API keys configured. Running in open mode.');
    console.log('  Create your first key: curl -X POST http://localhost:' + PORT + '/api/setup/key\n');
  }

  // Start scheduler
  startScheduler(executeScheduledTask);
});
