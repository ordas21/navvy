import { spawn, ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ServerMessage, CostInfo } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../..');
const MCP_CONFIG = path.join(PROJECT_ROOT, 'mcp-config.json');

export type OnMessage = (msg: Omit<ServerMessage, 'sessionId'>) => void;

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

export function runClaude(prompt: string, onMessage: OnMessage): ChildProcess {
  const args = [
    '-p', `${SYSTEM_PROMPT}\n\nUser task: ${prompt}`,
    '--output-format', 'stream-json',
    '--include-partial-messages',
    '--verbose',
    '--mcp-config', MCP_CONFIG,
    '--allowedTools', 'mcp__browser__*',
    '--max-turns', '50',
    '--model', 'sonnet',
  ];

  console.log('[claude] Spawning with args:', args.join(' '));

  // Strip env vars that prevent the CLI from running
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('CLAUDE') || key.startsWith('MCP_')) {
      delete env[key];
    }
  }

  const proc = spawn('claude', args, {
    cwd: PROJECT_ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  console.log(`[claude] Process started, PID: ${proc.pid}`);

  // Warn if no output after 15 seconds
  const startupTimer = setTimeout(() => {
    console.log('[claude] WARNING: No output after 15s — CLI may be hanging');
    onMessage({ type: 'status', status: 'Waiting for Claude CLI...' });
  }, 15000);

  const rl = createInterface({ input: proc.stdout! });

  // Track current content blocks being streamed
  const activeBlocks = new Map<number, { type: string; name?: string; id?: string }>();

  rl.on('line', (line) => {
    if (!line.trim()) return;
    try {
      const event = JSON.parse(line);
      handleEvent(event, onMessage, activeBlocks);
    } catch {
      console.log('[claude:stdout]', line.substring(0, 200));
    }
  });

  let hasOutput = false;

  proc.stdout?.on('data', () => {
    if (!hasOutput) {
      hasOutput = true;
      clearTimeout(startupTimer);
      console.log('[claude] First output received from CLI');
    }
  });

  let stderrBuffer = '';
  proc.stderr?.on('data', (data) => {
    const msg = data.toString().trim();
    if (msg) {
      console.log('[claude:stderr]', msg);
      stderrBuffer += msg + '\n';
    }
  });

  proc.on('close', (code) => {
    clearTimeout(startupTimer);
    console.log(`[claude] Process exited with code ${code}`);
    if (code !== 0) {
      const errMsg = stderrBuffer.trim() || `Claude exited with code ${code}`;
      onMessage({ type: 'error', error: errMsg });
    }
    if (!hasOutput) {
      console.log('[claude] WARNING: Process exited with no stdout output');
      onMessage({ type: 'error', error: 'Claude CLI produced no output. Check that "claude" is working.' });
    }
  });

  proc.on('error', (err) => {
    console.error('[claude] Spawn error:', err.message);
    onMessage({ type: 'error', error: `Failed to spawn Claude: ${err.message}` });
  });

  return proc;
}

function handleEvent(
  event: Record<string, unknown>,
  onMessage: OnMessage,
  activeBlocks: Map<number, { type: string; name?: string; id?: string }>,
): void {
  const type = event.type as string;

  switch (type) {
    case 'system': {
      const subtype = event.subtype as string;
      console.log(`[claude] System event: ${subtype}`);
      if (subtype === 'init') {
        const model = event.model as string;
        const tools = event.tools as string[] | undefined;
        console.log(`[claude] Model: ${model}, Tools: ${tools?.length ?? 0}`);
        onMessage({ type: 'status', status: `Model: ${model}` });
      }
      break;
    }

    case 'stream_event': {
      const inner = event.event as Record<string, unknown>;
      if (!inner) break;
      handleStreamEvent(inner, onMessage, activeBlocks);
      break;
    }

    case 'assistant': {
      // Complete assistant turn — parse content blocks for anything we missed
      const message = event.message as {
        content?: Array<{ type: string; text?: string; thinking?: string; name?: string; input?: Record<string, unknown> }>;
      };
      console.log('[claude] Assistant turn complete');
      onMessage({ type: 'turn_complete' });

      // Log tool uses from complete message (in case streaming missed them)
      if (message?.content) {
        for (const block of message.content) {
          if (block.type === 'tool_use') {
            console.log(`[claude] Tool call: ${block.name}`, JSON.stringify(block.input).substring(0, 200));
          }
        }
      }
      break;
    }

    case 'user': {
      // Tool results
      const message = event.message as {
        content?: Array<{ type: string; tool_use_id?: string; content?: unknown }>;
      };
      const toolMeta = event.tool_use_result as { durationMs?: number; filenames?: string[] } | undefined;

      if (message?.content) {
        for (const block of message.content) {
          if (block.type === 'tool_result') {
            const resultText = typeof block.content === 'string'
              ? block.content
              : JSON.stringify(block.content, null, 2);
            const truncated = resultText.length > 500
              ? resultText.substring(0, 500) + '... (truncated)'
              : resultText;
            console.log(`[claude] Tool result (${toolMeta?.durationMs ?? '?'}ms):`, truncated.substring(0, 200));
            onMessage({
              type: 'tool_result',
              toolId: block.tool_use_id,
              toolResult: truncated,
            });
          }
        }
      }
      break;
    }

    case 'result': {
      const result = event as {
        subtype?: string;
        is_error?: boolean;
        result?: string;
        total_cost_usd?: number;
        duration_ms?: number;
        num_turns?: number;
        usage?: { input_tokens?: number; output_tokens?: number };
      };

      const cost: CostInfo = {
        totalCostUsd: result.total_cost_usd ?? 0,
        inputTokens: result.usage?.input_tokens ?? 0,
        outputTokens: result.usage?.output_tokens ?? 0,
        numTurns: result.num_turns ?? 0,
        durationMs: result.duration_ms ?? 0,
      };

      console.log(`[claude] Done — ${result.subtype}, cost: $${cost.totalCostUsd.toFixed(4)}, turns: ${cost.numTurns}, duration: ${cost.durationMs}ms`);

      if (result.is_error) {
        onMessage({ type: 'error', error: result.result ?? 'Unknown error' });
      }

      onMessage({ type: 'cost', cost });
      onMessage({ type: 'done' });
      break;
    }
  }
}

function handleStreamEvent(
  event: Record<string, unknown>,
  onMessage: OnMessage,
  activeBlocks: Map<number, { type: string; name?: string; id?: string }>,
): void {
  const eventType = event.type as string;

  switch (eventType) {
    case 'content_block_start': {
      const index = event.index as number;
      const block = event.content_block as { type: string; name?: string; id?: string };
      activeBlocks.set(index, block);

      if (block.type === 'thinking') {
        console.log('[claude] Thinking started...');
        onMessage({ type: 'status', status: 'Thinking...' });
      } else if (block.type === 'text') {
        console.log('[claude] Writing response...');
        onMessage({ type: 'status', status: 'Writing...' });
      } else if (block.type === 'tool_use') {
        console.log(`[claude] Tool start: ${block.name}`);
        onMessage({
          type: 'tool_use_start',
          toolName: block.name,
          toolId: block.id,
        });
        onMessage({ type: 'status', status: `Using ${block.name}...` });
      }
      break;
    }

    case 'content_block_delta': {
      const index = event.index as number;
      const delta = event.delta as { type: string; text?: string; thinking?: string; partial_json?: string };
      const block = activeBlocks.get(index);

      if (delta.type === 'text_delta' && delta.text) {
        onMessage({ type: 'text_delta', text: delta.text });
      } else if (delta.type === 'thinking_delta' && delta.thinking) {
        console.log('[claude] Thinking:', delta.thinking.substring(0, 100));
        onMessage({ type: 'thinking_delta', thinking: delta.thinking });
      } else if (delta.type === 'input_json_delta' && delta.partial_json && block) {
        onMessage({
          type: 'tool_use_input_delta',
          toolId: block.id,
          toolInput: delta.partial_json,
        });
      }
      break;
    }

    case 'content_block_stop': {
      const index = event.index as number;
      const block = activeBlocks.get(index);
      if (block?.type === 'tool_use') {
        onMessage({ type: 'tool_use_done', toolId: block.id, toolName: block.name });
      }
      activeBlocks.delete(index);
      break;
    }

    case 'message_start':
    case 'message_delta':
    case 'message_stop':
    case 'ping':
      // These are fine to ignore
      break;

    default:
      console.log(`[claude] Unknown stream event: ${eventType}`);
  }
}
