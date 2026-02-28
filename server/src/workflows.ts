import { v4 as uuidv4 } from 'uuid';
import { getDb } from './db.js';
import { getCheckpointSession } from './checkpoints.js';

// --- Types ---

export interface WorkflowVariable {
  name: string;
  type: 'string' | 'number' | 'boolean';
  required: boolean;
  default?: string;
  description?: string;
}

export interface WorkflowStep {
  index: number;
  tool: string;
  input: Record<string, unknown>;
  description: string;
  fallbackStrategy: 'retry' | 'skip' | 'llm' | 'abort';
}

export interface Workflow {
  id: string;
  name: string;
  variables: WorkflowVariable[];
  steps: WorkflowStep[];
  createdAt: number;
  updatedAt: number;
  tags: string[];
  runCount: number;
}

// --- DB Helpers ---

interface WorkflowRow {
  id: string;
  name: string;
  variables: string;
  steps: string;
  tags: string;
  run_count: number;
  created_at: number;
  updated_at: number;
}

function rowToWorkflow(row: WorkflowRow): Workflow {
  return {
    id: row.id,
    name: row.name,
    variables: JSON.parse(row.variables),
    steps: JSON.parse(row.steps),
    tags: JSON.parse(row.tags),
    runCount: row.run_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// --- Public API ---

export function createWorkflow(name: string, steps: WorkflowStep[], variables: WorkflowVariable[] = [], tags: string[] = []): Workflow {
  const db = getDb();
  const now = Date.now();
  const id = `wf-${uuidv4().substring(0, 8)}`;

  db.prepare(`
    INSERT INTO workflows (id, name, variables, steps, tags, run_count, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 0, ?, ?)
  `).run(id, name, JSON.stringify(variables), JSON.stringify(steps), JSON.stringify(tags), now, now);

  return { id, name, variables, steps, createdAt: now, updatedAt: now, tags, runCount: 0 };
}

export function getWorkflow(id: string): Workflow | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM workflows WHERE id = ?').get(id) as WorkflowRow | undefined;
  return row ? rowToWorkflow(row) : null;
}

export function listWorkflows(): Array<{ id: string; name: string; stepCount: number; tags: string[]; runCount: number; updatedAt: number }> {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM workflows ORDER BY updated_at DESC').all() as WorkflowRow[];
  return rows.map((row) => {
    const wf = rowToWorkflow(row);
    return {
      id: wf.id,
      name: wf.name,
      stepCount: wf.steps.length,
      tags: wf.tags,
      runCount: wf.runCount,
      updatedAt: wf.updatedAt,
    };
  });
}

export function deleteWorkflow(id: string): boolean {
  const db = getDb();
  const result = db.prepare('DELETE FROM workflows WHERE id = ?').run(id);
  return result.changes > 0;
}

export function incrementWorkflowRunCount(id: string): void {
  const db = getDb();
  db.prepare('UPDATE workflows SET run_count = run_count + 1, updated_at = ? WHERE id = ?').run(Date.now(), id);
}

// --- Variable Substitution ---

export function substituteVariables(step: WorkflowStep, vars: Record<string, string>): WorkflowStep {
  const inputStr = JSON.stringify(step.input);
  let substituted = inputStr;
  for (const [key, value] of Object.entries(vars)) {
    substituted = substituted.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value);
  }
  return {
    ...step,
    input: JSON.parse(substituted),
  };
}

// --- Record from Session ---

export function recordFromSession(sessionId: string, name: string, tags: string[] = []): Workflow | null {
  const session = getCheckpointSession(sessionId);
  if (!session || session.checkpoints.length === 0) return null;

  const steps: WorkflowStep[] = [];
  let stepIndex = 0;

  for (const checkpoint of session.checkpoints) {
    for (const action of checkpoint.actionLog) {
      let parsedInput: Record<string, unknown> = {};
      try {
        parsedInput = JSON.parse(action.input);
      } catch {
        parsedInput = { raw: action.input };
      }

      steps.push({
        index: stepIndex++,
        tool: action.tool,
        input: parsedInput,
        description: checkpoint.description || `${action.tool} action`,
        fallbackStrategy: 'llm',
      });
    }
  }

  if (steps.length === 0) return null;

  return createWorkflow(name, steps, [], tags);
}

// --- Recording Buffer (in-memory per session) ---

const recordingBuffers = new Map<string, {
  active: boolean;
  actions: Array<{ tool: string; input: string; result: string; ts: number }>;
}>();

export function startRecording(sessionId: string): void {
  recordingBuffers.set(sessionId, { active: true, actions: [] });
}

export function stopRecording(sessionId: string): Array<{ tool: string; input: string; result: string; ts: number }> {
  const buffer = recordingBuffers.get(sessionId);
  recordingBuffers.delete(sessionId);
  return buffer?.actions ?? [];
}

export function isRecording(sessionId: string): boolean {
  return recordingBuffers.get(sessionId)?.active === true;
}

export function recordAction(sessionId: string, tool: string, input: string, result: string): void {
  const buffer = recordingBuffers.get(sessionId);
  if (buffer?.active) {
    buffer.actions.push({ tool, input, result, ts: Date.now() });
  }
}
