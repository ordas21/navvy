/* global chrome, loadConversationIndex, loadConversation, appendToConversation,
   createConversation, deleteConversation, updateConversationIndex,
   getActiveConversationId, setActiveConversationId, checkStorageUsage */

const DEFAULT_SERVER_URL = 'ws://localhost:3300/ws';

// State
let ws = null;
let sessionId = null;
let activeConversationId = null;
let isRunning = false;
let attachments = [];
let serverUrl = DEFAULT_SERVER_URL;

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
const btnConversations = document.getElementById('btn-conversations');
const conversationsOverlay = document.getElementById('conversations-overlay');
const conversationsList = document.getElementById('conversations-list');
const btnNewConversation = document.getElementById('btn-new-conversation');
const btnConversationsClose = document.getElementById('btn-conversations-close');

// ---- Render Functions (reusable for both streaming and restore) ----

function renderUserMessage(text) {
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
  content.textContent = text;
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
  name.textContent = toolName;
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

  el.innerHTML = `
    <span class="cost-item">${costStr}</span>
    <span class="cost-sep">\u00B7</span>
    <span class="cost-item">${cost.numTurns} turns</span>
    <span class="cost-sep">\u00B7</span>
    <span class="cost-item">${duration}s</span>
    <span class="cost-sep">\u00B7</span>
    <span class="cost-item">${(cost.inputTokens + cost.outputTokens).toLocaleString()} tokens</span>
  `;
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
      </div>`;
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

  scrollToBottom();
}

// ---- WebSocket Connection ----

function connectWebSocket() {
  if (ws) {
    ws.close();
  }

  ws = new WebSocket(serverUrl);

  ws.onopen = () => {
    setStatus('connected', 'Connected');
  };

  ws.onclose = () => {
    setStatus('disconnected', 'Disconnected');
    setTimeout(connectWebSocket, 3000);
  };

  ws.onerror = () => {
    setStatus('disconnected', 'Connection error');
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
      // Reset streaming elements for next turn
      currentTextEl = null;
      currentThinkingEl = null;
      currentToolInputEl = null;
      break;

    case 'done':
      // Final flush
      flushTextBuffer();
      flushThinkingBuffer();
      if (pendingTurn.length > 0 && activeConversationId) {
        appendToConversation(activeConversationId, pendingTurn).catch(console.error);
        pendingTurn = [];
      }
      setRunning(false);
      setStatus('connected', 'Done');
      checkStorageUsage().catch(console.error);
      break;

    case 'error':
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
  content.textContent += text;
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
  name.textContent = toolName;
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

    if (resultText && resultText.length > 300) {
      toolEl.classList.add('collapsed');
    }
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
  if (!text || !ws || ws.readyState !== WebSocket.OPEN) return;

  // Render and persist user message immediately
  renderUserMessage(text);
  if (activeConversationId) {
    appendToConversation(activeConversationId, [{ type: 'user', text, ts: Date.now() }]).catch(console.error);
  }

  const msg = {
    type: 'prompt',
    sessionId,
    prompt: text,
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

function cancelTask() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'cancel', sessionId }));
  }
  // Flush any pending accumulator data before cancelling
  flushTextBuffer();
  flushThinkingBuffer();
  if (pendingTurn.length > 0 && activeConversationId) {
    appendToConversation(activeConversationId, pendingTurn).catch(console.error);
    pendingTurn = [];
  }
  setRunning(false);
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
  const settingsResult = await chrome.storage.local.get(['serverUrl']);
  if (settingsResult.serverUrl) {
    serverUrl = settingsResult.serverUrl;
    settingServerUrl.value = serverUrl;
  }

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

promptInput.addEventListener('input', autoResize);
promptInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendPrompt();
  }
});

// Settings
btnSettingsSave.addEventListener('click', () => {
  serverUrl = settingServerUrl.value.trim();
  chrome.storage.local.set({ serverUrl });
  settingsOverlay.style.display = 'none';
  connectWebSocket();
});

btnSettingsCancel.addEventListener('click', () => {
  settingsOverlay.style.display = 'none';
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

// Start
boot();
