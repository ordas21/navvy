/* global chrome, loadConversationIndex, loadConversation, appendToConversation,
   createConversation, deleteConversation, updateConversationIndex,
   getActiveConversationId, setActiveConversationId, checkStorageUsage,
   flushAllPendingAppends, setServerConfig, marked, DOMPurify */

// ---- Markdown rendering ----
marked.setOptions({ breaks: true, gfm: true });

function renderMarkdown(text) {
  const html = marked.parse(text);
  return DOMPurify.sanitize(html);
}

const DEFAULT_SERVER_URL = 'ws://localhost:3300/ws';

// State
let ws = null;
let sessionId = null;
let activeConversationId = null;
let isRunning = false;
let attachments = [];
let serverUrl = DEFAULT_SERVER_URL;
let apiKey = '';
let currentMode = 'auto';
let currentModel = 'auto';

// Current streaming elements
let currentTextEl = null;
let currentThinkingEl = null;
let currentToolInputEl = null;
let toolInputBuffers = new Map();

// Accumulators for persistence
let currentTextBuffer = '';
let currentThinkingBuffer = '';
let pendingTurn = [];
let currentToolMeta = new Map(); // toolId -> { toolName, input }

// DOM elements
const messagesEl = document.getElementById('messages');
const promptInput = document.getElementById('prompt-input');
const btnSend = document.getElementById('btn-send');
const btnCancel = document.getElementById('btn-cancel');
const btnAttach = document.getElementById('btn-attach');
const btnPage = document.getElementById('btn-page');
const attachmentsBar = document.getElementById('attachments-bar');
const statusDot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');
const settingsOverlay = document.getElementById('settings-overlay');
const btnSettingsSave = document.getElementById('btn-settings-save');
const btnSettingsCancel = document.getElementById('btn-settings-cancel');
const settingServerUrl = document.getElementById('setting-server-url');
const btnSettings = document.getElementById('btn-settings');
const btnConversations = document.getElementById('btn-conversations');
const conversationsOverlay = document.getElementById('conversations-overlay');
const conversationsList = document.getElementById('conversations-list');
const btnNewConversation = document.getElementById('btn-new-conversation');
const btnConversationsClose = document.getElementById('btn-conversations-close');

// ---- Tool Labels ----
// Pending approval state
let pendingApproval = null;

const TOOL_LABELS = {
  browser_screenshot: 'Screenshot',
  browser_get_dom: 'Get DOM',
  browser_click: 'Click',
  browser_click_at: 'Click at Coords',
  browser_type: 'Type',
  browser_key_press: 'Key Press',
  browser_navigate: 'Navigate',
  browser_scroll: 'Scroll',
  browser_evaluate: 'Run JavaScript',
  browser_get_url: 'Get URL',
  browser_wait: 'Wait',
  browser_tabs: 'List Tabs',
  browser_switch_tab: 'Switch Tab',
  browser_hover: 'Hover',
  browser_select: 'Select Option',
  browser_clear_input: 'Clear Input',
  browser_network_start: 'Network Start',
  browser_network_get_requests: 'Network Requests',
  browser_network_get_response: 'Network Response',
  browser_network_stop: 'Network Stop',
  browser_get_accessibility_tree: 'Accessibility Tree',
  browser_console_start: 'Console Start',
  browser_console_get_logs: 'Console Logs',
  browser_console_stop: 'Console Stop',
  browser_inspect_page: 'Inspect Page',
  browser_fill_form: 'Fill Form',
  browser_scroll_to: 'Scroll To',
  browser_double_click: 'Double Click',
  browser_right_click: 'Right Click',
  browser_drag: 'Drag',
  browser_reorder: 'Reorder List',
  browser_new_tab: 'New Tab',
  browser_close_tab: 'Close Tab',
  browser_extract_from_tab: 'Extract from Tab',
  browser_compare_tabs: 'Compare Tabs',
  browser_solve_captcha: 'Solve CAPTCHA',
  credential_lookup: 'Credential Lookup',
  macro_create: 'Create Macro',
  macro_list: 'List Macros',
  macro_delete: 'Delete Macro',
  macro_run: 'Run Macro',
  schedule_create: 'Create Schedule',
  schedule_list: 'List Schedules',
  schedule_pause: 'Pause Schedule',
  schedule_resume: 'Resume Schedule',
  schedule_delete: 'Delete Schedule',
  schedule_history: 'Schedule History',
  workflow_record_start: 'Start Recording',
  workflow_record_stop: 'Stop Recording',
  workflow_list: 'List Workflows',
  workflow_run: 'Run Workflow',
  workflow_delete: 'Delete Workflow',
};

function formatToolName(raw) {
  return TOOL_LABELS[raw] || raw.replace(/^browser_/, '').replace(/_/g, ' ');
}

// ---- Mode Management ----

function setMode(mode) {
  currentMode = mode;
  document.querySelectorAll('.mode-chip').forEach((chip) => {
    chip.classList.toggle('active', chip.dataset.mode === mode);
  });
  chrome.storage.local.set({ currentMode: mode });
}

// ---- Slash Commands ----

const SLASH_COMMANDS = [
  { command: '/mode', description: 'Switch mode or show current (e.g. /mode network)' },
  { command: '/screenshot', description: 'Take a screenshot of the current page' },
  { command: '/dom', description: 'Get the DOM tree of the current page' },
  { command: '/url', description: 'Show current tab URL' },
  { command: '/clear', description: 'Start a new conversation' },
  { command: '/help', description: 'Show available commands' },
];

