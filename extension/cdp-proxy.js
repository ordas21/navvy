// CDP Proxy — Extension side
// Connects to the MCP server via WebSocket and routes CDP commands
// through the chrome.debugger API.

(() => {
  const PROXY_PORT = 9223;
  const RECONNECT_INTERVAL_MS = 3000;

  let ws = null;
  let reconnectTimer = null;

  // Track which tabs have the debugger attached
  const attachedTabs = new Set();

  // Track event subscriptions: tabId → Set<eventName>
  const eventSubscriptions = new Map();

  // Track pending wait-for-event requests: "tabId:eventName" → { id, timer }
  const waitForEventRequests = new Map();

  // ---- WebSocket Connection ----

  function connect() {
    if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) {
      return;
    }

    try {
      ws = new WebSocket(`ws://localhost:${PROXY_PORT}`);
    } catch {
      scheduleReconnect();
      return;
    }

    ws.onopen = () => {
      console.log('[Navvy CDP Proxy] Connected to MCP server');
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        handleMessage(msg);
      } catch {
        // Ignore malformed messages
      }
    };

    ws.onclose = () => {
      console.log('[Navvy CDP Proxy] Disconnected from MCP server');
      ws = null;
      scheduleReconnect();
    };

    ws.onerror = () => {
      // Will trigger onclose
    };
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, RECONNECT_INTERVAL_MS);
  }

  function send(msg) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  // ---- Message Handling ----

  function handleMessage(msg) {
    switch (msg.type) {
      case 'cdp_request':
        handleCDPRequest(msg);
        break;
      case 'tab_request':
        handleTabRequest(msg);
        break;
      case 'subscribe_events':
        handleSubscribeEvents(msg);
        break;
      case 'unsubscribe_events':
        handleUnsubscribeEvents(msg);
        break;
      case 'wait_for_event':
        handleWaitForEvent(msg);
        break;
      case 'ping':
        send({ type: 'pong' });
        break;
    }
  }

  // ---- Debugger Management ----

  async function ensureAttached(tabId) {
    if (attachedTabs.has(tabId)) return;

    await new Promise((resolve, reject) => {
      chrome.debugger.attach({ tabId }, '1.3', () => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          attachedTabs.add(tabId);
          resolve();
        }
      });
    });
  }

  async function executeCDPCommand(tabId, method, params) {
    await ensureAttached(tabId);

    return new Promise((resolve, reject) => {
      chrome.debugger.sendCommand({ tabId }, method, params || {}, (result) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(result);
        }
      });
    });
  }

  // ---- CDP Request Handler ----

  async function handleCDPRequest(msg) {
    const { id, tabId, method, params } = msg;
    try {
      const result = await executeCDPCommand(tabId, method, params);
      send({ type: 'cdp_response', id, result: result || {} });
    } catch (err) {
      send({ type: 'cdp_response', id, error: err.message });
    }
  }

  // ---- Tab Request Handler ----

  async function handleTabRequest(msg) {
    const { id, action, tabId, url } = msg;
    try {
      let result;
      switch (action) {
        case 'list': {
          const tabs = await chrome.tabs.query({});
          result = tabs
            .filter(t =>
              !t.url.startsWith('chrome-extension://') &&
              !t.url.startsWith('chrome://') &&
              !t.url.startsWith('devtools://') &&
              !t.url.startsWith('about:')
            )
            .map(t => ({ id: t.id, title: t.title || '', url: t.url || '' }));
          break;
        }
        case 'activate': {
          await chrome.tabs.update(tabId, { active: true });
          result = {};
          break;
        }
        case 'create': {
          const tab = await chrome.tabs.create({ url: url || 'about:blank' });
          result = { id: tab.id };
          break;
        }
        case 'close': {
          // Clean up debugger if attached
          if (attachedTabs.has(tabId)) {
            try {
              await new Promise((resolve) => {
                chrome.debugger.detach({ tabId }, () => {
                  chrome.runtime.lastError; // Clear any error
                  resolve();
                });
              });
            } catch { /* ignore */ }
            attachedTabs.delete(tabId);
          }
          await chrome.tabs.remove(tabId);
          result = {};
          break;
        }
        case 'getActive': {
          const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (activeTab) {
            result = { id: activeTab.id, title: activeTab.title || '', url: activeTab.url || '' };
          } else {
            result = null;
          }
          break;
        }
        default:
          throw new Error(`Unknown tab action: ${action}`);
      }
      send({ type: 'tab_response', id, result });
    } catch (err) {
      send({ type: 'tab_response', id, error: err.message });
    }
  }

  // ---- Event Subscription ----

  function handleSubscribeEvents(msg) {
    const { tabId, events } = msg;
    if (!eventSubscriptions.has(tabId)) {
      eventSubscriptions.set(tabId, new Set());
    }
    const subs = eventSubscriptions.get(tabId);
    for (const event of events) {
      subs.add(event);
    }
    // Enable the relevant domain if needed (e.g., "Network.requestWillBeSent" → enable Network)
    for (const event of events) {
      const domain = event.split('.')[0];
      // Domains are enabled on first CDP command via ensureAttached + domain.enable,
      // but the MCP server already calls .enable() on getClient, so this is handled.
    }
  }

  function handleUnsubscribeEvents(msg) {
    const { tabId, events } = msg;
    const subs = eventSubscriptions.get(tabId);
    if (!subs) return;
    for (const event of events) {
      subs.delete(event);
    }
    if (subs.size === 0) {
      eventSubscriptions.delete(tabId);
    }
  }

  // ---- Wait For Event ----

  function handleWaitForEvent(msg) {
    const { id, tabId, eventName, timeoutMs } = msg;
    const key = `${tabId}:${eventName}`;

    const timer = setTimeout(() => {
      waitForEventRequests.delete(key);
      send({ type: 'wait_for_event_response', id, result: {} });
    }, timeoutMs || 30000);

    waitForEventRequests.set(key, { id, timer });
  }

  // ---- chrome.debugger Event Listener ----

  chrome.debugger.onEvent.addListener((source, method, params) => {
    const tabId = source.tabId;
    if (!tabId) return;

    // Forward subscribed events to MCP server
    const subs = eventSubscriptions.get(tabId);
    if (subs && subs.has(method)) {
      send({
        type: 'cdp_event',
        tabId,
        method,
        params: params || {},
      });
    }

    // Resolve wait-for-event requests
    const waitKey = `${tabId}:${method}`;
    const waiting = waitForEventRequests.get(waitKey);
    if (waiting) {
      clearTimeout(waiting.timer);
      waitForEventRequests.delete(waitKey);
      send({
        type: 'wait_for_event_response',
        id: waiting.id,
        result: params || {},
      });
    }
  });

  // ---- chrome.debugger Detach Listener ----

  chrome.debugger.onDetach.addListener((source, reason) => {
    const tabId = source.tabId;
    if (!tabId) return;

    attachedTabs.delete(tabId);
    eventSubscriptions.delete(tabId);

    // Clean up any waiting requests for this tab
    for (const [key, waiting] of waitForEventRequests) {
      if (key.startsWith(`${tabId}:`)) {
        clearTimeout(waiting.timer);
        waitForEventRequests.delete(key);
        send({
          type: 'wait_for_event_response',
          id: waiting.id,
          error: `Debugger detached: ${reason}`,
        });
      }
    }

    send({
      type: 'debugger_detached',
      tabId,
      reason,
    });
  });

  // ---- Start Connection ----

  connect();
})();
