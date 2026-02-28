import { spawn, execSync, ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { v4 as uuidv4 } from 'uuid';
import type { ServerMessage, CostInfo, Mode } from './types.js';
import { SessionTracker, finalizeSession, getLearningsForPrompt, extractHostname, SELF_REVIEW_PROMPT } from './learnings.js';
import { addCheckpoint, createCheckpointSession } from './checkpoints.js';
import { isRecording, recordAction } from './workflows.js';
import { getDb } from './db.js';

// Maps navvy conversation IDs (from extension) to Claude CLI session UUIDs
const claudeSessionMap = new Map<string, string>();

export function clearClaudeSession(navvySessionId: string): void {
  claudeSessionMap.delete(navvySessionId);
}

function trackProcess(sessionId: string, pid: number | undefined, model: string, mode: Mode): void {
  try {
    const db = getDb();
    db.prepare(`
      INSERT OR REPLACE INTO active_processes (session_id, pid, status, started_at, model, mode)
      VALUES (?, ?, 'running', ?, ?, ?)
    `).run(sessionId, pid ?? null, Date.now(), model, mode);
  } catch { /* non-critical */ }
}

function untrackProcess(sessionId: string): void {
  try {
    const db = getDb();
    db.prepare('DELETE FROM active_processes WHERE session_id = ?').run(sessionId);
  } catch { /* non-critical */ }
}

export function cleanupStaleProcesses(): void {
  try {
    const db = getDb();
    db.prepare('DELETE FROM active_processes').run();
  } catch { /* non-critical */ }
}

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

// ---- Smart model routing ----

const COMPLEX_PATTERNS = [
  /\b(analyze|debug|investigate|diagnose|explain why|figure out|compare|evaluate|review|assess|optimize|refactor|architect)\b/i,
  /\b(strategy|plan|design|recommend)\b/i,
  /\b(across (?:all|multiple|every)|all (?:files|pages|tabs))\b/i,
  /\b(sort|rank|prioritize|organize) .{20,}/i,
  /\b(write|create|build|implement) (?:a |an )?(?:script|program|function|workflow|macro)\b/i,
  /\b(extract .{30,})/i,
  /\b(step[- ]by[- ]step|systematically|thoroughly)\b/i,
];

const SIMPLE_PATTERNS = [
  /^(?:click|tap|press|go to|navigate to|open|close|scroll|type|fill in|check|uncheck|select)\b/i,
  /^(?:what is|what's) (?:the |this )?(?:url|title|page|value|text|status)\b/i,
  /^(?:take a |grab a )?screenshot\b/i,
  /^(?:read|get|show|find) (?:the |this )?(?:value|text|title|url|status|element)\b/i,
  /^(?:wait|pause|refresh|reload)\b/i,
];

export function selectModel(prompt: string, isFollowUp: boolean): string {
  // Follow-ups are usually continuations — Sonnet is a good default
  if (isFollowUp) return 'sonnet';

  const trimmed = prompt.trim();

  // Short simple commands → Haiku
  if (trimmed.length < 80 && SIMPLE_PATTERNS.some(p => p.test(trimmed))) {
    return 'haiku';
  }

  // Complex multi-step or analytical tasks → Opus
  if (COMPLEX_PATTERNS.some(p => p.test(trimmed))) {
    return 'opus';
  }

  // Long prompts with multiple sentences tend to be complex
  const sentenceCount = trimmed.split(/[.!?]+/).filter(s => s.trim().length > 10).length;
  if (sentenceCount >= 4 || trimmed.length > 500) {
    return 'opus';
  }

  // Default → Sonnet
  return 'sonnet';
}

const BASE_PROMPT = `You are a browser automation agent. You can see and interact with web pages through a set of browser tools.

## CRITICAL RULES — Read These First
- When encountering a complex web app with many items, use browser_analyze_page FIRST to detect the page type and get a recommended interaction strategy.
- NEVER take a screenshot as your first action. Use browser_inspect_page instead — it's faster and gives you structured data with ready-to-use selectors.
- NEVER fill form fields one at a time with click+type. Use browser_fill_form to batch-fill ALL fields in a single call.
- browser_inspect_page returns up to 500 interactive elements and reports the total count. If there are more elements than shown, use browser_analyze_page to determine the best extraction strategy.

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
- browser_inspect_page: structured overview of up to 500 interactive elements with total count (use this first, always)
- browser_analyze_page: detect page type (virtual scroll, infinite scroll, paginated, static) and get recommended strategy
- browser_scroll_collect: scroll through content collecting items by CSS selector — handles infinite scroll, deduplication, lazy loading
- browser_intercept_api: trigger an action (scroll/click/wait) and capture API responses — ideal for SPAs and virtual scroll apps
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

## System Tools
You also have access to system-level tools that run directly on the user's computer:
- system_shell: Execute shell commands (bash). Use for complex operations, piped commands, package installs, git.
- system_read_file / system_write_file: Read/write files. Prefer these over shell cat/echo.
- system_list_directory: List directory contents. Prefer over shell ls.
- system_search_files / system_search_content: Find files or search contents. Prefer over shell find/grep.
- system_processes / system_kill_process: View and manage running processes.
- system_info: Get OS, CPU, memory, disk information.
- system_clipboard_read / system_clipboard_write: Read/write system clipboard.

Prefer dedicated file tools over system_shell for simple operations.
Use system_shell for complex multi-step operations, piped commands, and anything not covered by dedicated tools.

## Computer Control (macOS)
You can see and control ANY application on the screen, not just the browser:
- system_screenshot: Capture full screen or a specific app's window. Returns base64 PNG.
- system_accessibility_tree: Get UI element tree of any app — roles, labels, positions, sizes, values. Like DOM for the OS.
- system_click_at: Click at absolute screen coordinates (left, right, or double click).
- system_type_text: Type text in any focused application.
- system_key_press: Press keys or key combinations (e.g., cmd+c, cmd+tab).
- system_applescript: Run AppleScript or JXA for high-level app automation.
- system_open_app: Open, activate, or quit applications.
- system_move_mouse: Smooth Bezier-eased mouse movement.
- system_drag: Drag from point A to B with smooth motion.
- system_scroll_at: Native scroll wheel at screen coordinates.

### Computer Control Workflow
1. system_open_app to launch/activate the target app
2. system_accessibility_tree to get structured UI elements with positions, OR system_screenshot for visual context
3. system_click_at / system_type_text / system_key_press to interact using coordinates from the tree
4. system_screenshot to verify results

Prefer system_accessibility_tree over screenshots for finding element positions.
Prefer system_applescript for high-level operations over clicking through menus.

## Multi-Tab
- browser_new_tab: Open a new browser tab (optionally with a URL). Returns tabId.
- browser_close_tab: Close a browser tab by tabId.
- browser_extract_from_tab: Run JS in a specific tab without switching the active tab.
- browser_compare_tabs: Compare data across multiple tabs by running the same JS expression in each.

## Workflows & Automation
- workflow_record_start / workflow_record_stop: Record your actions as a replayable workflow.
- workflow_list / workflow_run / workflow_delete: Manage saved workflows. workflow_run accepts variables for parameterized replay.
- schedule_create: Create a recurring or one-time scheduled task. Parse natural language: "every hour", "every Monday at 9am", "in 30 minutes".
- schedule_list / schedule_pause / schedule_resume / schedule_delete / schedule_history: Manage scheduled tasks.
- macro_create / macro_list / macro_delete / macro_run: Create named shortcuts for common multi-step operations.

## Security & Credentials
- credential_lookup: Get a secure reference token for a password manager credential. NEVER type passwords directly — always use credential references.
- browser_solve_captcha: Detect and solve CAPTCHAs on the current page (reCAPTCHA, hCaptcha, Turnstile, image).

Dangerous actions (purchases, deletions, git push) may require user approval. If an action is denied, do not retry — ask the user for guidance.

## Error Recovery
- If an action fails, use browser_inspect_page to understand current state
- Try a different selector or approach — don't repeat the same failed action
- If a page is loading, use browser_wait before proceeding

## Page Analysis & Data Extraction Strategy
When working with complex web apps or long lists:
1. Use browser_analyze_page to detect page type (virtual scroll, infinite scroll, paginated, static)
2. Choose strategy based on type:
   - Static: inspect_page + get_dom
   - Paginated: inspect each page, click next
   - Infinite scroll: browser_scroll_collect with item selector
   - Virtual scroll (Google Drive, Trello, Notion): use browser_intercept_api — DOM elements are recycled
   - API-driven apps: browser_intercept_api with scroll/click triggers
3. Network interception is preferred for XHR/Fetch apps — gives structured JSON
4. For sorting large lists: determine total count first, then decide strategy`;

const MODE_PROMPTS: Record<Mode, string> = {
  auto: `## Mode: Auto
Follow the Core Workflow and Critical Rules above strictly. Be concise in your responses — act, don't explain.
Use browser_get_dom only when inspect_page doesn't give enough detail about non-interactive HTML.
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

function buildSystemPrompt(mode: Mode, hostname?: string): string {
  let prompt = BASE_PROMPT + '\n\n' + MODE_PROMPTS[mode];
  const learnings = getLearningsForPrompt(mode, hostname);
  if (learnings) prompt += learnings;
  prompt += SELF_REVIEW_PROMPT;
  return prompt;
}

export function runClaude(prompt: string, mode: Mode, model: string, navvySessionId: string, onMessage: OnMessage): ChildProcess {
  const hostname = extractHostname(prompt);
  const isFollowUp = claudeSessionMap.has(navvySessionId);

  let claudeUUID: string;
  if (isFollowUp) {
    claudeUUID = claudeSessionMap.get(navvySessionId)!;
  } else {
    claudeUUID = uuidv4();
    claudeSessionMap.set(navvySessionId, claudeUUID);
  }

  // Create session tracker for the learnings system
  const tracker = new SessionTracker(claudeUUID, mode, prompt);

  // Create checkpoint session
  createCheckpointSession(navvySessionId, prompt);
  let turnIndex = 0;
  const recentActions: Array<{ tool: string; input: string; result: string; ts: number }> = [];
  let lastUrl = '';
  let lastPageTitle = '';

  const sharedArgs = [
    '--output-format', 'stream-json',
    '--include-partial-messages',
    '--verbose',
    '--mcp-config', MCP_CONFIG,
    '--allowedTools', 'mcp__browser__*',
    '--model', model,
    '--dangerously-skip-permissions',
  ];

  let args: string[];
  if (isFollowUp) {
    // Follow-up: resume existing session, just send user message
    args = ['-p', prompt, '--resume', claudeUUID, ...sharedArgs];
  } else {
    // First turn: full system prompt + new session ID
    const systemPrompt = buildSystemPrompt(mode, hostname);
    args = ['-p', prompt, '--system-prompt', systemPrompt, '--session-id', claudeUUID, ...sharedArgs];
  }

  console.log(`[claude] ${isFollowUp ? 'Resuming' : 'Starting'} session ${claudeUUID} (navvy: ${navvySessionId})`);

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

  // Track process in DB
  trackProcess(navvySessionId, proc.pid, model, mode);

  // Wrap onMessage to feed events into the tracker
  const trackedOnMessage: OnMessage = (msg) => {
    // Feed tracking data before forwarding
    switch (msg.type) {
      case 'tool_use_start':
        if (msg.toolName && msg.toolId) {
          tracker.addToolCall(msg.toolName, msg.toolId);
        }
        break;
      case 'tool_use_input_delta':
        if (msg.toolId && msg.toolInput) {
          tracker.updateToolInput(msg.toolId, msg.toolInput);
        }
        break;
      case 'tool_result':
        if (msg.toolId && msg.toolResult) {
          tracker.addToolResult(msg.toolId, msg.toolResult);

          // Track recent actions for checkpointing
          const toolCall = tracker.getData().toolCalls.find(tc => tc.toolId === msg.toolId);
          if (toolCall) {
            recentActions.push({
              tool: toolCall.toolName,
              input: toolCall.input,
              result: msg.toolResult.substring(0, 500),
              ts: Date.now(),
            });

            // Record action for workflow recording
            if (isRecording(navvySessionId)) {
              recordAction(navvySessionId, toolCall.toolName, toolCall.input, msg.toolResult);
            }

            // Extract URL/title from navigate or inspect results
            if (toolCall.toolName.includes('navigate') || toolCall.toolName.includes('inspect')) {
              const urlMatch = msg.toolResult.match(/URL:\s*(\S+)/);
              if (urlMatch) lastUrl = urlMatch[1];
              const titleMatch = msg.toolResult.match(/Title:\s*(.+)/);
              if (titleMatch) lastPageTitle = titleMatch[1].trim();
            }
          }
        }
        break;
      case 'text_delta':
        if (msg.text) {
          tracker.addText(msg.text);
        }
        break;
      case 'cost':
        if (msg.cost) {
          tracker.setCost(msg.cost);
        }
        break;
      case 'done':
        // Auto-checkpoint on turn completion
        try {
          if (recentActions.length > 0) {
            const lastAction = recentActions[recentActions.length - 1];
            addCheckpoint(navvySessionId, {
              stepIndex: turnIndex++,
              timestamp: Date.now(),
              description: `Turn ${turnIndex}: ${recentActions.map(a => a.tool.replace(/^mcp__browser__/, '')).join(', ')}`,
              stateSnapshot: { url: lastUrl, pageTitle: lastPageTitle },
              actionLog: recentActions.splice(0),
              status: 'completed',
            });
          }
        } catch (err) {
          console.error('[checkpoints] Failed to add checkpoint:', err);
        }

        // Finalize session and persist learnings
        try {
          finalizeSession(tracker);
        } catch (err) {
          console.error('[learnings] Failed to finalize session:', err);
        }

        // Untrack process
        untrackProcess(navvySessionId);
        break;
    }
    // Forward to original handler
    onMessage(msg);
  };

  // Warn if no output after 15 seconds
  const startupTimer = setTimeout(() => {
    console.log('[claude] WARNING: No output after 15s — CLI may be hanging');
    trackedOnMessage({ type: 'status', status: 'Waiting for Claude CLI...' });
  }, 15000);

  const rl = createInterface({ input: proc.stdout! });

  // Track current content blocks being streamed
  const activeBlocks = new Map<number, { type: string; name?: string; id?: string }>();

  rl.on('line', (line) => {
    if (!line.trim()) return;
    try {
      const event = JSON.parse(line);
      handleEvent(event, trackedOnMessage, activeBlocks);
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
    untrackProcess(navvySessionId);
    if (code !== 0) {
      const errMsg = stderrBuffer.trim() || `Claude exited with code ${code}`;
      trackedOnMessage({ type: 'error', error: errMsg });
      // If resume failed, clear mapping so next attempt starts fresh
      if (isFollowUp) {
        console.log(`[claude] Clearing session mapping for ${navvySessionId} after error`);
        claudeSessionMap.delete(navvySessionId);
      }
    }
    if (!hasOutput) {
      console.log('[claude] WARNING: Process exited with no stdout output');
      trackedOnMessage({ type: 'error', error: 'Claude CLI produced no output. Check that "claude" is working.' });
    }
  });

  proc.on('error', (err) => {
    console.error('[claude] Spawn error:', err.message);
    trackedOnMessage({ type: 'error', error: `Failed to spawn Claude: ${err.message}` });
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
