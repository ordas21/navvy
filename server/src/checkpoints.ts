import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { v4 as uuidv4 } from 'uuid';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '../data');
const CHECKPOINTS_DIR = path.join(DATA_DIR, 'checkpoints');

// Ensure dir exists
fs.mkdirSync(CHECKPOINTS_DIR, { recursive: true });

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

// --- Storage ---

function sessionFilePath(sessionId: string): string {
  const safeId = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(CHECKPOINTS_DIR, `${safeId}.json`);
}

function loadSession(sessionId: string): CheckpointSession | null {
  try {
    const raw = fs.readFileSync(sessionFilePath(sessionId), 'utf-8');
    return JSON.parse(raw) as CheckpointSession;
  } catch {
    return null;
  }
}

function saveSession(session: CheckpointSession): void {
  const tmp = sessionFilePath(session.sessionId) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(session, null, 2));
  fs.renameSync(tmp, sessionFilePath(session.sessionId));
}

// --- Public API ---

export function createCheckpointSession(sessionId: string, taskDescription: string): void {
  const session: CheckpointSession = {
    sessionId,
    taskDescription,
    checkpoints: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  saveSession(session);
}

export function addCheckpoint(
  sessionId: string,
  checkpoint: Omit<Checkpoint, 'id'>,
): string {
  let session = loadSession(sessionId);
  if (!session) {
    session = {
      sessionId,
      taskDescription: '',
      checkpoints: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
  }

  const id = `cp-${uuidv4().substring(0, 8)}`;
  session.checkpoints.push({ ...checkpoint, id });
  session.updatedAt = Date.now();
  saveSession(session);
  return id;
}

export function getCheckpoints(sessionId: string): Checkpoint[] {
  const session = loadSession(sessionId);
  return session?.checkpoints ?? [];
}

export function getCheckpointSession(sessionId: string): CheckpointSession | null {
  return loadSession(sessionId);
}

export function buildResumePrompt(sessionId: string, fromCheckpointId: string): string {
  const session = loadSession(sessionId);
  if (!session) return '';

  const cpIndex = session.checkpoints.findIndex((cp) => cp.id === fromCheckpointId);
  if (cpIndex === -1) return '';

  const completedSteps = session.checkpoints.slice(0, cpIndex + 1);
  const failedStep = session.checkpoints[cpIndex];

  let prompt = `You were working on: ${session.taskDescription}\n\n`;
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
  try {
    const files = fs.readdirSync(CHECKPOINTS_DIR).filter((f) => f.endsWith('.json'));
    return files.map((f) => {
      try {
        const raw = fs.readFileSync(path.join(CHECKPOINTS_DIR, f), 'utf-8');
        const session = JSON.parse(raw) as CheckpointSession;
        return {
          sessionId: session.sessionId,
          taskDescription: session.taskDescription,
          checkpointCount: session.checkpoints.length,
          updatedAt: session.updatedAt,
        };
      } catch {
        return null;
      }
    }).filter((s): s is NonNullable<typeof s> => s !== null);
  } catch {
    return [];
  }
}