function parseSlashCommand(text) {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return null;
  const spaceIndex = trimmed.indexOf(' ');
  if (spaceIndex === -1) {
    return { command: trimmed.toLowerCase(), arg: '' };
  }
  return {
    command: trimmed.substring(0, spaceIndex).toLowerCase(),
    arg: trimmed.substring(spaceIndex + 1).trim(),
  };
}

function addSystemMessage(text) {
  const el = document.createElement('div');
  el.className = 'message system-msg';
  el.textContent = text;
  messagesEl.appendChild(el);
  scrollToBottom();
  return el;
}

async function handleSlashCommand(parsed) {
  switch (parsed.command) {
    case '/mode': {
      const validModes = ['auto', 'screenshot', 'dom', 'accessibility', 'network', 'console'];
      if (parsed.arg && validModes.includes(parsed.arg.toLowerCase())) {
        setMode(parsed.arg.toLowerCase());
        addSystemMessage(`Mode switched to: ${parsed.arg.toLowerCase()}`);
      } else if (parsed.arg) {
        addSystemMessage(`Unknown mode: "${parsed.arg}". Valid modes: ${validModes.join(', ')}`);
      } else {
        addSystemMessage(`Current mode: ${currentMode}\nValid modes: ${validModes.join(', ')}`);
      }
      return true;
    }
    case '/screenshot':
      promptInput.value = 'Take a screenshot of the current page';
      sendPrompt();
      return true;
    case '/dom':
      promptInput.value = 'Get the DOM tree of the current page';
      sendPrompt();
      return true;
    case '/url': {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab) {
          addSystemMessage(`URL: ${tab.url}\nTitle: ${tab.title}`);
        } else {
          addSystemMessage('No active tab found');
        }
      } catch {
        addSystemMessage('Unable to get tab info');
      }
      return true;
    }
    case '/clear':
      await startNewConversation();
      return true;
    case '/help': {
      const lines = SLASH_COMMANDS.map((c) => `${c.command}  ${c.description}`);
      addSystemMessage('Available commands:\n' + lines.join('\n'));
      return true;
    }
    default:
      addSystemMessage(`Unknown command: ${parsed.command}. Type /help for available commands.`);
      return true;
  }
}

// ---- Slash Popup ----

const slashPopup = document.getElementById('slash-popup');
const slashPopupList = document.getElementById('slash-popup-list');

function showSlashPopup(filter) {
  const matches = SLASH_COMMANDS.filter((c) =>
    c.command.startsWith(filter.toLowerCase())
  );
  if (matches.length === 0) {
    hideSlashPopup();
    return;
  }
  slashPopupList.innerHTML = '';
  for (const cmd of matches) {
    const item = document.createElement('div');
    item.className = 'slash-item';
    item.innerHTML = `<span class="slash-cmd">${cmd.command}</span><span class="slash-desc">${cmd.description}</span>`;
    item.addEventListener('mousedown', (e) => {
      e.preventDefault();
      promptInput.value = cmd.command + ' ';
      promptInput.focus();
      hideSlashPopup();
    });
    slashPopupList.appendChild(item);
  }
  slashPopup.style.display = 'block';
}

function hideSlashPopup() {
  slashPopup.style.display = 'none';
}

// ---- Render Functions (reusable for both streaming and restore) ----

function renderUserMessage(text) {
  // Remove welcome/suggestions when the first message is sent
  const welcome = messagesEl.querySelector('.welcome');
  if (welcome) welcome.remove();

  const el = document.createElement('div');
  el.className = 'message user';
  el.textContent = text;
  messagesEl.appendChild(el);
  return el;
}

function renderAssistantMessage(text) {
  const el = document.createElement('div');
  el.className = 'message assistant';
  const content = document.createElement('div');
  content.className = 'msg-content';
  content.innerHTML = renderMarkdown(text);
  el.appendChild(content);
  messagesEl.appendChild(el);
  return el;
}

function renderThinkingMessage(text, collapsed = false) {
  const el = document.createElement('div');
  el.className = 'message thinking' + (collapsed ? ' collapsed' : '');

  const header = document.createElement('div');
  header.className = 'thinking-header';
  header.textContent = 'Thinking...';
  header.onclick = () => el.classList.toggle('collapsed');
  el.appendChild(header);

  const content = document.createElement('div');
  content.className = 'thinking-content';
  content.textContent = text;
  el.appendChild(content);

  messagesEl.appendChild(el);
  return el;
}

function renderToolCallMessage(toolName, toolId, input, result) {
  const el = document.createElement('div');
  el.className = 'message tool-call collapsed';
  if (toolId) el.id = `tool-${toolId}`;

  const header = document.createElement('div');
  header.className = 'tool-header';

  const icon = document.createElement('span');
  icon.className = 'tool-icon';
  icon.textContent = result !== undefined ? '\u2713' : '\u25B6';
  header.appendChild(icon);

  const name = document.createElement('span');
  name.className = 'tool-name';
  name.textContent = formatToolName(toolName);
  header.appendChild(name);

  if (result !== undefined) {
    const spinner = document.createElement('span');
    spinner.className = 'tool-spinner done';
    header.appendChild(spinner);
  }

  el.appendChild(header);

  if (input) {
    const inputEl = document.createElement('pre');
    inputEl.className = 'tool-input';
    try {
      inputEl.textContent = typeof input === 'string'
        ? JSON.stringify(JSON.parse(input), null, 2)
        : JSON.stringify(input, null, 2);
    } catch {
      inputEl.textContent = String(input);
    }
    el.appendChild(inputEl);
  }

  if (result !== undefined) {
    const resultEl = document.createElement('pre');
    resultEl.className = 'tool-result';
    resultEl.textContent = String(result);
    el.appendChild(resultEl);
  }

  header.onclick = () => el.classList.toggle('collapsed');
  messagesEl.appendChild(el);
  return el;
}

