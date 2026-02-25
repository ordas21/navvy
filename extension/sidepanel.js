/* global chrome */

const DEFAULT_SERVER_URL = 'ws://localhost:3300/ws';

// State
let ws = null;
let sessionId = crypto.randomUUID();
let isRunning = false;
let attachments = [];
let serverUrl = DEFAULT_SERVER_URL;

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

// Load settings
chrome.storage.local.get(['serverUrl'], (result) => {
  if (result.serverUrl) {
    serverUrl = result.serverUrl;
    settingServerUrl.value = serverUrl;
  }
  connectWebSocket();
});

// WebSocket connection
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
    // Reconnect after delay
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

function handleServerMessage(msg) {
  switch (msg.type) {
    case 'assistant_text':
      appendOrUpdateAssistantMessage(msg.text);
      break;
    case 'tool_use':
      addToolMessage(`${msg.toolName}`, JSON.stringify(msg.toolInput, null, 2));
      break;
    case 'tool_result':
      addToolMessage('result', msg.toolResult);
      break;
    case 'done':
      setRunning(false);
      setStatus('connected', 'Connected');
      addStatusMessage('Task completed');
      break;
    case 'error':
      addErrorMessage(msg.error);
      setRunning(false);
      setStatus('connected', 'Connected');
      break;
    case 'status':
      setStatus('thinking', msg.status || 'Thinking...');
      break;
    case 'pong':
      break;
  }
}

// Message rendering
let currentAssistantMsgEl = null;

function appendOrUpdateAssistantMessage(text) {
  if (!currentAssistantMsgEl) {
    currentAssistantMsgEl = addMessage('assistant', text);
  } else {
    currentAssistantMsgEl.textContent += text;
  }
  scrollToBottom();
}

function addMessage(type, text) {
  const el = document.createElement('div');
  el.className = `message ${type}`;
  el.textContent = text;
  messagesEl.appendChild(el);
  scrollToBottom();
  return el;
}

function addToolMessage(name, detail) {
  const el = document.createElement('div');
  el.className = 'message tool';
  const nameEl = document.createElement('div');
  nameEl.className = 'tool-name';
  nameEl.textContent = name;
  el.appendChild(nameEl);
  if (detail) {
    const detailEl = document.createElement('div');
    detailEl.textContent = detail;
    el.appendChild(detailEl);
  }
  messagesEl.appendChild(el);
  scrollToBottom();
}

function addErrorMessage(text) {
  addMessage('error', text);
}

function addStatusMessage(text) {
  addMessage('status', text);
}

function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

// Status
function setStatus(state, text) {
  statusDot.className = state;
  statusText.textContent = text;
}

// Running state
function setRunning(running) {
  isRunning = running;
  btnSend.style.display = running ? 'none' : 'flex';
  btnCancel.style.display = running ? 'flex' : 'none';
  promptInput.disabled = running;
  currentAssistantMsgEl = null;
}

// Send prompt
function sendPrompt() {
  const text = promptInput.value.trim();
  if (!text || !ws || ws.readyState !== WebSocket.OPEN) return;

  addMessage('user', text);
  currentAssistantMsgEl = null;

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
}

function cancelTask() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'cancel', sessionId }));
  }
  setRunning(false);
  setStatus('connected', 'Connected');
  addStatusMessage('Task cancelled');
}

// Attachments
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

// Auto-resize textarea
function autoResize() {
  promptInput.style.height = 'auto';
  promptInput.style.height = Math.min(promptInput.scrollHeight, 120) + 'px';
}

// Event listeners
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

// Ping to keep alive
setInterval(() => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'ping', sessionId }));
  }
}, 30000);
