import { spawn, ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../..');
const MCP_CONFIG = path.join(PROJECT_ROOT, 'mcp-config.json');

export interface ClaudeCallbacks {
  onText: (text: string) => void;
  onToolUse: (toolName: string, input: Record<string, unknown>) => void;
  onToolResult: (text: string) => void;
  onDone: (fullText: string) => void;
  onError: (error: string) => void;
}

const SYSTEM_PROMPT = `You are a browser automation agent. You can see and interact with web pages.

Available tools let you screenshot pages, read DOM, click elements, type text, navigate, and execute JavaScript.

Workflow:
1. Take a screenshot to see the current page state
2. Analyze what you see and plan your next action
3. Execute the action (click, type, navigate, etc.)
4. Screenshot again to verify the result
5. Repeat until the task is complete

When clicking elements, use CSS selectors. The tool will find the element, calculate its screen position, and click it with native OS input.

Always confirm task completion with a final screenshot.`;

export function runClaude(prompt: string, callbacks: ClaudeCallbacks): ChildProcess {
  const args = [
    '-p', `${SYSTEM_PROMPT}\n\nUser task: ${prompt}`,
    '--output-format', 'stream-json',
    '--mcp-config', MCP_CONFIG,
    '--allowedTools', 'mcp__browser__*',
    '--max-turns', '50',
    '--model', 'sonnet',
  ];

  const proc = spawn('claude', args, {
    cwd: PROJECT_ROOT,
    env: { ...process.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let fullText = '';

  const rl = createInterface({ input: proc.stdout! });

  rl.on('line', (line) => {
    if (!line.trim()) return;
    try {
      const event = JSON.parse(line);
      handleStreamEvent(event, callbacks, (text) => { fullText += text; });
    } catch {
      // Non-JSON output, ignore
    }
  });

  proc.stderr?.on('data', (data) => {
    const msg = data.toString().trim();
    if (msg) {
      console.error('[claude stderr]', msg);
    }
  });

  proc.on('close', (code) => {
    if (code === 0) {
      callbacks.onDone(fullText);
    } else {
      callbacks.onError(`Claude process exited with code ${code}`);
    }
  });

  proc.on('error', (err) => {
    callbacks.onError(`Failed to spawn Claude: ${err.message}`);
  });

  return proc;
}

function handleStreamEvent(
  event: Record<string, unknown>,
  callbacks: ClaudeCallbacks,
  appendText: (text: string) => void,
): void {
  const type = event.type as string;

  switch (type) {
    case 'assistant': {
      const message = event.message as { content?: Array<{ type: string; text?: string; name?: string; input?: Record<string, unknown> }> };
      if (message?.content) {
        for (const block of message.content) {
          if (block.type === 'text' && block.text) {
            callbacks.onText(block.text);
            appendText(block.text);
          } else if (block.type === 'tool_use') {
            callbacks.onToolUse(block.name ?? 'unknown', block.input ?? {});
          }
        }
      }
      break;
    }
    case 'result': {
      const result = event as { subtype?: string; result?: string; cost_usd?: number };
      if (result.result) {
        appendText(result.result);
        callbacks.onText(result.result);
      }
      break;
    }
  }
}