function renderErrorMessage(text) {
  const el = document.createElement('div');
  el.className = 'message error';
  el.textContent = text;
  messagesEl.appendChild(el);
  return el;
}

function renderCostMessage(cost) {
  if (!cost) return null;
  const el = document.createElement('div');
  el.className = 'message cost-info';

  const duration = (cost.durationMs / 1000).toFixed(1);
  const costStr = cost.totalCostUsd < 0.01
    ? `$${cost.totalCostUsd.toFixed(4)}`
    : `$${cost.totalCostUsd.toFixed(2)}`;

  const parts = [
    costStr,
    `${cost.numTurns} turns`,
    `${duration}s`,
    `${(cost.inputTokens + cost.outputTokens).toLocaleString()} tokens`,
  ];

  parts.forEach((text, i) => {
    if (i > 0) {
      const sep = document.createElement('span');
      sep.className = 'cost-sep';
      sep.textContent = '\u00B7';
      el.appendChild(sep);
    }
    const item = document.createElement('span');
    item.className = 'cost-item';
    item.textContent = text;
    el.appendChild(item);
  });

  messagesEl.appendChild(el);
  return el;
}

function renderConversation(messages) {
  // Clear messages area
  messagesEl.innerHTML = '';

  if (!messages || messages.length === 0) {
    messagesEl.innerHTML = `
      <div class="welcome">
        <div class="welcome-title">Navvy</div>
        <div class="welcome-sub">I can see and interact with web pages. Tell me what to do.</div>
        <div class="welcome-examples"></div>
      </div>`;
    populateExamplePrompts();
    return;
  }

  for (const record of messages) {
    switch (record.type) {
      case 'user':
        renderUserMessage(record.text);
        break;
      case 'assistant':
        renderAssistantMessage(record.text);
        break;
      case 'thinking':
        renderThinkingMessage(record.text, true);
        break;
      case 'tool_call':
        renderToolCallMessage(record.toolName, record.toolId, record.input, record.result);
        break;
      case 'error':
        renderErrorMessage(record.text);
        break;
      case 'cost':
        renderCostMessage(record.cost);
        break;
    }
  }

  groupAllSteps();
  scrollToBottom();
}

function getContextualPrompts(url, title) {
  if (!url || url === 'chrome://newtab/' || url.startsWith('chrome://')) {
    return [
      'Summarize the content on this page',
      'Find all links on this page',
      'Take a screenshot and describe what you see',
    ];
  }

  let domain = '';
  try { domain = new URL(url).hostname.replace('www.', ''); } catch { /* ignore */ }
  const lowerUrl = url.toLowerCase();
  const lowerTitle = (title || '').toLowerCase();

  // Search engines
  if (domain.includes('google.com') && lowerUrl.includes('/search')) {
    return [
      'Click the first organic search result',
      'Summarize the top 5 results',
      'Search for something else: ',
    ];
  }

  // Shopping / e-commerce
  if (['amazon.com', 'ebay.com', 'walmart.com', 'target.com', 'etsy.com'].some(d => domain.includes(d))) {
    if (lowerUrl.includes('/cart') || lowerUrl.includes('/basket')) {
      return ['Proceed to checkout', 'Remove the most expensive item', 'Summarize what\'s in my cart'];
    }
    if (lowerUrl.includes('/dp/') || lowerUrl.includes('/product') || lowerUrl.includes('/itm/')) {
      return ['Add this item to cart', 'What are the top reviews saying?', 'Find a cheaper alternative'];
    }
    return ['Search for headphones under $50', 'Show me today\'s deals', 'Find the best-rated items'];
  }

  // Social media
  if (['twitter.com', 'x.com', 'reddit.com', 'facebook.com', 'linkedin.com'].some(d => domain.includes(d))) {
    return ['Summarize the posts on this page', 'Scroll down and find trending topics', 'Describe what\'s on screen'];
  }

  // GitHub
  if (domain.includes('github.com')) {
    if (lowerUrl.includes('/pull/') || lowerUrl.includes('/issues/')) {
      return ['Summarize this discussion', 'List the files changed', 'Scroll to the latest comment'];
    }
    return ['Describe this repository', 'Find the most recent commits', 'Navigate to the Issues tab'];
  }

  // Forms / login
  if (lowerUrl.includes('/login') || lowerUrl.includes('/signin') || lowerUrl.includes('/register') || lowerUrl.includes('/signup')) {
    return ['Fill out this form with test data', 'What fields are on this form?', 'Submit the form'];
  }

  // Generic page-aware prompts
  const prompts = ['Summarize the content on this page'];
  if (lowerTitle || domain) {
    prompts.push(`What can I do on ${domain || 'this site'}?`);
  }
  prompts.push('Find all buttons and links on this page');
  return prompts;
}

