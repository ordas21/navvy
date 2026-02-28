import { WebSocketServer, WebSocket } from 'ws';

// ---- Types ----

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface ProxyTab {
  id: number;
  title: string;
  url: string;
}

type EventHandler = (params: object) => void;

// ---- State ----

let wss: WebSocketServer | null = null;
let extensionSocket: WebSocket | null = null;
let requestIdCounter = 0;
const pendingRequests = new Map<number, PendingRequest>();
const eventListeners = new Map<string, Set<EventHandler>>(); // "tabId:eventName" → handlers
let keepAliveInterval: ReturnType<typeof setInterval> | null = null;

const PROXY_PORT = parseInt(process.env.NAVVY_CDP_PROXY_PORT || '9223', 10);
const REQUEST_TIMEOUT_MS = 30_000;

// ---- WebSocket Server ----

export async function startProxyServer(): Promise<void> {
  if (wss) return;

  wss = new WebSocketServer({ port: PROXY_PORT });

  wss.on('connection', (ws) => {
    // Only allow one extension connection at a time
    if (extensionSocket && extensionSocket.readyState === WebSocket.OPEN) {
      extensionSocket.close();
    }
    extensionSocket = ws;

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        handleExtensionMessage(msg);
      } catch {
        // Ignore malformed messages
      }
    });

    ws.on('close', () => {
      if (extensionSocket === ws) {
        extensionSocket = null;
        // Reject all pending requests
        for (const [id, pending] of pendingRequests) {
          clearTimeout(pending.timer);
          pending.reject(new Error('Extension disconnected'));
          pendingRequests.delete(id);
        }
      }
    });

    ws.on('error', () => {
      // Handled by close event
    });
  });

  // Keep-alive ping every 20s to prevent service worker suspension
  keepAliveInterval = setInterval(() => {
    if (extensionSocket && extensionSocket.readyState === WebSocket.OPEN) {
      sendToExtension({ type: 'ping' });
    }
  }, 20_000);

  await new Promise<void>((resolve) => {
    wss!.on('listening', resolve);
  });
}

export function stopProxyServer(): void {
  if (keepAliveInterval) {
    clearInterval(keepAliveInterval);
    keepAliveInterval = null;
  }
  if (wss) {
    wss.close();
    wss = null;
  }
  extensionSocket = null;
}

export function isExtensionConnected(): boolean {
  return extensionSocket !== null && extensionSocket.readyState === WebSocket.OPEN;
}

// ---- Message Handling ----

function sendToExtension(msg: object): void {
  if (!extensionSocket || extensionSocket.readyState !== WebSocket.OPEN) {
    throw new Error('Extension not connected. Open the Navvy extension in Chrome first.');
  }
  extensionSocket.send(JSON.stringify(msg));
}

function handleExtensionMessage(msg: { type: string; id?: number; [key: string]: unknown }): void {
  switch (msg.type) {
    case 'cdp_response':
    case 'tab_response':
    case 'wait_for_event_response': {
      const pending = pendingRequests.get(msg.id!);
      if (pending) {
        clearTimeout(pending.timer);
        pendingRequests.delete(msg.id!);
        if (msg.error) {
          pending.reject(new Error(msg.error as string));
        } else {
          pending.resolve(msg.result);
        }
      }
      break;
    }

    case 'cdp_event': {
      const tabId = msg.tabId as number;
      const method = msg.method as string;
      const params = (msg.params || {}) as object;
      const key = `${tabId}:${method}`;
      const handlers = eventListeners.get(key);
      if (handlers) {
        for (const handler of handlers) {
          try { handler(params); } catch { /* ignore handler errors */ }
        }
      }
      break;
    }

    case 'debugger_detached': {
      // Extension notified us that debugger was detached from a tab
      // Clean up event listeners for this tab
      const tabId = msg.tabId as number;
      for (const key of eventListeners.keys()) {
        if (key.startsWith(`${tabId}:`)) {
          eventListeners.delete(key);
        }
      }
      break;
    }

    case 'pong':
      // Keep-alive response, nothing to do
      break;
  }
}

function sendRequest(type: string, payload: object): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = ++requestIdCounter;
    const timer = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error(`Proxy request timed out (${type})`));
    }, REQUEST_TIMEOUT_MS);

    pendingRequests.set(id, { resolve, reject, timer });
    sendToExtension({ type, id, ...payload });
  });
}

