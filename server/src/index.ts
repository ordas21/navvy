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

// ---- Approval Endpoints ----

app.post('/api/approval/request', async (req, res) => {
  const { toolName, toolInput } = req.body;
  if (!toolName) {
    res.status(400).json({ error: 'toolName is required' });
    return;
  }

  const check = checkApproval(toolName, toolInput || '');
  if (!check) {
    // No approval needed
    res.json({ approved: true });
    return;
  }

  const request = createApprovalRequest('mcp', toolName, toolInput || '', check.trustLevel, check.reason);

  // Send approval request to all connected WS clients
  broadcastToClients({
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

  // Block until user responds (or timeout)
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

// Track all connected clients for broadcasting
const connectedClients = new Set<WebSocket>();

function broadcastToClients(msg: ServerMessage): void {
  const data = JSON.stringify(msg);
  for (const client of connectedClients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  }
}

wss.on('connection', (ws: WebSocket) => {
  console.log('[ws] Client connected');
  connectedClients.add(ws);

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
    connectedClients.delete(ws);
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

  // Kill any existing process for this session
  handleCancel(sessionId);

  let prompt = msg.prompt ?? '';

  // Check if prompt matches a macro
  const macro = findMacro(prompt);
  if (macro) {
    console.log(`[session ${sessionId}] Matched macro: ${macro.name}`);
    incrementMacroUseCount(macro.id);
    // Run macro steps sequentially
    runMacroSteps(ws, sessionId, macro.steps, macro.mode as Mode || mode);
    return;
  }

  // Attach file context if provided
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

  const proc = runClaude(prompt, mode, sessionId, (partialMsg) => {
    sendMessage(ws, { ...partialMsg, sessionId });

    if (partialMsg.type === 'done') {
      activeSessions.delete(sessionId);
    }
  });

  activeSessions.set(sessionId, proc);
}

async function runMacroSteps(ws: WebSocket, sessionId: string, steps: Array<{ type: string; text: string }>, mode: Mode): Promise<void> {
  for (const step of steps) {
    if (step.type === 'prompt') {
      sendMessage(ws, { type: 'status', sessionId, status: `Running macro step...` });

      await new Promise<void>((resolve) => {
        const proc = runClaude(step.text, mode, sessionId, (partialMsg) => {
          sendMessage(ws, { ...partialMsg, sessionId });
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

  // Send the resume prompt to Claude
  const mode: Mode = msg.mode ?? 'auto';
  sendMessage(ws, { type: 'status', sessionId: msg.sessionId, status: 'Resuming from checkpoint...' });

  const proc = runClaude(prompt, mode, msg.sessionId, (partialMsg) => {
    sendMessage(ws, { ...partialMsg, sessionId: msg.sessionId });
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

httpServer.listen(PORT, () => {
  console.log(`Navvy server running on http://localhost:${PORT}`);
  console.log(`WebSocket endpoint: ws://localhost:${PORT}/ws`);

  // Start scheduler
  startScheduler(executeScheduledTask);
});