async function populateExamplePrompts() {
  const container = document.querySelector('.welcome-examples');
  if (!container) return;

  let url = '', title = '';
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) { url = tab.url || ''; title = tab.title || ''; }
  } catch { /* ignore */ }

  const prompts = getContextualPrompts(url, title);
  container.innerHTML = '';
  for (const text of prompts) {
    const btn = document.createElement('button');
    btn.className = 'example-prompt';
    btn.textContent = text;
    btn.addEventListener('click', () => {
      promptInput.value = text;
      promptInput.focus();
      autoResize();
    });
    container.appendChild(btn);
  }
}

// ---- WebSocket Connection ----

let wasConnected = false;

function showConnectionToast(type, message) {
  const existing = document.querySelector('.connection-toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.className = `connection-toast ${type}`;
  toast.textContent = message;
  document.body.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('visible'));
  setTimeout(() => {
    toast.classList.remove('visible');
    setTimeout(() => toast.remove(), 300);
  }, 2500);
}

function connectWebSocket() {
  if (ws) {
    ws.close();
  }

  setStatus('connecting', 'Connecting...');
  const wsUrl = apiKey ? `${serverUrl}?apiKey=${encodeURIComponent(apiKey)}` : serverUrl;
  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    setStatus('connected', 'Connected');
    if (wasConnected === false) {
      // First connection — no toast
    } else {
      showConnectionToast('connected', 'Connection restored');
    }
    wasConnected = true;
  };

  ws.onclose = () => {
    setStatus('disconnected', 'Disconnected');
    if (wasConnected) {
      showConnectionToast('disconnected', 'Connection lost — retrying...');
    }
    setTimeout(connectWebSocket, 3000);
  };

  ws.onerror = () => {
    // onclose will fire after this
  };

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      handleServerMessage(msg);
    } catch (e) {
      console.error('Failed to parse server message:', e);
    }
  };
}

// ---- Handle Server Messages (with accumulators) ----

function handleServerMessage(msg) {
  switch (msg.type) {
    case 'text_delta':
      removeActivityIndicator();
      currentTextBuffer += msg.text;
      appendTextDelta(msg.text);
      break;

    case 'thinking_delta':
      removeActivityIndicator();
      currentThinkingBuffer += msg.thinking;
      appendThinkingDelta(msg.thinking);
      break;

    case 'tool_use_start':
      removeActivityIndicator();
      // Flush any text/thinking buffers before tool
      flushTextBuffer();
      flushThinkingBuffer();
      currentToolMeta.set(msg.toolId, { toolName: msg.toolName, input: '' });
      addToolStart(msg.toolName, msg.toolId);
      break;

    case 'tool_use_input_delta':
      appendToolInput(msg.toolId, msg.toolInput);
      // Accumulate input for persistence
      const meta = currentToolMeta.get(msg.toolId);
      if (meta) meta.input += msg.toolInput;
      break;

    case 'tool_use_done':
      finalizeToolInput(msg.toolId);
      break;

    case 'tool_result': {
      addToolResult(msg.toolId, msg.toolResult);
      // Create complete tool_call record
      const toolMeta = currentToolMeta.get(msg.toolId);
      if (toolMeta) {
        pendingTurn.push({
          type: 'tool_call',
          toolName: toolMeta.toolName,
          toolId: msg.toolId,
          input: toolMeta.input,
          result: msg.toolResult,
          ts: Date.now(),
        });
        currentToolMeta.delete(msg.toolId);
      }
      break;
    }

    case 'turn_complete':
      // Flush remaining buffers
      flushTextBuffer();
      flushThinkingBuffer();
      // Save accumulated records for this turn
      if (pendingTurn.length > 0 && activeConversationId) {
        appendToConversation(activeConversationId, pendingTurn).catch(console.error);
        pendingTurn = [];
      }
      // Group completed steps into a collapsible summary
      groupSteps();
      // Reset streaming elements for next turn
      currentTextEl = null;
      currentThinkingEl = null;
      currentToolInputEl = null;
      break;

    case 'done':
      if (cancelTimeout) {
        finalizeCancellation();
        break;
      }
      // Final flush
      flushTextBuffer();
      flushThinkingBuffer();
      if (pendingTurn.length > 0 && activeConversationId) {
        appendToConversation(activeConversationId, pendingTurn).catch(console.error);
        pendingTurn = [];
      }
      setRunning(false);
      setStatus('connected', 'Done');
      checkStorageUsage().then(deleted => {
        if (deleted > 0) {
          showConnectionToast('disconnected', `${deleted} old conversation${deleted > 1 ? 's' : ''} removed to free storage`);
        }
      }).catch(console.error);
      break;

    case 'error':
      if (cancelTimeout) {
        finalizeCancellation();
        break;
      }
      addErrorMessage(msg.error);
      // Save error record
      if (activeConversationId) {
        const errorRecords = [...pendingTurn, { type: 'error', text: msg.error, ts: Date.now() }];
        appendToConversation(activeConversationId, errorRecords).catch(console.error);
        pendingTurn = [];
      }
      setRunning(false);
      setStatus('connected', 'Connected');
      break;

    case 'status':
      setStatus('thinking', msg.status || 'Working...');
      if (isRunning) {
        showActivityIndicator(msg.status || 'Working');
      }
      break;

    case 'cost':
      addCostMessage(msg.cost);
      // Save cost record
      if (activeConversationId) {
        appendToConversation(activeConversationId, [{ type: 'cost', cost: msg.cost, ts: Date.now() }]).catch(console.error);
      }
      break;

    case 'approval_request':
      showApprovalDialog(msg.approval);
      break;

    case 'checkpoint_created':
      // Silent — checkpoints are auto-created
      break;

    case 'scheduled_task_update':
      // Could show a toast notification
      if (msg.scheduledTask) {
        showConnectionToast('connected', `Task "${msg.scheduledTask.name}": ${msg.scheduledTask.status}`);
      }
      break;

    case 'pong':
      break;
  }
}