// ---- CDP Proxy Client ----

/**
 * Creates a proxy object that mimics the CDP.Client interface.
 * Property access like `client.Runtime.evaluate(params)` is intercepted
 * and routed through the WebSocket to the extension.
 */
export function createProxyClient(tabId: number): CDPProxyClient {
  const domainProxies = new Map<string, object>();

  const client = {
    _tabId: tabId,
    _eventHandlers: new Map<string, Set<EventHandler>>(),

    on(eventName: string, handler: EventHandler): void {
      // Register local handler
      const key = `${tabId}:${eventName}`;
      if (!eventListeners.has(key)) {
        eventListeners.set(key, new Set());
      }
      eventListeners.get(key)!.add(handler);

      // Track on client for cleanup
      if (!client._eventHandlers.has(eventName)) {
        client._eventHandlers.set(eventName, new Set());
      }
      client._eventHandlers.get(eventName)!.add(handler);

      // Tell extension to subscribe
      sendToExtension({
        type: 'subscribe_events',
        tabId,
        events: [eventName],
      });
    },

    removeListener(eventName: string, handler: EventHandler): void {
      const key = `${tabId}:${eventName}`;
      const handlers = eventListeners.get(key);
      if (handlers) {
        handlers.delete(handler);
        if (handlers.size === 0) {
          eventListeners.delete(key);
          // Tell extension to unsubscribe
          sendToExtension({
            type: 'unsubscribe_events',
            tabId,
            events: [eventName],
          });
        }
      }
      client._eventHandlers.get(eventName)?.delete(handler);
    },

    close(): void {
      // Unsubscribe all events for this client
      for (const [eventName, handlers] of client._eventHandlers) {
        const key = `${tabId}:${eventName}`;
        const globalHandlers = eventListeners.get(key);
        if (globalHandlers) {
          for (const h of handlers) {
            globalHandlers.delete(h);
          }
          if (globalHandlers.size === 0) {
            eventListeners.delete(key);
          }
        }
      }
      client._eventHandlers.clear();
    },
  };

  // Return a Proxy that intercepts domain access (e.g., client.Runtime, client.Page)
  return new Proxy(client, {
    get(target, prop: string) {
      // Return built-in methods directly
      if (prop in target) {
        return (target as Record<string, unknown>)[prop];
      }

      // Check for cached domain proxy
      if (domainProxies.has(prop)) {
        return domainProxies.get(prop);
      }

      // Create a domain proxy (e.g., client.Page → proxy that handles .navigate(), .enable(), etc.)
      const domainProxy = new Proxy({}, {
        get(_domTarget, method: string) {
          return async (params?: object) => {
            const fullMethod = `${prop}.${method}`;

            // Special case: loadEventFired and similar wait-for-event patterns
            if (method === 'loadEventFired') {
              return sendRequest('wait_for_event', {
                tabId,
                eventName: `${prop}.${method}`,
                timeoutMs: REQUEST_TIMEOUT_MS,
              });
            }

            // Standard CDP command
            return sendRequest('cdp_request', {
              tabId,
              method: fullMethod,
              params: params || {},
            });
          };
        },
      });

      domainProxies.set(prop, domainProxy);
      return domainProxy;
    },
  }) as CDPProxyClient;
}

export interface CDPProxyClient {
  _tabId: number;
  on(event: string, handler: EventHandler): void;
  removeListener(event: string, handler: EventHandler): void;
  close(): void;
  // Dynamic domain access via Proxy — e.g., client.Page.navigate()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [domain: string]: any;
}

// ---- Tab Management via Extension ----

export async function proxyListTabs(): Promise<ProxyTab[]> {
  const result = await sendRequest('tab_request', { action: 'list' });
  return result as ProxyTab[];
}

export async function proxyActivateTab(tabId: number): Promise<void> {
  await sendRequest('tab_request', { action: 'activate', tabId });
}

export async function proxyCreateTab(url?: string): Promise<number> {
  const result = await sendRequest('tab_request', {
    action: 'create',
    url: url || 'about:blank',
  });
  return (result as { id: number }).id;
}

export async function proxyCloseTab(tabId: number): Promise<void> {
  await sendRequest('tab_request', { action: 'close', tabId });
}

export async function proxyGetActiveTab(): Promise<ProxyTab | undefined> {
  const result = await sendRequest('tab_request', { action: 'getActive' });
  return result as ProxyTab | undefined;
}
