import CDP from 'chrome-remote-interface';

let client: CDP.Client | null = null;
let currentTargetId: string | null = null;

// ---- Network capture state ----
interface CapturedRequest {
  requestId: string;
  method: string;
  url: string;
  type: string;
  status?: number;
  statusText?: string;
  responseHeaders?: Record<string, string>;
  size: number;
  timestamp: number;
}

const capturedRequests = new Map<string, CapturedRequest>();
let networkListenersAttached = false;

// ---- Console capture state ----
interface CapturedLog {
  level: string;
  text: string;
  timestamp: number;
  url?: string;
  lineNumber?: number;
}

const capturedLogs: CapturedLog[] = [];
let consoleListenersAttached = false;

/**
 * Find the best page target — skip extensions, devtools, and internal pages.
 */
async function findPageTarget(): Promise<string | undefined> {
  const response = await fetch('http://localhost:9222/json');
  const targets = await response.json() as Array<{ id: string; title: string; url: string; type: string }>;
  const page = targets.find(
    (t) =>
      t.type === 'page' &&
      !t.url.startsWith('chrome-extension://') &&
      !t.url.startsWith('chrome://') &&
      !t.url.startsWith('devtools://'),
  );
  return page?.id;
}

export async function getClient(): Promise<CDP.Client> {
  if (client) {
    try {
      // Test if connection is still alive
      await client.Browser.getVersion();
      return client;
    } catch {
      client = null;
      currentTargetId = null;
    }
  }

  const targetId = await findPageTarget();
  if (!targetId) {
    throw new Error('No browser tab found. Open a page in Chrome first.');
  }

  client = await CDP({ port: 9222, target: targetId });
  currentTargetId = targetId;
  // Enable required domains
  await client.Page.enable();
  await client.Runtime.enable();
  await client.DOM.enable();
  await client.Network.enable();
  return client;
}

export async function captureScreenshot(): Promise<string> {
  const cdp = await getClient();
  const { data } = await cdp.Page.captureScreenshot({ format: 'png' });
  return data; // base64
}

export async function navigate(url: string): Promise<void> {
  const cdp = await getClient();
  await cdp.Page.navigate({ url });
  await cdp.Page.loadEventFired();
}