function flushTextBuffer() {
  if (currentTextBuffer) {
    pendingTurn.push({ type: 'assistant', text: currentTextBuffer, ts: Date.now() });
    currentTextBuffer = '';
  }
}

function flushThinkingBuffer() {
  if (currentThinkingBuffer) {
    pendingTurn.push({ type: 'thinking', text: currentThinkingBuffer, ts: Date.now() });
    currentThinkingBuffer = '';
  }
}

// --- Streaming text ---
function appendTextDelta(text) {
  if (!currentTextEl) {
    currentTextEl = document.createElement('div');
    currentTextEl.className = 'message assistant';
    const content = document.createElement('div');
    content.className = 'msg-content';
    currentTextEl.appendChild(content);
    messagesEl.appendChild(currentTextEl);
  }
  const content = currentTextEl.querySelector('.msg-content');
  content.innerHTML = renderMarkdown(currentTextBuffer);
  scrollToBottom();
}

// --- Streaming thinking ---
function appendThinkingDelta(text) {
  if (!currentThinkingEl) {
    currentThinkingEl = document.createElement('div');
    currentThinkingEl.className = 'message thinking';

    const header = document.createElement('div');
    header.className = 'thinking-header';
    header.textContent = 'Thinking...';
    header.onclick = () => {
      currentThinkingEl.classList.toggle('collapsed');
    };
    currentThinkingEl.appendChild(header);

    const content = document.createElement('div');
    content.className = 'thinking-content';
    currentThinkingEl.appendChild(content);

    messagesEl.appendChild(currentThinkingEl);
  }
  const content = currentThinkingEl.querySelector('.thinking-content');
  content.textContent += text;
  scrollToBottom();
}

// --- Tool use ---
function addToolStart(toolName, toolId) {
  currentTextEl = null;
  currentThinkingEl = null;

  const el = document.createElement('div');
  el.className = 'message tool-call';
  el.id = `tool-${toolId}`;

  const header = document.createElement('div');
  header.className = 'tool-header';

  const icon = document.createElement('span');
  icon.className = 'tool-icon';
  icon.textContent = '\u25B6';
  header.appendChild(icon);

  const name = document.createElement('span');
  name.className = 'tool-name';
  name.textContent = formatToolName(toolName);
  header.appendChild(name);

  const spinner = document.createElement('span');
  spinner.className = 'tool-spinner';
  header.appendChild(spinner);

  el.appendChild(header);

  const inputEl = document.createElement('pre');
  inputEl.className = 'tool-input';
  el.appendChild(inputEl);

  header.onclick = () => el.classList.toggle('collapsed');

  messagesEl.appendChild(el);
  toolInputBuffers.set(toolId, '');
  scrollToBottom();
}

function appendToolInput(toolId, partialJson) {
  const buffer = (toolInputBuffers.get(toolId) || '') + partialJson;
  toolInputBuffers.set(toolId, buffer);

  const el = document.getElementById(`tool-${toolId}`);
  if (el) {
    const inputEl = el.querySelector('.tool-input');
    try {
      inputEl.textContent = JSON.stringify(JSON.parse(buffer), null, 2);
    } catch {
      inputEl.textContent = buffer;
    }
  }
  scrollToBottom();
}

function finalizeToolInput(toolId) {
  const el = document.getElementById(`tool-${toolId}`);
  if (el) {
    const spinner = el.querySelector('.tool-spinner');
    if (spinner) spinner.className = 'tool-spinner waiting';
  }
}

function addToolResult(toolId, resultText) {
  const toolEl = toolId ? document.getElementById(`tool-${toolId}`) : null;

  if (toolEl) {
    const spinner = toolEl.querySelector('.tool-spinner');
    if (spinner) spinner.className = 'tool-spinner done';

    const icon = toolEl.querySelector('.tool-icon');
    if (icon) icon.textContent = '\u2713';

    const resultEl = document.createElement('pre');
    resultEl.className = 'tool-result';
    resultEl.textContent = resultText;
    toolEl.appendChild(resultEl);

    // Don't auto-collapse during live streaming — user is watching
  } else {
    const el = document.createElement('div');
    el.className = 'message tool-result-standalone';
    el.textContent = resultText;
    messagesEl.appendChild(el);
  }

  scrollToBottom();
}

function addCostMessage(cost) {
  renderCostMessage(cost);
  scrollToBottom();
}

function addErrorMessage(text) {
  renderErrorMessage(text);
  scrollToBottom();
}

function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

// ---- Steps Grouping ----

