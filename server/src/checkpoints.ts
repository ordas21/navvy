import { v4 as uuidv4 } from 'uuid';
import { getDb } from './db.js';

// --- Types ---

export interface ActionLogEntry {
  tool: string;
  input: string;
  result: string;
  ts: number;
}

export interface StateSnapshot {
  url?: string;
  pageTitle?: string;
  formState?: Record<string, string>;
  tabCount?: number;
}

export interface Checkpoint {
  id: string;
  stepIndex: number;
  timestamp: number;
  description: string;
  stateSnapshot: StateSnapshot;
  actionLog: ActionLogEntry[];
  status: 'completed' | 'failed' | 'paused';
}

export interface CheckpointSession {
  sessionId: string;
  taskDescription: string;
  checkpoints: Checkpoint[];
  createdAt: number;
  updatedAt: number;
}

// --- DB Helpers ---

interface CheckpointRow {
  id: string;
  session_id: string;
  step_index: number;
  timestamp: number;
  description: string;
  state_snapshot: string;
  action_log: string;
  status: string;
}

interface SessionRow {
  session_id: string;
  task_description: string;
  created_at: number;
  updated_at: number;
}

function rowToCheckpoint(row: CheckpointRow): Checkpoint {
  return {
    id: row.id,
    stepIndex: row.step_index,
    timestamp: row.timestamp,
    description: row.description,
    stateSnapshot: JSON.parse(row.state_snapshot),
    actionLog: JSON.parse(row.action_log),
    status: row.status as Checkpoint['status'],
  };
}

// --- Public API ---

export function createCheckpointSession(sessionId: string, taskDescription: string): void {
  const db = getDb();
  const now = Date.now();
  db.prepare(`
    INSERT OR REPLACE INTO checkpoint_sessions (session_id, task_description, created_at, updated_at)
    VALUES (?, ?, ?, ?)
  `).run(sessionId, taskDescription, now, now);
}

export function addCheckpoint(
  sessionId: string,
  checkpoint: Omit<Checkpoint, 'id'>,
): string {
  const db = getDb();
  const id = `cp-${uuidv4().substring(0, 8)}`;

  // Ensure session exists
  const session = db.prepare('SELECT session_id FROM checkpoint_sessions WHERE session_id = ?').get(sessionId);
  if (!session) {
    db.prepare(`
      INSERT INTO checkpoint_sessions (session_id, task_description, created_at, updated_at)
      VALUES (?, '', ?, ?)
    `).run(sessionId, Date.now(), Date.now());
  }

  db.prepare(`
    INSERT INTO checkpoints (id, session_id, step_index, timestamp, description, state_snapshot, action_log, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, sessionId, checkpoint.stepIndex, checkpoint.timestamp,
    checkpoint.description, JSON.stringify(checkpoint.stateSnapshot),
    JSON.stringify(checkpoint.actionLog), checkpoint.status,
  );

  db.prepare('UPDATE checkpoint_sessions SET updated_at = ? WHERE session_id = ?').run(Date.now(), sessionId);

  return id;
}

export function getCheckpoints(sessionId: string): Checkpoint[] {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM checkpoints WHERE session_id = ? ORDER BY step_index ASC').all(sessionId) as CheckpointRow[];
  return rows.map(rowToCheckpoint);
}

export function getCheckpointSession(sessionId: string): CheckpointSession | null {
  const db = getDb();
  const session = db.prepare('SELECT * FROM checkpoint_sessions WHERE session_id = ?').get(sessionId) as SessionRow | undefined;
  if (!session) return null;

  const checkpoints = getCheckpoints(sessionId);

  return {
    sessionId: session.session_id,
    taskDescription: session.task_description,
    checkpoints,
    createdAt: session.created_at,
    updatedAt: session.updated_at,
  };
}

export function buildResumePrompt(sessionId: string, fromCheckpointId: string): string {
  const db = getDb();
  const session = db.prepare('SELECT * FROM checkpoint_sessions WHERE session_id = ?').get(sessionId) as SessionRow | undefined;
  if (!session) return '';

  const checkpoints = getCheckpoints(sessionId);
  const cpIndex = checkpoints.findIndex((cp) => cp.id === fromCheckpointId);
  if (cpIndex === -1) return '';

  const completedSteps = checkpoints.slice(0, cpIndex + 1);
  const failedStep = checkpoints[cpIndex];

  let prompt = `You were working on: ${session.task_description}\n\n`;
  prompt += `Steps completed so far:\n`;

  for (const cp of completedSteps) {
    const status = cp.status === 'completed' ? 'OK' : cp.status.toUpperCase();
    prompt += `  ${cp.stepIndex + 1}. [${status}] ${cp.description}\n`;
  }

  if (failedStep.stateSnapshot.url) {
    prompt += `\nLast known state:\n`;
    prompt += `  URL: ${failedStep.stateSnapshot.url}\n`;
    if (failedStep.stateSnapshot.pageTitle) {
      prompt += `  Page: ${failedStep.stateSnapshot.pageTitle}\n`;
    }
  }

  if (failedStep.status === 'failed') {
    const lastAction = failedStep.actionLog[failedStep.actionLog.length - 1];
    if (lastAction) {
      prompt += `\nStep ${failedStep.stepIndex + 1} failed. Last action: ${lastAction.tool} with result: ${lastAction.result.substring(0, 200)}\n`;
    }
    prompt += `\nResume from step ${failedStep.stepIndex + 1} and try a different approach.`;
  } else {
    prompt += `\nResume from step ${failedStep.stepIndex + 2}.`;
  }

  return prompt;
}

export function listCheckpointSessions(): Array<{ sessionId: string; taskDescription: string; checkpointCount: number; updatedAt: number }> {
  const db = getDb();
  const sessions = db.prepare('SELECT * FROM checkpoint_sessions ORDER BY updated_at DESC').all() as SessionRow[];

  return sessions.map((s) => {
    const count = (db.prepare('SELECT COUNT(*) as c FROM checkpoints WHERE session_id = ?').get(s.session_id) as { c: number }).c;
    return {
      sessionId: s.session_id,
      taskDescription: s.task_description,
      checkpointCount: count,
      updatedAt: s.updated_at,
    };
  });
}
