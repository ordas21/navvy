import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { v4 as uuidv4 } from 'uuid';
import { getCheckpointSession } from './checkpoints.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '../data');
const WORKFLOWS_DIR = path.join(DATA_DIR, 'workflows');

// Ensure dir exists
fs.mkdirSync(WORKFLOWS_DIR, { recursive: true });

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

// --- Storage ---

function workflowFilePath(id: string): string {
  const safeId = id.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(WORKFLOWS_DIR, `${safeId}.json`);
}

function loadWorkflow(id: string): Workflow | null {
  try {
    const raw = fs.readFileSync(workflowFilePath(id), 'utf-8');
    return JSON.parse(raw) as Workflow;
  } catch {
    return null;
  }
}

function saveWorkflow(workflow: Workflow): void {
  const tmp = workflowFilePath(workflow.id) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(workflow, null, 2));
  fs.renameSync(tmp, workflowFilePath(workflow.id));
}

// --- Public API ---

export function createWorkflow(name: string, steps: WorkflowStep[], variables: WorkflowVariable[] = [], tags: string[] = []): Workflow {
  const workflow: Workflow = {
    id: `wf-${uuidv4().substring(0, 8)}`,
    name,
    variables,
    steps,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    tags,
    runCount: 0,
  };
  saveWorkflow(workflow);
  return workflow;
}

export function getWorkflow(id: string): Workflow | null {
  return loadWorkflow(id);
}

export function listWorkflows(): Array<{ id: string; name: string; stepCount: number; tags: string[]; runCount: number; updatedAt: number }> {
  try {
    const files = fs.readdirSync(WORKFLOWS_DIR).filter((f) => f.endsWith('.json'));
    return files.map((f) => {
      try {
        const raw = fs.readFileSync(path.join(WORKFLOWS_DIR, f), 'utf-8');
        const wf = JSON.parse(raw) as Workflow;
        return {
          id: wf.id,
          name: wf.name,
          stepCount: wf.steps.length,
          tags: wf.tags,
          runCount: wf.runCount,
          updatedAt: wf.updatedAt,
        };
      } catch {
        return null;
      }
    }).filter((w): w is NonNullable<typeof w> => w !== null);
  } catch {
    return [];
  }
}

export function deleteWorkflow(id: string): boolean {
  try {
    fs.unlinkSync(workflowFilePath(id));
    return true;
  } catch {
    return false;
  }
}

export function incrementWorkflowRunCount(id: string): void {
  const workflow = loadWorkflow(id);
  if (workflow) {
    workflow.runCount++;
    workflow.updatedAt = Date.now();
    saveWorkflow(workflow);
  }
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