function buildStepsSummary(elements) {
  const names = [];
  for (const el of elements) {
    if (el.classList.contains('tool-call')) {
      const nameEl = el.querySelector('.tool-name');
      names.push(nameEl ? nameEl.textContent : 'Tool');
    } else if (el.classList.contains('thinking')) {
      names.push('Thinking');
    }
  }
  const count = elements.length;
  const displayed = names.slice(0, 4).join(', ') + (names.length > 4 ? '...' : '');
  return `${count} steps \u2014 ${displayed}`;
}

function wrapInStepsGroup(elements, collapsed = false) {
  const group = document.createElement('div');
  group.className = 'steps-group' + (collapsed ? ' collapsed' : '');

  const header = document.createElement('div');
  header.className = 'steps-group-header';

  const chevron = document.createElement('span');
  chevron.className = 'steps-chevron';
  chevron.textContent = '\u25BE';
  header.appendChild(chevron);

  const summary = document.createElement('span');
  summary.className = 'steps-summary';
  summary.textContent = buildStepsSummary(elements);
  header.appendChild(summary);

  header.onclick = () => group.classList.toggle('collapsed');
  group.appendChild(header);

  const body = document.createElement('div');
  body.className = 'steps-group-body';
  group.appendChild(body);

  // Insert group at the position of the first element
  elements[0].parentNode.insertBefore(group, elements[0]);

  // Move elements into the body
  for (const el of elements) {
    body.appendChild(el);
  }

  return group;
}

function groupSteps() {
  const children = messagesEl.children;
  const run = [];

  // Scan backward from the end to collect trailing thinking/tool-call elements
  for (let i = children.length - 1; i >= 0; i--) {
    const el = children[i];
    if (el.classList.contains('thinking') || el.classList.contains('tool-call')) {
      run.unshift(el);
    } else {
      break;
    }
  }

  if (run.length >= 2) {
    // Live streaming: keep expanded so user can see what's happening
    wrapInStepsGroup(run, false);
  }
}

function groupAllSteps() {
  const children = Array.from(messagesEl.children);
  let run = [];

  for (const el of children) {
    if (el.classList.contains('thinking') || el.classList.contains('tool-call')) {
      run.push(el);
    } else {
      if (run.length >= 2) {
        // Restoring old conversation: collapse to save space
        wrapInStepsGroup(run, true);
      }
      run = [];
    }
  }

  // Handle trailing run
  if (run.length >= 2) {
    wrapInStepsGroup(run, true);
  }
}

// ---- Status & Running State ----

function setStatus(state, text) {
  statusDot.className = state;
  statusText.textContent = text;
}

function showActivityIndicator(label = 'Thinking') {
  removeActivityIndicator();
  const el = document.createElement('div');
  el.className = 'activity-indicator';
  el.id = 'activity-indicator';
  el.innerHTML = `<div class="activity-dots"><span></span><span></span><span></span></div><span>${label}...</span>`;
  messagesEl.appendChild(el);
  scrollToBottom();
}

function removeActivityIndicator() {
  const el = document.getElementById('activity-indicator');
  if (el) el.remove();
}

function setRunning(running) {
  isRunning = running;
  btnSend.style.display = running ? 'none' : 'flex';
  btnCancel.style.display = running ? 'flex' : 'none';
  promptInput.disabled = running;
  currentTextEl = null;
  currentThinkingEl = null;
  currentToolInputEl = null;
  toolInputBuffers.clear();
  if (!running) {
    removeActivityIndicator();
    currentTextBuffer = '';
    currentThinkingBuffer = '';
    currentToolMeta.clear();
  }
}

// ---- Send / Cancel ----

async function sendPrompt() {
  const text = promptInput.value.trim();
  if (!text) return;

  // Check for slash commands first
  const parsed = parseSlashCommand(text);
  if (parsed) {
    promptInput.value = '';
    autoResize();
    hideSlashPopup();
    await handleSlashCommand(parsed);
    return;
  }

  if (!ws || ws.readyState !== WebSocket.OPEN) {
    showConnectionToast('disconnected', 'Not connected to server');
    return;
  }

  hideSlashPopup();

  // Render and persist user message immediately
  renderUserMessage(text);
  if (activeConversationId) {
    appendToConversation(activeConversationId, [{ type: 'user', text, ts: Date.now() }]).catch(console.error);
  }

  const msg = {
    type: 'prompt',
    sessionId,
    prompt: text,
    mode: currentMode,
    model: currentModel,
    attachments: attachments.length > 0 ? attachments : undefined,
  };

  ws.send(JSON.stringify(msg));
  promptInput.value = '';
  attachments = [];
  renderAttachments();
  setRunning(true);
  autoResize();
  scrollToBottom();
}

let cancelTimeout = null;

function cancelTask() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'cancel', sessionId }));
  }

  // Show cancelling state
  setStatus('thinking', 'Cancelling...');
  btnCancel.disabled = true;
  showActivityIndicator('Cancelling');

  // Wait up to 3s for server to confirm (via 'done' or 'error'), then force reset
  cancelTimeout = setTimeout(() => {
    finalizeCancellation();
  }, 3000);
}

