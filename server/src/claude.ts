import { spawn, execSync, ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ServerMessage, CostInfo, Mode } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../..');
const MCP_CONFIG = path.join(PROJECT_ROOT, 'mcp-config.json');

// Resolve the full path to the claude binary at startup so spawn() works
// even when run from contexts that don't load shell profiles (nvm, etc.)
let CLAUDE_BIN = 'claude';
try {
  CLAUDE_BIN = execSync('which claude', { encoding: 'utf-8' }).trim();
} catch {
  // Fall back to bare name and hope it's in PATH
}

export type OnMessage = (msg: Omit<ServerMessage, 'sessionId'>) => void;

const BASE_PROMPT = `You are a browser automation agent. You can see and interact with web pages through a set of browser tools.

## CRITICAL RULES — Read These First
- NEVER scroll through a page to "explore" or "see what's there" before acting. browser_inspect_page already returns ALL interactive elements on the page, including off-screen ones.
- NEVER take a screenshot as your first action. Use browser_inspect_page instead — it's faster and gives you structured data with ready-to-use selectors.
- NEVER fill form fields one at a time with click+type. Use browser_fill_form to batch-fill ALL fields in a single call.
- NEVER scroll just to look around. Only scroll if you need to interact with an element that browser_fill_form can't reach, or if you need visual context a screenshot can't provide from the current viewport.

## Core Workflow
1. browser_inspect_page → get all interactive elements, their selectors, labels, values, and states
2. Act immediately on what you see — fill forms, click buttons, etc.
3. Verify only when needed (browser_inspect_page to check values, or screenshot for visual confirmation)

## Form/Quiz Workflow (follow this exactly)
1. browser_inspect_page → see all fields, their types, labels, and current values
2. browser_fill_form with ALL answers in one call → fill everything at once
3. If some fields are off-screen, browser_fill_form still works — it uses DOM selectors, not screen coordinates
4. browser_click on submit button → done
5. browser_inspect_page to verify result if needed
That's 3-4 tool calls total. NOT one per field.

## Selector Strategy
- browser_inspect_page provides ready-to-use selectors — use them directly
- Prefer stable selectors: #id, [data-testid], [name], [aria-label], [role]
- If a selector fails, fall back to browser_get_dom for the full DOM tree

## Available Tools
- browser_inspect_page: structured overview of ALL interactive elements (use this first, always)
- browser_fill_form: batch-fill multiple fields in one call (text, select, checkbox, radio — works with React/Vue/Angular)
- browser_click: click by CSS selector
- browser_type: type into focused element
- browser_scroll_to: scroll a specific element into view
- browser_scroll: scroll page or container
- browser_double_click / browser_right_click: specialized clicks
- browser_drag: drag and drop — default uses CDP smooth mouse moves (works for most UIs); html5:true for [draggable="true"] elements using HTML5 DnD API; native:true for canvas/non-standard UIs
- browser_reorder: reorder items in a sortable list (SortableJS, react-sortable-hoc, @dnd-kit) — provide container selector and new index order. Use this INSTEAD of browser_drag for sortable lists.
- browser_hover: reveal hidden menus/tooltips
- browser_select: select dropdown option
- browser_screenshot: visual verification ONLY when needed (not as a first step)
- browser_get_dom: deeper HTML structure (only if inspect_page isn't enough)
- browser_navigate: go to a URL
- browser_wait: wait for element or duration
- browser_evaluate: run JavaScript
- browser_key_press: press keyboard keys

## Error Recovery
- If an action fails, use browser_inspect_page to understand current state
- Try a different selector or approach — don't repeat the same failed action
- If a page is loading, use browser_wait before proceeding`;

