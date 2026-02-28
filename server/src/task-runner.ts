import { runClaude } from './claude.js';
import type { Mode } from './types.js';
import type { ScheduledTask, RunResult } from './scheduler.js';

export async function executeScheduledTask(task: ScheduledTask): Promise<RunResult> {
  const startedAt = Date.now();
  const sessionId = `scheduled-${task.id}-${startedAt}`;
  const mode = (task.mode || 'auto') as Mode;

  return new Promise<RunResult>((resolve) => {
    let resultText = '';
    let costUsd = 0;
    let hasResolved = false;

    function finish(status: 'success' | 'error', summary?: string) {
      if (hasResolved) return;
      hasResolved = true;
      resolve({
        status,
        summary: summary || resultText.substring(0, 500) || 'No output',
        costUsd,
        durationMs: Date.now() - startedAt,
        startedAt,
        completedAt: Date.now(),
      });
    }

    try {
      const proc = runClaude(task.prompt, mode, 'sonnet', sessionId, (msg) => {
        switch (msg.type) {
          case 'text_delta':
            if (msg.text) resultText += msg.text;
            break;
          case 'cost':
            if (msg.cost) costUsd = msg.cost.totalCostUsd;
            break;
          case 'error':
            finish('error', msg.error);
            break;
          case 'done':
            finish('success');
            break;
        }
      });

      // Safety timeout: 10 minutes max per scheduled task
      const timeout = setTimeout(() => {
        proc.kill('SIGTERM');
        finish('error', 'Task timed out after 10 minutes');
      }, 10 * 60 * 1000);

      proc.on('close', () => {
        clearTimeout(timeout);
        finish('success');
      });

      proc.on('error', (err) => {
        clearTimeout(timeout);
        finish('error', err.message);
      });
    } catch (err) {
      finish('error', (err as Error).message);
    }
  });
}