function finalizeCancellation() {
  if (cancelTimeout) {
    clearTimeout(cancelTimeout);
    cancelTimeout = null;
  }
  // Flush any pending accumulator data
  flushTextBuffer();
  flushThinkingBuffer();
  if (pendingTurn.length > 0 && activeConversationId) {
    appendToConversation(activeConversationId, pendingTurn).catch(console.error);
    pendingTurn = [];
  }
  setRunning(false);
  btnCancel.disabled = false;
  setStatus('connected', 'Cancelled');

  const el = document.createElement('div');
  el.className = 'message status-msg';
  el.textContent = 'Task cancelled';
  messagesEl.appendChild(el);
  scrollToBottom();
}

// ---- Attachments ----

function renderAttachments() {
  attachmentsBar.innerHTML = '';
  attachments.forEach((att, i) => {
    const chip = document.createElement('div');
    chip.className = 'attachment-chip';
    chip.innerHTML = `<span>${att.name}</span><button data-index="${i}">&times;</button>`;
    chip.querySelector('button').onclick = () => {
      attachments.splice(i, 1);
      renderAttachments();
    };
    attachmentsBar.appendChild(chip);
  });
}

function attachFile() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*,.pdf,.txt,.csv,.json,.html';
  input.onchange = () => {
    const file = input.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const base64 = reader.result.split(',')[1];
      attachments.push({
        type: 'file',
        name: file.name,
        mimeType: file.type,
        data: base64,
      });
      renderAttachments();
    };
    reader.readAsDataURL(file);
  };
  input.click();
}

async function attachPageContext() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return;

    attachments.push({
      type: 'page_context',
      name: `Page: ${tab.title}`,
      mimeType: 'text/plain',
      data: `URL: ${tab.url}\nTitle: ${tab.title}`,
    });
    renderAttachments();
  } catch (e) {
    console.error('Failed to get page context:', e);
  }
}

// ---- Auto-resize ----

function autoResize() {
  promptInput.style.height = 'auto';
  promptInput.style.height = Math.min(promptInput.scrollHeight, 120) + 'px';
}

// ---- Conversation Management ----

async function switchConversation(id) {
  activeConversationId = id;
  sessionId = id;
  await setActiveConversationId(id);

  const messages = await loadConversation(id);
  renderConversation(messages);

  // Reset streaming state
  currentTextBuffer = '';
  currentThinkingBuffer = '';
  pendingTurn = [];
  currentToolMeta.clear();
  setRunning(false);

  conversationsOverlay.style.display = 'none';
}

async function startNewConversation() {
  let url = '';
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) url = tab.url;
  } catch { /* ignore */ }

  const conv = await createConversation(url);
  activeConversationId = conv.id;
  sessionId = conv.id;
  await setActiveConversationId(conv.id);

  renderConversation([]);
  currentTextBuffer = '';
  currentThinkingBuffer = '';
  pendingTurn = [];
  currentToolMeta.clear();
  setRunning(false);

  conversationsOverlay.style.display = 'none';
}

async function handleDeleteConversation(id) {
  await deleteConversation(id);

  // If deleted the active conversation, switch
  if (id === activeConversationId) {
    const index = await loadConversationIndex();
    if (index.length > 0) {
      await switchConversation(index[0].id);
    } else {
      await startNewConversation();
    }
  }

  await renderConversationList();
}

async function renderConversationList() {
  const index = await loadConversationIndex();
  conversationsList.innerHTML = '';

  if (index.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'conv-empty';
    empty.textContent = 'No conversations yet';
    conversationsList.appendChild(empty);
    return;
  }

  for (const conv of index) {
    const entry = document.createElement('div');
    entry.className = 'conv-entry' + (conv.id === activeConversationId ? ' active' : '');

    const info = document.createElement('div');
    info.className = 'conv-info';
    info.onclick = () => switchConversation(conv.id);

    const title = document.createElement('div');
    title.className = 'conv-title';
    title.textContent = conv.title || 'New Conversation';
    info.appendChild(title);

    const meta = document.createElement('div');
    meta.className = 'conv-meta';
    const date = new Date(conv.updatedAt);
    meta.textContent = formatRelativeTime(date);
    if (conv.messageCount) {
      meta.textContent += ` \u00B7 ${conv.messageCount} msgs`;
    }
    info.appendChild(meta);

    if (conv.previewText) {
      const preview = document.createElement('div');
      preview.className = 'conv-preview';
      preview.textContent = conv.previewText;
      info.appendChild(preview);
    }

    entry.appendChild(info);

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'conv-delete';
    deleteBtn.innerHTML = '&times;';
    deleteBtn.title = 'Delete conversation';
    deleteBtn.onclick = (e) => {
      e.stopPropagation();
      handleDeleteConversation(conv.id);
    };
    entry.appendChild(deleteBtn);

    conversationsList.appendChild(entry);
  }
}

function formatRelativeTime(date) {
  const now = Date.now();
  const diff = now - date.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return date.toLocaleDateString();
}

// ---- Boot / Restore ----

async function boot() {
  // Load settings
  const settingsResult = await chrome.storage.local.get(['serverUrl', 'apiKey', 'currentMode', 'currentModel']);
  if (settingsResult.serverUrl) {
    serverUrl = settingsResult.serverUrl;
    settingServerUrl.value = serverUrl;
  }
  if (settingsResult.apiKey) {
    apiKey = settingsResult.apiKey;
    document.getElementById('setting-api-key').value = apiKey;
  }
  if (settingsResult.currentMode) {
    setMode(settingsResult.currentMode);
  }
  if (settingsResult.currentModel) {
    currentModel = settingsResult.currentModel;
    document.getElementById('setting-model').value = currentModel;
  }

  // Configure server storage layer
  setServerConfig(serverUrl, apiKey);

  // Load or create active conversation
  let convId = await getActiveConversationId();
  const index = await loadConversationIndex();

  if (!convId || !index.find(c => c.id === convId)) {
    // No active conversation or it was deleted — create new one
    let url = '';
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab) url = tab.url;
    } catch { /* ignore */ }

    const conv = await createConversation(url);
    convId = conv.id;
  }

  activeConversationId = convId;
  sessionId = convId;

  // Restore messages
  const messages = await loadConversation(convId);
  renderConversation(messages);

  // Connect WebSocket
  connectWebSocket();
}