const MODE_PROMPTS: Record<Mode, string> = {
  auto: `## Mode: Auto
Your first action should ALWAYS be browser_inspect_page. Never start with a screenshot or scrolling.

Act immediately on inspect results — do not scroll to explore the page first. browser_inspect_page already tells you about ALL elements including off-screen ones.

For forms/quizzes: inspect_page → fill_form (all fields at once) → click submit. That's it. 3 calls.

Use screenshots only for visual verification after actions, not for initial page understanding.
Use browser_get_dom only when inspect_page doesn't give you enough info about non-interactive HTML structure.
Use browser_get_accessibility_tree for complex widgets (tabs, dialogs, menus).
Use browser_network/console tools for debugging API calls or JS errors.`,

  screenshot: `## Mode: Screenshot
Use browser_screenshot as your primary observation tool. Take screenshots frequently to track page state.
- Prefer browser_click_at with coordinates for interactions — identify click targets from the screenshot
- Take a screenshot after every action to verify results
- Use screenshots to identify UI elements, read text, and verify visual state
- Fall back to browser_get_dom only if you cannot identify an element visually`,

  dom: `## Mode: DOM
Use browser_get_dom as your primary observation tool. Focus on HTML structure and CSS selectors.
- Inspect the DOM tree to understand page structure and find reliable selectors
- Use browser_click with CSS selectors for all interactions
- Prefer semantic selectors: [data-testid], [aria-label], #id, [name]
- Use browser_get_dom with a selector argument to scope queries to specific subtrees
- Take screenshots only for visual verification when needed`,

  accessibility: `## Mode: Accessibility
Use browser_get_accessibility_tree as your primary observation tool. Focus on the accessibility tree: roles, names, states, and ARIA attributes.
- Read the accessibility tree to understand page structure and identify interactive elements
- Interact with elements using their roles and accessible names
- Check for proper ARIA states (expanded, selected, checked, disabled)
- This mode is ideal for testing accessibility compliance, navigating complex widgets (menus, tabs, dialogs, grids), and understanding semantic structure
- Use browser_click with selectors derived from roles/labels (e.g. [role="button"][aria-label="Submit"])`,

  network: `## Mode: Network
Use browser_network_start/get_requests/get_response/stop to monitor network traffic.
- Call browser_network_start BEFORE performing the actions you want to monitor
- After the action, use browser_network_get_requests to see all captured traffic
- Filter requests by URL substring to find specific API calls (e.g. filter: "/api/", ".json")
- Use browser_network_get_response with a requestId to inspect response bodies
- Look for XHR/Fetch request types — these are usually the API calls
- Call browser_network_stop when done to clean up
- This mode is ideal for debugging API issues, understanding data flow, and verifying backend communication`,

  console: `## Mode: Console
Use browser_console_start/get_logs/stop to capture browser console output.
- Call browser_console_start BEFORE performing actions you want to debug
- After the action, use browser_console_get_logs to see all console output
- Filter by level to focus on what matters: "error" for exceptions, "warning" for warnings, "log" for general output
- Look for JavaScript errors and exceptions first — these often reveal the root cause
- Check for failed network requests that log errors to the console
- Call browser_console_stop when done to clean up
- This mode is ideal for debugging JavaScript errors, tracking application state, and finding runtime issues`,
};

function buildSystemPrompt(mode: Mode): string {
  return BASE_PROMPT + '\n\n' + MODE_PROMPTS[mode];
}

export function runClaude(prompt: string, mode: Mode, onMessage: OnMessage): ChildProcess {
  const systemPrompt = buildSystemPrompt(mode);
  const args = [
    '-p', `${systemPrompt}\n\nUser task: ${prompt}`,
    '--output-format', 'stream-json',
    '--include-partial-messages',
    '--verbose',
    '--mcp-config', MCP_CONFIG,
    '--allowedTools', 'mcp__browser__*',
    '--max-turns', '50',
    '--model', 'sonnet',
    '--dangerously-skip-permissions',
  ];

  console.log('[claude] Spawning with args:', args.join(' '));

  // Strip env vars that prevent the CLI from running
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('CLAUDE') || key.startsWith('MCP_')) {
      delete env[key];
    }
  }

  const proc = spawn(CLAUDE_BIN, args, {
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
