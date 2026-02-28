/* global chrome */

// ---- Server-Backed Conversation Storage Module ----
// Thin layer over server REST API with chrome.storage fallback for settings

let _serverBaseUrl = 'http://localhost:3300';
let _apiKey = '';

function setServerConfig(baseUrl, apiKey) {
  // Extract HTTP base from WebSocket URL
  _serverBaseUrl = baseUrl
    .replace(/^ws:/, 'http:')
    .replace(/^wss:/, 'https:')
    .replace(/\/ws\/?$/, '');
  _apiKey = apiKey || '';
}

async function serverFetch(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...options.headers };
  if (_apiKey) {
    headers['X-API-Key'] = _apiKey;
  }
  const url = `${_serverBaseUrl}${path}`;
  const res = await fetch(url, { ...options, headers });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Server error ${res.status}: ${body}`);
  }
  return res.json();
}

// ---- Conversation Index ----

async function loadConversationIndex() {
  try {
    const data = await serverFetch('/api/conversations?limit=100');
    return data.conversations || [];
  } catch (e) {
    console.warn('[storage] Server unavailable, using local fallback:', e.message);
    const result = await chrome.storage.local.get('conversationIndex');
    return result.conversationIndex || [];
  }
}

async function saveConversationIndex(_index) {
  // No-op for server mode — server manages the index
  // Keep for API compatibility
}

async function updateConversationIndex(id, updates) {
  try {
    if (updates.title) {
      await serverFetch(`/api/conversations/${id}`, {
        method: 'PUT',
        body: JSON.stringify({ title: updates.title }),
      });
    }
  } catch (e) {
    console.warn('[storage] Failed to update conversation index on server:', e.message);
  }
}

// ---- Active Conversation ----

async function getActiveConversationId() {
  const result = await chrome.storage.local.get('activeConversationId');
  return result.activeConversationId || null;
}

async function setActiveConversationId(id) {
  await chrome.storage.local.set({ activeConversationId: id });
}

// ---- Conversation CRUD ----

async function createConversation(url) {
  try {
    const conv = await serverFetch('/api/conversations', {
      method: 'POST',
      body: JSON.stringify({ url: url || '' }),
    });
    await setActiveConversationId(conv.id);
    return conv;
  } catch (e) {
    console.warn('[storage] Server unavailable for create, using local:', e.message);
    // Fallback to local
    const id = 'conv-' + crypto.randomUUID().slice(0, 12);
    const now = Date.now();
    const entry = {
      id,
      title: 'New Conversation',
      url: url || '',
      createdAt: now,
      updatedAt: now,
      messageCount: 0,
      previewText: '',
    };
    await chrome.storage.local.set({ [`conv:${id}`]: [] });
    await setActiveConversationId(id);
    return entry;
  }
}

async function loadConversation(id) {
  try {
    const data = await serverFetch(`/api/conversations/${id}`);
    return data.messages || [];
  } catch (e) {
    console.warn('[storage] Server unavailable for load, using local:', e.message);
    const result = await chrome.storage.local.get(`conv:${id}`);
    return result[`conv:${id}`] || [];
  }
}

async function saveConversation(id, messages) {
  // In server mode, messages are appended individually
  // This is a legacy method — prefer appendToConversation
  await chrome.storage.local.set({ [`conv:${id}`]: messages });
}

// Debounce buffer for batching storage writes
const _pendingAppends = new Map();

async function appendToConversation(id, records) {
  let pending = _pendingAppends.get(id);
  if (!pending) {
    pending = { records: [], timer: null };
    _pendingAppends.set(id, pending);
  }
  pending.records.push(...records);

  if (pending.timer) clearTimeout(pending.timer);
  pending.timer = setTimeout(() => _flushAppend(id), 500);
}

async function flushAllPendingAppends() {
  for (const id of _pendingAppends.keys()) {
    await _flushAppend(id);
  }
}

async function _flushAppend(id) {
  const pending = _pendingAppends.get(id);
  if (!pending || pending.records.length === 0) return;

  const records = pending.records.splice(0);
  clearTimeout(pending.timer);
  pending.timer = null;
  _pendingAppends.delete(id);

  // Send to server
  for (const record of records) {
    try {
      await serverFetch(`/api/conversations/${id}/messages`, {
        method: 'POST',
        body: JSON.stringify({
          type: record.type,
          text: record.text || '',
          data: record.cost || record.toolName ? {
            cost: record.cost,
            toolName: record.toolName,
            toolId: record.toolId,
            input: record.input,
            result: record.result,
          } : undefined,
        }),
      });
    } catch (e) {
      console.warn('[storage] Failed to append message to server:', e.message);
    }
  }

  // Update title from first user message
  const lastUserMsg = [...records].reverse().find(r => r.type === 'user');
  if (lastUserMsg) {
    try {
      const data = await serverFetch(`/api/conversations/${id}`);
      if (data.title === 'New Conversation') {
        await serverFetch(`/api/conversations/${id}`, {
          method: 'PUT',
          body: JSON.stringify({ title: lastUserMsg.text.slice(0, 50) || 'New Conversation' }),
        });
      }
    } catch { /* ignore */ }
  }
}

async function deleteConversation(id) {
  try {
    await serverFetch(`/api/conversations/${id}`, { method: 'DELETE' });
  } catch (e) {
    console.warn('[storage] Failed to delete on server:', e.message);
  }

  // Clean up local state
  const activeId = await getActiveConversationId();
  if (activeId === id) {
    await chrome.storage.local.remove('activeConversationId');
  }
}

// ---- Storage Pruning (handled by server now) ----

async function checkStorageUsage() {
  return 0;
}