// ---- Event Listeners ----

btnSend.addEventListener('click', sendPrompt);
btnCancel.addEventListener('click', cancelTask);
btnAttach.addEventListener('click', attachFile);
btnPage.addEventListener('click', attachPageContext);

// Mode chip handlers
document.querySelectorAll('.mode-chip').forEach((chip) => {
  chip.addEventListener('click', () => {
    setMode(chip.dataset.mode);
  });
});

promptInput.addEventListener('input', () => {
  autoResize();
  // Slash command popup
  const val = promptInput.value;
  if (val.startsWith('/') && !val.includes(' ')) {
    showSlashPopup(val);
  } else {
    hideSlashPopup();
  }
});

promptInput.addEventListener('blur', () => {
  // Delay to allow click on popup items
  setTimeout(hideSlashPopup, 150);
});

promptInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendPrompt();
  }
  if (e.key === 'Escape') {
    hideSlashPopup();
  }
});

// Settings
btnSettingsSave.addEventListener('click', () => {
  serverUrl = settingServerUrl.value.trim();
  apiKey = document.getElementById('setting-api-key').value.trim();
  currentModel = document.getElementById('setting-model').value;
  chrome.storage.local.set({ serverUrl, apiKey, currentModel });
  setServerConfig(serverUrl, apiKey);
  settingsOverlay.style.display = 'none';
  connectWebSocket();
});

btnSettingsCancel.addEventListener('click', () => {
  settingsOverlay.style.display = 'none';
});

// Settings
btnSettings.addEventListener('click', () => {
  settingServerUrl.value = serverUrl;
  document.getElementById('setting-api-key').value = apiKey;
  document.getElementById('setting-model').value = currentModel;
  settingsOverlay.style.display = 'flex';
});

settingsOverlay.addEventListener('click', (e) => {
  if (e.target === settingsOverlay) {
    settingsOverlay.style.display = 'none';
  }
});

// Conversation list
btnConversations.addEventListener('click', async () => {
  await renderConversationList();
  conversationsOverlay.style.display = 'flex';
});

btnNewConversation.addEventListener('click', startNewConversation);

btnConversationsClose.addEventListener('click', () => {
  conversationsOverlay.style.display = 'none';
});

// Close overlay on background click
conversationsOverlay.addEventListener('click', (e) => {
  if (e.target === conversationsOverlay) {
    conversationsOverlay.style.display = 'none';
  }
});

// Ping to keep alive
setInterval(() => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'ping', sessionId }));
  }
}, 30000);

// ---- Approval Dialog ----

const approvalOverlay = document.getElementById('approval-overlay');
const approvalBadge = document.getElementById('approval-badge');
const approvalToolName = document.getElementById('approval-tool-name');
const approvalReason = document.getElementById('approval-reason');
const approvalInput = document.getElementById('approval-input');
const btnApprovalDeny = document.getElementById('btn-approval-deny');
const btnApprovalApprove = document.getElementById('btn-approval-approve');
const btnApprovalAlways = document.getElementById('btn-approval-always');

function showApprovalDialog(approval) {
  if (!approval) return;
  pendingApproval = approval;

  approvalBadge.textContent = (approval.trustLevel || 'DANGEROUS').toUpperCase();
  approvalBadge.className = 'trust-badge ' + (approval.trustLevel || 'dangerous');
  approvalToolName.textContent = formatToolName(approval.toolName);
  approvalReason.textContent = approval.reason || 'Action requires approval';

  try {
    approvalInput.textContent = JSON.stringify(JSON.parse(approval.toolInput), null, 2);
  } catch {
    approvalInput.textContent = approval.toolInput || '';
  }

  approvalOverlay.style.display = 'flex';
}

function sendApprovalResponse(response) {
  if (!pendingApproval || !ws || ws.readyState !== WebSocket.OPEN) return;

  ws.send(JSON.stringify({
    type: 'approval_response',
    sessionId: sessionId,
    approvalId: pendingApproval.id,
    approvalResponse: response,
    toolName: pendingApproval.toolName,
  }));

  pendingApproval = null;
  approvalOverlay.style.display = 'none';
}

if (btnApprovalDeny) {
  btnApprovalDeny.addEventListener('click', () => sendApprovalResponse('deny'));
}
if (btnApprovalApprove) {
  btnApprovalApprove.addEventListener('click', () => sendApprovalResponse('approve'));
}
if (btnApprovalAlways) {
  btnApprovalAlways.addEventListener('click', () => sendApprovalResponse('approve_always'));
}
if (approvalOverlay) {
  approvalOverlay.addEventListener('click', (e) => {
    if (e.target === approvalOverlay) sendApprovalResponse('deny');
  });
}

// Start
boot();
