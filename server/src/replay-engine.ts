import { getWorkflow, substituteVariables, incrementWorkflowRunCount } from './workflows.js';
import { runClaude } from './claude.js';
import type { Mode } from './types.js';
import type { WorkflowStep } from './workflows.js';

// --- Types ---

export interface ReplayResult {
  workflowId: string;
  totalSteps: number;
  completedSteps: number;
  failedSteps: number;
  skippedSteps: number;
  llmFixedSteps: number;
  status: 'completed' | 'partial' | 'aborted';
  results: StepResult[];
}

interface StepResult {
  stepIndex: number;
  tool: string;
  status: 'completed' | 'failed' | 'skipped' | 'llm_fixed';
  result?: string;
  error?: string;
}

export interface ReplayOptions {
  workflowId: string;
  variables: Record<string, string>;
  startFromStep?: number;
  mode: Mode;
  onStepComplete: (stepIndex: number, result: string) => void;
  onStepFailed: (stepIndex: number, error: string) => Promise<'retry' | 'skip' | 'llm_fix' | 'abort'>;
}

// --- Replay Engine ---

export async function replayWorkflow(options: ReplayOptions): Promise<ReplayResult> {
  const workflow = getWorkflow(options.workflowId);
  if (!workflow) {
    throw new Error(`Workflow not found: ${options.workflowId}`);
  }

  const results: StepResult[] = [];
  let completedSteps = 0;
  let failedSteps = 0;
  let skippedSteps = 0;
  let llmFixedSteps = 0;
  let status: ReplayResult['status'] = 'completed';

  const startStep = options.startFromStep ?? 0;
  const steps = workflow.steps.slice(startStep);

  for (const step of steps) {
    const substitutedStep = substituteVariables(step, options.variables);

    try {
      // Build a prompt that tells Claude to execute this specific step
      const prompt = buildStepPrompt(substitutedStep);

      // Run step through Claude (one-shot)
      const result = await executeStepViaClaude(prompt, options.mode);

      results.push({
        stepIndex: step.index,
        tool: step.tool,
        status: 'completed',
        result,
      });
      completedSteps++;
      options.onStepComplete(step.index, result);
    } catch (err) {
      const errorMsg = (err as Error).message;

      // Determine fallback strategy
      let action: 'retry' | 'skip' | 'llm_fix' | 'abort';

      if (step.fallbackStrategy === 'abort') {
        action = 'abort';
      } else if (step.fallbackStrategy === 'skip') {
        action = 'skip';
      } else if (step.fallbackStrategy === 'llm') {
        action = 'llm_fix';
      } else {
        action = await options.onStepFailed(step.index, errorMsg);
      }

      switch (action) {
        case 'retry': {
          // Retry once
          try {
            const prompt = buildStepPrompt(substitutedStep);
            const result = await executeStepViaClaude(prompt, options.mode);
            results.push({ stepIndex: step.index, tool: step.tool, status: 'completed', result });
            completedSteps++;
            options.onStepComplete(step.index, result);
          } catch (retryErr) {
            results.push({ stepIndex: step.index, tool: step.tool, status: 'failed', error: (retryErr as Error).message });
            failedSteps++;
          }
          break;
        }
        case 'skip':
          results.push({ stepIndex: step.index, tool: step.tool, status: 'skipped', error: errorMsg });
          skippedSteps++;
          break;
        case 'llm_fix': {
          // LLM fallback: ask Claude to achieve the goal using current page state
          const llmPrompt = buildLlmFallbackPrompt(substitutedStep, errorMsg);
          try {
            const result = await executeStepViaClaude(llmPrompt, options.mode);
            results.push({ stepIndex: step.index, tool: step.tool, status: 'llm_fixed', result });
            llmFixedSteps++;
            completedSteps++;
            options.onStepComplete(step.index, result);
          } catch (llmErr) {
            results.push({ stepIndex: step.index, tool: step.tool, status: 'failed', error: (llmErr as Error).message });
            failedSteps++;
          }
          break;
        }
        case 'abort':
          results.push({ stepIndex: step.index, tool: step.tool, status: 'failed', error: errorMsg });
          failedSteps++;
          status = 'aborted';
          break;
      }

      if (status === 'aborted') break;
    }
  }

  if (status !== 'aborted' && failedSteps > 0) {
    status = 'partial';
  }

  incrementWorkflowRunCount(options.workflowId);

  return {
    workflowId: options.workflowId,
    totalSteps: steps.length,
    completedSteps,
    failedSteps,
    skippedSteps,
    llmFixedSteps,
    status,
    results,
  };
}

// --- Helpers ---

function buildStepPrompt(step: WorkflowStep): string {
  return `Execute this single step: ${step.description}\n\nUse the tool "${step.tool}" with these parameters: ${JSON.stringify(step.input, null, 2)}\n\nDo not do anything else. Just execute this one action and report the result.`;
}

function buildLlmFallbackPrompt(step: WorkflowStep, error: string): string {
  return `The goal was: ${step.description}\n\nThe original method (${step.tool} with ${JSON.stringify(step.input)}) failed with: ${error}\n\nAchieve the same goal using the current page state. Use browser_inspect_page first to understand what's on the page, then take the appropriate action.`;
}

function executeStepViaClaude(prompt: string, mode: Mode): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let resultText = '';
    let hasError = false;

    const sessionId = `replay-${Date.now()}`;
    const proc = runClaude(prompt, mode, 'sonnet', sessionId, (msg) => {
      if (msg.type === 'text_delta' && msg.text) {
        resultText += msg.text;
      }
      if (msg.type === 'error' && msg.error) {
        hasError = true;
        reject(new Error(msg.error));
      }
      if (msg.type === 'done') {
        if (!hasError) {
          resolve(resultText || 'Step completed');
        }
      }
    });

    proc.on('error', (err) => {
      reject(err);
    });
  });
}