export async function evaluate<T = unknown>(expression: string): Promise<T> {
  const cdp = await getClient();
  const result = await cdp.Runtime.evaluate({
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) {
    throw new Error(
      result.exceptionDetails.text ||
      result.exceptionDetails.exception?.description ||
      'Evaluation failed'
    );
  }
  return result.result.value as T;
}

export async function getPageInfo(): Promise<{ url: string; title: string }> {
  const url = await evaluate<string>('window.location.href');
  const title = await evaluate<string>('document.title');
  return { url, title };
}

export async function getSimplifiedDOM(selector?: string): Promise<string> {
  const rootExpr = selector
    ? `document.querySelector(${JSON.stringify(selector)}) || (function() { throw new Error('Selector not found: ${selector}'); })()`
    : `document.body`;
  return evaluate<string>(`
    (function() {
      function walk(node, depth) {
        if (depth > 8) return '';
        let result = '';
        const indent = '  '.repeat(depth);

        if (node.nodeType === Node.TEXT_NODE) {
          const text = node.textContent.trim();
          if (text && text.length < 200) {
            return indent + JSON.stringify(text) + '\\n';
          }
          return '';
        }

        if (node.nodeType !== Node.ELEMENT_NODE) return '';

        const el = node;
        const tag = el.tagName.toLowerCase();

        // Skip invisible elements
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') return '';

        // Skip script, style, noscript
        if (['script', 'style', 'noscript', 'svg', 'path'].includes(tag)) return '';

        let attrs = '';
        if (el.id) attrs += ' id="' + el.id + '"';
        if (el.className && typeof el.className === 'string') {
          const classes = el.className.trim();
          if (classes) attrs += ' class="' + classes.substring(0, 80) + '"';
        }
        if (el.getAttribute('role')) attrs += ' role="' + el.getAttribute('role') + '"';
        if (el.getAttribute('aria-label')) attrs += ' aria-label="' + el.getAttribute('aria-label') + '"';
        if (el.getAttribute('href')) attrs += ' href="' + el.getAttribute('href').substring(0, 100) + '"';
        if (el.getAttribute('type')) attrs += ' type="' + el.getAttribute('type') + '"';
        if (el.getAttribute('name')) attrs += ' name="' + el.getAttribute('name') + '"';
        if (el.getAttribute('placeholder')) attrs += ' placeholder="' + el.getAttribute('placeholder') + '"';
        if (el.getAttribute('value') && ['input', 'select', 'textarea'].includes(tag)) {
          attrs += ' value="' + el.getAttribute('value').substring(0, 80) + '"';
        }

        const children = Array.from(el.childNodes).map(c => walk(c, depth + 1)).join('');

        if (!children.trim() && !attrs) return '';

        result += indent + '<' + tag + attrs + '>\\n';
        result += children;
        result += indent + '</' + tag + '>\\n';

        return result;
      }
      return walk(${rootExpr}, 0);
    })()
  `);
}

export async function getElementBounds(selector: string): Promise<{
  x: number;
  y: number;
  width: number;
  height: number;
}> {
  return evaluate(`
    (function() {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) throw new Error('Element not found: ${selector}');
      const rect = el.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    })()
  `);
}

export async function getWindowBounds(): Promise<{
  screenX: number;
  screenY: number;
  outerWidth: number;
  outerHeight: number;
  innerWidth: number;
  innerHeight: number;
}> {
  return evaluate(`({
    screenX: window.screenX,
    screenY: window.screenY,
    outerWidth: window.outerWidth,
    outerHeight: window.outerHeight,
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight
  })`);
}

export async function waitForSelector(selector: string, timeoutMs: number = 10000): Promise<boolean> {
  return evaluate<boolean>(`
    new Promise((resolve) => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (el) { resolve(true); return; }
      const timeout = setTimeout(() => { observer.disconnect(); resolve(false); }, ${timeoutMs});
      const observer = new MutationObserver(() => {
        if (document.querySelector(${JSON.stringify(selector)})) {
          observer.disconnect();
          clearTimeout(timeout);
          resolve(true);
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });
    })
  `);
}

export async function listTabs(): Promise<Array<{ id: string; title: string; url: string }>> {
  const response = await fetch('http://localhost:9222/json');
  const targets = await response.json() as Array<{ id: string; title: string; url: string; type: string }>;
  return targets
    .filter(t =>
      t.type === 'page' &&
      !t.url.startsWith('chrome-extension://') &&
      !t.url.startsWith('chrome://') &&
      !t.url.startsWith('devtools://')
    )
    .map(t => ({ id: t.id, title: t.title, url: t.url }));
}

export async function switchTab(tabId: string): Promise<void> {
  await fetch(`http://localhost:9222/json/activate/${tabId}`);
  // Reconnect CDP to the new target
  client = null;
  client = await CDP({ port: 9222, target: tabId });
  await client.Page.enable();
  await client.Runtime.enable();
  await client.DOM.enable();
  await client.Network.enable();
}

export async function scrollPage(direction: 'up' | 'down', amount: number = 500): Promise<void> {
  const dy = direction === 'down' ? amount : -amount;
  await evaluate(`window.scrollBy(0, ${dy})`);
}

// ---- Network Capture ----

export async function startNetworkCapture(): Promise<void> {
  const cdp = await getClient();
  capturedRequests.clear();
  if (networkListenersAttached) return;
  networkListenersAttached = true;

  cdp.on('Network.requestWillBeSent', (params: object) => {
    const p = params as { requestId: string; request: { method: string; url: string }; type?: string };
    capturedRequests.set(p.requestId, {
      requestId: p.requestId,
      method: p.request.method,
      url: p.request.url,
      type: p.type || 'Other',
      size: 0,
      timestamp: Date.now(),
    });
  });

  cdp.on('Network.responseReceived', (params: object) => {
    const p = params as { requestId: string; response?: { status?: number; statusText?: string; headers?: Record<string, string> } };
    const req = capturedRequests.get(p.requestId);
    if (!req) return;
    if (p.response) {
      req.status = p.response.status;
      req.statusText = p.response.statusText;
      req.responseHeaders = p.response.headers;
    }
  });

  cdp.on('Network.dataReceived', (params: object) => {
    const p = params as { requestId: string; dataLength?: number };
    const req = capturedRequests.get(p.requestId);
    if (req) {
      req.size += p.dataLength || 0;
    }
  });
}

export function stopNetworkCapture(): void {
  networkListenersAttached = false;
  // Note: CDP event listeners persist on the client object;
  // they become no-ops once we clear state.
}

export function getNetworkRequests(): CapturedRequest[] {
  return Array.from(capturedRequests.values());
}

export async function getNetworkResponseBody(requestId: string): Promise<{ body: string; base64Encoded: boolean }> {
  const cdp = await getClient();
  const result = await cdp.Network.getResponseBody({ requestId });
  return { body: result.body, base64Encoded: result.base64Encoded };
}

export function clearNetworkCapture(): void {
  capturedRequests.clear();
}

// ---- Accessibility Tree ----

export async function getAccessibilityTree(): Promise<string> {
  const cdp = await getClient();
  const { nodes } = await cdp.Accessibility.getFullAXTree();

  const lines: string[] = [];

  // Build child map using childIds
  const childMap = new Map<string, string[]>();
  for (const node of nodes) {
    if (node.childIds) {
      childMap.set(node.nodeId, node.childIds as string[]);
    }
  }

  // Build lookup by nodeId
  const nodeMap = new Map<string, (typeof nodes)[number]>();
  for (const node of nodes) {
    nodeMap.set(node.nodeId, node);
  }

  function walk(nodeId: string, depth: number): void {
    const node = nodeMap.get(nodeId);
    if (!node) return;

    const role = node.role?.value as string | undefined;
    const name = node.name?.value as string | undefined;
    const value = node.value?.value as string | undefined;
    const ignored = node.ignored;

    // Skip ignored and generic nodes
    if (ignored) {
      // Still walk children of ignored nodes
      const childIds = childMap.get(nodeId) || [];
      for (const childId of childIds) {
        walk(childId, depth);
      }
      return;
    }
    if (role === 'none' || role === 'generic' || role === 'InlineTextBox') {
      const childIds = childMap.get(nodeId) || [];
      for (const childId of childIds) {
        walk(childId, depth);
      }
      return;
    }

    const indent = '  '.repeat(depth);
    let line = `${indent}[${role || 'unknown'}]`;
    if (name) line += ` "${name}"`;
    if (value) line += ` value="${value}"`;

    // Add states
    const properties = node.properties as Array<{ name: string; value: { value: unknown } }> | undefined;
    if (properties) {
      const states = properties
        .filter((p) => typeof p.value?.value === 'boolean' && p.value.value === true)
        .map((p) => p.name);
      if (states.length > 0) line += ` (${states.join(', ')})`;
    }

    lines.push(line);

    const childIds = childMap.get(nodeId) || [];
    for (const childId of childIds) {
      walk(childId, depth + 1);
    }
  }

  // Find root node and walk
  if (nodes.length > 0) {
    walk(nodes[0].nodeId, 0);
  }

  const result = lines.join('\n');
  const LIMIT = 50000;
  if (result.length > LIMIT) {
    return result.substring(0, LIMIT) + '\n\n... (truncated at 50k chars)';
  }
  return result;
}

// ---- Console Capture ----

export async function startConsoleCapture(): Promise<void> {
  const cdp = await getClient();
  capturedLogs.length = 0;
  if (consoleListenersAttached) return;
  consoleListenersAttached = true;

  cdp.on('Runtime.consoleAPICalled', (params: object) => {
    const p = params as {
      type: string;
      args?: Array<{ value?: unknown; description?: string }>;
      stackTrace?: { callFrames?: Array<{ url?: string; lineNumber?: number }> };
    };
    const text = p.args
      ? p.args.map((a) => a.value !== undefined ? String(a.value) : (a.description || '')).join(' ')
      : '';
    const frame = p.stackTrace?.callFrames?.[0];

    capturedLogs.push({
      level: p.type,
      text,
      timestamp: Date.now(),
      url: frame?.url,
      lineNumber: frame?.lineNumber,
    });
  });

  cdp.on('Runtime.exceptionThrown', (params: object) => {
    const p = params as {
      exceptionDetails?: {
        text?: string;
        exception?: { description?: string };
        url?: string;
        lineNumber?: number;
      };
    };

    capturedLogs.push({
      level: 'error',
      text: p.exceptionDetails?.exception?.description || p.exceptionDetails?.text || 'Unknown exception',
      timestamp: Date.now(),
      url: p.exceptionDetails?.url,
      lineNumber: p.exceptionDetails?.lineNumber,
    });
  });
}

export function stopConsoleCapture(): void {
  consoleListenersAttached = false;
}

export function getConsoleLogs(): CapturedLog[] {
  return [...capturedLogs];
}

export function clearConsoleLogs(): void {
  capturedLogs.length = 0;
}

export async function disconnect(): Promise<void> {
  if (client) {
    await client.close();
    client = null;
  }
}
