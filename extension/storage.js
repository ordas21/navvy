/* global chrome */

// ---- Conversation Storage Module ----

const STORAGE_LIMIT_BYTES = 8 * 1024 * 1024; // 8MB

function generateId() {
  return 'conv-' + crypto.randomUUID().slice(0, 12);
}

// ---- Conversation Index ----

async function loadConversationIndex() {
  const result = await chrome.storage.local.get('conversationIndex');
  return result.conversationIndex || [];
}

async function saveConversationIndex(index) {
  await chrome.storage.local.set({ conversationIndex: index });
}

async function updateConversationIndex(id, updates) {
  const index = await loadConversationIndex();
  const entry = index.find(c => c.id === id);
  if (entry) {
    Object.assign(entry, updates, { updatedAt: Date.now() });
    await saveConversationIndex(index);
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
  const id = generateId();
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

  const index = await loadConversationIndex();
  index.unshift(entry);
  await saveConversationIndex(index);
  await chrome.storage.local.set({ [`conv:${id}`]: [] });
  await setActiveConversationId(id);
  return entry;
}

async function loadConversation(id) {
  const result = await chrome.storage.local.get(`conv:${id}`);
  return result[`conv:${id}`] || [];
}

async function saveConversation(id, messages) {
  await chrome.storage.local.set({ [`conv:${id}`]: messages });
}

async function appendToConversation(id, records) {
  const messages = await loadConversation(id);
  messages.push(...records);
  await saveConversation(id, messages);

  // Update index metadata
  const lastUserMsg = [...records].reverse().find(r => r.type === 'user');
  const updates = { messageCount: messages.length };
  if (lastUserMsg) {
    updates.previewText = lastUserMsg.text.slice(0, 80);
  }
  // Set title from first user message if still default
  const index = await loadConversationIndex();
  const entry = index.find(c => c.id === id);
  if (entry && entry.title === 'New Conversation') {
    const firstUser = messages.find(r => r.type === 'user');
    if (firstUser) {
      updates.title = firstUser.text.slice(0, 50) || 'New Conversation';
    }
  }
  await updateConversationIndex(id, updates);
}

async function deleteConversation(id) {
  const index = await loadConversationIndex();
  const filtered = index.filter(c => c.id !== id);
  await saveConversationIndex(filtered);
  await chrome.storage.local.remove(`conv:${id}`);

  // If we deleted the active conversation, switch to most recent
  const activeId = await getActiveConversationId();
  if (activeId === id) {
    if (filtered.length > 0) {
      await setActiveConversationId(filtered[0].id);
    } else {
      await chrome.storage.local.remove('activeConversationId');
    }
  }
}

// ---- Storage Pruning ----

async function checkStorageUsage() {
  const bytesInUse = await chrome.storage.local.getBytesInUse(null);
  if (bytesInUse < STORAGE_LIMIT_BYTES) return;

  const index = await loadConversationIndex();
  if (index.length <= 1) return;

  // Delete oldest conversations until under limit
  const sorted = [...index].sort((a, b) => a.updatedAt - b.updatedAt);
  const activeId = await getActiveConversationId();

  for (const conv of sorted) {
    if (conv.id === activeId) continue;
    await deleteConversation(conv.id);
    const newBytes = await chrome.storage.local.getBytesInUse(null);
    if (newBytes < STORAGE_LIMIT_BYTES) break;
  }
}
