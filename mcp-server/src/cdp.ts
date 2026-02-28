import CDP from 'chrome-remote-interface';
import { generatePath, computeDelays, type TimedPoint } from './motion.js';

let client: CDP.Client | null = null;
let currentTargetId: string | null = null;

// Multi-tab support: cache clients by tab ID
const tabClients = new Map<string, CDP.Client>();
let activeTabId: string | null = null;

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
  activeTabId = tabId;
  currentTargetId = tabId;
}

// ---- Multi-Tab Operations ----

export async function getClientForTab(tabId: string): Promise<CDP.Client> {
  // Check if we already have a cached client for this tab
  const cached = tabClients.get(tabId);
  if (cached) {
    try {
      await cached.Browser.getVersion();
      return cached;
    } catch {
      tabClients.delete(tabId);
    }
  }

  // Create a new client for this tab
  const tabClient = await CDP({ port: 9222, target: tabId });
  await tabClient.Page.enable();
  await tabClient.Runtime.enable();
  tabClients.set(tabId, tabClient);
  return tabClient;
}

export async function createTab(url?: string): Promise<string> {
  const targetUrl = url || 'about:blank';
  const response = await fetch(`http://localhost:9222/json/new?${encodeURIComponent(targetUrl)}`);
  const target = await response.json() as { id: string };
  return target.id;
}

export async function closeTab(tabId: string): Promise<void> {
  // Close cached client if any
  const cached = tabClients.get(tabId);
  if (cached) {
    try { await cached.close(); } catch { /* ignore */ }
    tabClients.delete(tabId);
  }
  // If this was the active tab, clear the active client
  if (tabId === currentTargetId) {
    client = null;
    currentTargetId = null;
    activeTabId = null;
  }
  await fetch(`http://localhost:9222/json/close/${tabId}`);
}

export async function evaluateInTab<T = unknown>(tabId: string, expression: string): Promise<T> {
  const tabClient = await getClientForTab(tabId);
  const result = await tabClient.Runtime.evaluate({
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

// ---- Page Inspection ----

export interface InspectedElement {
  index: number;
  tag: string;
  type?: string;
  selector: string;
  label?: string;
  text?: string;
  value?: string;
  placeholder?: string;
  options?: string[];
  checked?: boolean;
  disabled?: boolean;
  draggable?: boolean;
  inViewport: boolean;
  role?: string;
  name?: string;
}

export interface PageInspection {
  url: string;
  title: string;
  viewportWidth: number;
  viewportHeight: number;
  scrollTop: number;
  scrollHeight: number;
  focusedSelector?: string;
  hasDialog: boolean;
  elements: InspectedElement[];
  forms: Array<{ selector: string; action?: string; method?: string; elementIndices: number[] }>;
}

export async function inspectPage(): Promise<PageInspection> {
  return evaluate<PageInspection>(`
    (function() {
      var vw = window.innerWidth, vh = window.innerHeight;

      function bestSelector(el) {
        if (el.id) return '#' + CSS.escape(el.id);
        var testid = el.getAttribute('data-testid');
        if (testid) return '[data-testid="' + testid + '"]';
        var name = el.getAttribute('name');
        var tag = el.tagName.toLowerCase();
        if (name) {
          var type = el.getAttribute('type');
          if (type) return tag + '[name="' + name + '"][type="' + type + '"]';
          return tag + '[name="' + name + '"]';
        }
        var ariaLabel = el.getAttribute('aria-label');
        if (ariaLabel) return tag + '[aria-label="' + ariaLabel + '"]';
        var role = el.getAttribute('role');
        if (role) {
          var text = (el.textContent || '').trim().substring(0, 30);
          if (text) return tag + '[role="' + role + '"]';
        }
        // Build a positional selector
        var path = [];
        var current = el;
        while (current && current !== document.body && path.length < 4) {
          var seg = current.tagName.toLowerCase();
          if (current.id) { path.unshift('#' + CSS.escape(current.id)); break; }
          var parent = current.parentElement;
          if (parent) {
            var siblings = Array.from(parent.children).filter(function(c) { return c.tagName === current.tagName; });
            if (siblings.length > 1) {
              seg += ':nth-of-type(' + (siblings.indexOf(current) + 1) + ')';
            }
          }
          path.unshift(seg);
          current = parent;
        }
        return path.join(' > ');
      }

      function getLabel(el) {
        if (el.id) {
          var lbl = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
          if (lbl) return lbl.textContent.trim().substring(0, 80);
        }
        var parent = el.closest('label');
        if (parent) return parent.textContent.trim().substring(0, 80);
        var ariaLabel = el.getAttribute('aria-label');
        if (ariaLabel) return ariaLabel;
        var ariaLabelledBy = el.getAttribute('aria-labelledby');
        if (ariaLabelledBy) {
          var refEl = document.getElementById(ariaLabelledBy);
          if (refEl) return refEl.textContent.trim().substring(0, 80);
        }
        return undefined;
      }

      var selectors = 'input, select, textarea, button, a[href], [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="checkbox"], [role="radio"], [role="switch"], [draggable="true"], [contenteditable="true"]';
      var allEls = Array.from(document.querySelectorAll(selectors));
      // Filter hidden
      allEls = allEls.filter(function(el) {
        if (el.type === 'hidden') return false;
        var style = window.getComputedStyle(el);
        return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
      });
      // Cap at 100
      allEls = allEls.slice(0, 100);

      var elements = allEls.map(function(el, i) {
        var tag = el.tagName.toLowerCase();
        var rect = el.getBoundingClientRect();
        var inViewport = rect.top < vh && rect.bottom > 0 && rect.left < vw && rect.right > 0;
        var item = {
          index: i,
          tag: tag,
          selector: bestSelector(el),
          inViewport: inViewport
        };
        var type = el.getAttribute('type');
        if (type) item.type = type;
        var label = getLabel(el);
        if (label) item.label = label;
        var role = el.getAttribute('role');
        if (role) item.role = role;
        var elName = el.getAttribute('name');
        if (elName) item.name = elName;
        // Text content for buttons/links
        if (tag === 'button' || tag === 'a' || role === 'button' || role === 'link' || role === 'tab' || role === 'menuitem') {
          var text = (el.textContent || '').trim().substring(0, 80);
          if (text) item.text = text;
        }
        // Value for inputs/selects/textareas
        if (tag === 'input' || tag === 'textarea' || tag === 'select') {
          item.value = el.value || '';
        }
        if (el.placeholder) item.placeholder = el.placeholder;
        // Options for selects
        if (tag === 'select') {
          item.options = Array.from(el.options).map(function(o) { return o.textContent.trim(); });
        }
        // Checked state
        if (type === 'checkbox' || type === 'radio') {
          item.checked = el.checked;
        }
        if (el.disabled) item.disabled = true;
        if (el.draggable || el.getAttribute('draggable') === 'true') item.draggable = true;
        return item;
      });

      // Forms
      var formEls = Array.from(document.querySelectorAll('form'));
      var forms = formEls.map(function(form) {
        var sel = bestSelector(form);
        var indices = [];
        elements.forEach(function(elem, idx) {
          var domEl = document.querySelector(elem.selector);
          if (domEl && form.contains(domEl)) indices.push(idx);
        });
        return {
          selector: sel,
          action: form.getAttribute('action') || undefined,
          method: (form.getAttribute('method') || '').toUpperCase() || undefined,
          elementIndices: indices
        };
      });

      // Focused element
      var focusedSelector = undefined;
      if (document.activeElement && document.activeElement !== document.body) {
        try { focusedSelector = bestSelector(document.activeElement); } catch(e) {}
      }

      return {
        url: window.location.href,
        title: document.title,
        viewportWidth: vw,
        viewportHeight: vh,
        scrollTop: window.scrollY,
        scrollHeight: document.documentElement.scrollHeight,
        focusedSelector: focusedSelector,
        hasDialog: !!document.querySelector('dialog[open], [role="dialog"], [role="alertdialog"]'),
        elements: elements,
        forms: forms
      };
    })()
  `);
}

// ---- Batch Form Filling ----

export interface FormFillAction {
  selector: string;
  value?: string;
  selectText?: string;
  check?: boolean;
  clear?: boolean;
}

export interface FormFillFieldResult {
  selector: string;
  ok: boolean;
  error?: string;
  previousValue?: string;
  newValue?: string;
}

export interface FormFillResult {
  total: number;
  succeeded: number;
  results: FormFillFieldResult[];
}

export async function fillForm(actions: FormFillAction[]): Promise<FormFillResult> {
  return evaluate<FormFillResult>(`
    (function() {
      var actions = ${JSON.stringify(actions)};
      var results = [];
      var succeeded = 0;

      for (var i = 0; i < actions.length; i++) {
        var action = actions[i];
        var result = { selector: action.selector, ok: false };
        try {
          var el = document.querySelector(action.selector);
          if (!el) throw new Error('Element not found');
          var tag = el.tagName.toLowerCase();
          var type = (el.getAttribute('type') || '').toLowerCase();

          // Handle checkboxes and radios
          if (type === 'checkbox' || type === 'radio') {
            var shouldBeChecked = action.check !== undefined ? action.check : true;
            result.previousValue = String(el.checked);
            if (el.checked !== shouldBeChecked) {
              el.click();
            }
            result.newValue = String(el.checked);
            result.ok = true;
            succeeded++;
            results.push(result);
            continue;
          }

          // Handle select elements
          if (tag === 'select') {
            result.previousValue = el.value;
            var options = Array.from(el.options);
            var opt = null;
            if (action.selectText) {
              opt = options.find(function(o) { return o.textContent.trim() === action.selectText; });
            }
            if (!opt && action.value !== undefined) {
              opt = options.find(function(o) { return o.value === action.value; });
              if (!opt) opt = options.find(function(o) { return o.textContent.trim() === action.value; });
            }
            if (!opt) throw new Error('Option not found: ' + (action.selectText || action.value));
            el.value = opt.value;
            el.dispatchEvent(new Event('change', { bubbles: true }));
            result.newValue = opt.textContent.trim();
            result.ok = true;
            succeeded++;
            results.push(result);
            continue;
          }

          // Handle contenteditable
          if (el.getAttribute('contenteditable') === 'true') {
            result.previousValue = el.textContent;
            if (action.clear) el.textContent = '';
            if (action.value !== undefined) el.textContent = action.value;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            result.newValue = el.textContent;
            result.ok = true;
            succeeded++;
            results.push(result);
            continue;
          }

          // Handle text inputs and textareas (React/Vue/Angular compatible)
          result.previousValue = el.value;
          if (action.clear || action.value !== undefined) {
            var nativeInputValueSetter = Object.getOwnPropertyDescriptor(
              tag === 'textarea' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
              'value'
            );
            if (nativeInputValueSetter && nativeInputValueSetter.set) {
              nativeInputValueSetter.set.call(el, action.clear && !action.value ? '' : (action.value || ''));
            } else {
              el.value = action.clear && !action.value ? '' : (action.value || '');
            }
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          }
          result.newValue = el.value;
          result.ok = true;
          succeeded++;
        } catch (e) {
          result.error = e.message || String(e);
        }
        results.push(result);
      }

      return { total: actions.length, succeeded: succeeded, results: results };
    })()
  `);
}

// ---- Scroll To Element ----

export async function scrollToElement(selector: string, block?: string): Promise<{ inViewport: boolean }> {
  return evaluate<{ inViewport: boolean }>(`
    (function() {
      var el = document.querySelector(${JSON.stringify(selector)});
      if (!el) throw new Error('Element not found: ${selector}');
      el.scrollIntoView({ behavior: 'instant', block: ${block ? JSON.stringify(block) : "'center'"} });
      var rect = el.getBoundingClientRect();
      var inViewport = rect.top >= 0 && rect.bottom <= window.innerHeight && rect.left >= 0 && rect.right <= window.innerWidth;
      return { inViewport: inViewport };
    })()
  `);
}

// ---- Scroll In Container ----

export async function scrollInContainer(containerSelector: string, direction: 'up' | 'down', amount: number): Promise<{ scrollTop: number; scrollHeight: number; clientHeight: number }> {
  const dy = direction === 'down' ? amount : -amount;
  return evaluate<{ scrollTop: number; scrollHeight: number; clientHeight: number }>(`
    (function() {
      var el = document.querySelector(${JSON.stringify(containerSelector)});
      if (!el) throw new Error('Container not found: ${containerSelector}');
      el.scrollBy(0, ${dy});
      return { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight };
    })()
  `);
}

// ---- CDP-Level Drag ----

interface DragResult {
  success: boolean;
  from: { x: number; y: number };
  to: { x: number; y: number };
  steps: number;
}

/**
 * Drag from one element to another using CDP Input.dispatchMouseEvent.
 * This works inside the browser viewport (no OS-level input needed),
 * produces smooth intermediate moves, and triggers all DOM mouse events.
 *
 * Key details that make this work with real drag libraries:
 * - buttons: 1 on all mouseMoved events (indicates left button held)
 * - 200ms hold delay after mousePressed (triggers drag threshold)
 * - Small initial movement to cross the drag activation distance
 * - Smooth interpolated steps with realistic timing
 */
export async function dragCDP(
  fromSelector: string,
  toSelector: string,
  steps: number = 15,
  durationMs: number = 500,
  activationDirection: 'auto' | 'horizontal' | 'vertical' = 'auto',
): Promise<DragResult> {
  const cdp = await getClient();

  // Get element center coordinates (viewport-relative)
  const fromBounds = await getElementBounds(fromSelector);
  const toBounds = await getElementBounds(toSelector);

  const fromX = fromBounds.x + fromBounds.width / 2;
  const fromY = fromBounds.y + fromBounds.height / 2;
  const toX = toBounds.x + toBounds.width / 2;
  const toY = toBounds.y + toBounds.height / 2;

  // 1. Move to source element
  await cdp.Input.dispatchMouseEvent({
    type: 'mouseMoved',
    x: fromX,
    y: fromY,
    buttons: 0,
  });
  await new Promise(r => setTimeout(r, 50));

  // 2. Press and hold — long enough to trigger drag threshold
  await cdp.Input.dispatchMouseEvent({
    type: 'mousePressed',
    x: fromX,
    y: fromY,
    button: 'left',
    buttons: 1,
    clickCount: 1,
  });
  await new Promise(r => setTimeout(r, 200));

  // 3. Small initial move to cross the drag activation distance (5px)
  let activationX = fromX;
  let activationY = fromY;
  if (activationDirection === 'vertical') {
    activationY += (toY > fromY ? 5 : -5);
  } else if (activationDirection === 'horizontal') {
    activationX += (toX > fromX ? 5 : -5);
  } else {
    // 'auto' — move 5px toward target
    const dx = toX - fromX;
    const dy = toY - fromY;
    const dist = Math.sqrt(dx * dx + dy * dy) || 1;
    activationX += (dx / dist) * 5;
    activationY += (dy / dist) * 5;
  }
  await cdp.Input.dispatchMouseEvent({
    type: 'mouseMoved',
    x: activationX,
    y: activationY,
    buttons: 1,
  });
  await new Promise(r => setTimeout(r, 50));

  // 4. Smooth bezier-eased intermediate moves with buttons: 1
  const path = generatePath(
    { x: fromX, y: fromY },
    { x: toX, y: toY },
    { durationMs, steps, easing: 'easeInOutCubic', jitter: 1.5 },
  );
  const delays = computeDelays(path);

  for (let i = 1; i < path.length; i++) {
    await cdp.Input.dispatchMouseEvent({
      type: 'mouseMoved',
      x: path[i].x,
      y: path[i].y,
      buttons: 1,
    });
    await new Promise(r => setTimeout(r, delays[i - 1]));
  }

  // 5. Hold at target briefly
  await new Promise(r => setTimeout(r, 100));

  // 6. Release at target
  await cdp.Input.dispatchMouseEvent({
    type: 'mouseReleased',
    x: toX,
    y: toY,
    button: 'left',
    buttons: 0,
    clickCount: 1,
  });

  return { success: true, from: { x: fromX, y: fromY }, to: { x: toX, y: toY }, steps };
}

/**
 * Draw a path through timed points using CDP mouse events.
 * For canvas drawing, signatures, connecting diagram nodes, etc.
 */
export async function drawCDP(
  points: TimedPoint[],
): Promise<{ success: boolean; pointCount: number }> {
  if (points.length < 2) {
    throw new Error('drawCDP requires at least 2 points');
  }

  const cdp = await getClient();
  const delays = computeDelays(points);

  // 1. Move to first point (no buttons)
  await cdp.Input.dispatchMouseEvent({
    type: 'mouseMoved',
    x: points[0].x,
    y: points[0].y,
    buttons: 0,
  });
  await new Promise(r => setTimeout(r, 50));

  // 2. Press at first point
  await cdp.Input.dispatchMouseEvent({
    type: 'mousePressed',
    x: points[0].x,
    y: points[0].y,
    button: 'left',
    buttons: 1,
    clickCount: 1,
  });
  await new Promise(r => setTimeout(r, 30));

  // 3. Move through all intermediate points (button held)
  for (let i = 1; i < points.length; i++) {
    await cdp.Input.dispatchMouseEvent({
      type: 'mouseMoved',
      x: points[i].x,
      y: points[i].y,
      buttons: 1,
    });
    await new Promise(r => setTimeout(r, delays[i - 1]));
  }

  // 4. Release at last point
  const last = points[points.length - 1];
  await cdp.Input.dispatchMouseEvent({
    type: 'mouseReleased',
    x: last.x,
    y: last.y,
    button: 'left',
    buttons: 0,
    clickCount: 1,
  });

  return { success: true, pointCount: points.length };
}

/**
 * Drag using the HTML5 Drag and Drop API with full event sequence and
 * proper coordinates. For apps that use dragstart/dragover/drop events.
 */
export async function dragHTML5(
  fromSelector: string,
  toSelector: string,
): Promise<{ success: boolean }> {
  return evaluate<{ success: boolean }>(`
    (function() {
      var src = document.querySelector(${JSON.stringify(fromSelector)});
      var dst = document.querySelector(${JSON.stringify(toSelector)});
      if (!src) throw new Error('Drag source not found: ${fromSelector}');
      if (!dst) throw new Error('Drop target not found: ${toSelector}');

      var srcRect = src.getBoundingClientRect();
      var dstRect = dst.getBoundingClientRect();
      var srcX = srcRect.left + srcRect.width / 2;
      var srcY = srcRect.top + srcRect.height / 2;
      var dstX = dstRect.left + dstRect.width / 2;
      var dstY = dstRect.top + dstRect.height / 2;

      var dataTransfer = new DataTransfer();

      function fire(el, type, x, y, dt) {
        var opts = {
          bubbles: true,
          cancelable: true,
          clientX: x,
          clientY: y,
          screenX: x + window.screenX,
          screenY: y + window.screenY,
          dataTransfer: dt
        };
        el.dispatchEvent(new DragEvent(type, opts));
      }

      // mousedown on source
      src.dispatchEvent(new MouseEvent('mousedown', {
        bubbles: true, clientX: srcX, clientY: srcY, button: 0
      }));

      // Full drag sequence
      fire(src, 'dragstart', srcX, srcY, dataTransfer);
      fire(src, 'drag', srcX, srcY, dataTransfer);

      // Enter target with intermediate moves
      fire(dst, 'dragenter', dstX, dstY, dataTransfer);
      // Multiple dragovers (some frameworks need repeated events)
      for (var i = 0; i < 3; i++) {
        fire(dst, 'dragover', dstX, dstY, dataTransfer);
      }

      // Leave source
      fire(src, 'dragleave', dstX, dstY, dataTransfer);

      // Drop and end
      fire(dst, 'drop', dstX, dstY, dataTransfer);
      fire(src, 'dragend', dstX, dstY, dataTransfer);

      // mouseup
      dst.dispatchEvent(new MouseEvent('mouseup', {
        bubbles: true, clientX: dstX, clientY: dstY, button: 0
      }));

      return { success: true };
    })()
  `);
}

// ---- Sortable List Reorder ----

export interface ReorderResult {
  success: boolean;
  method: string;
  previousOrder: string[];
  newOrder: string[];
  error?: string;
}

/**
 * Reorder items in a sortable list by moving them via DOM manipulation
 * and triggering the appropriate framework events to update state.
 * Works with SortableJS, react-sortable-hoc, dnd-kit, and similar libraries.
 *
 * @param containerSelector - CSS selector for the sortable container
 * @param newOrder - Array of 0-based indices representing the desired order.
 *                   e.g. [2,0,1] moves item at index 2 to first, 0 to second, 1 to third.
 */
export async function reorderList(
  containerSelector: string,
  newOrder: number[],
): Promise<ReorderResult> {
  return evaluate<ReorderResult>(`
    (function() {
      var container = document.querySelector(${JSON.stringify(containerSelector)});
      if (!container) throw new Error('Container not found: ${containerSelector}');

      var children = Array.from(container.children);
      if (newOrder.length !== children.length) {
        throw new Error('newOrder length (' + ${JSON.stringify(newOrder)}.length + ') does not match children count (' + children.length + ')');
      }

      var newOrder = ${JSON.stringify(newOrder)};
      var previousOrder = children.map(function(c) { return (c.textContent || '').trim().substring(0, 60); });

      // Try SortableJS first (most common)
      var sortableInstance = null;
      if (window.Sortable) {
        // SortableJS stores instance on the element
        sortableInstance = window.Sortable.get && window.Sortable.get(container);
        if (!sortableInstance) {
          // Try accessing via element property
          sortableInstance = container.sortable || container._sortable;
        }
      }

      if (sortableInstance && sortableInstance.sort) {
        // Use SortableJS API — get current data-id or index order, rearrange
        var items = sortableInstance.toArray();
        if (items && items.length === newOrder.length) {
          var reordered = newOrder.map(function(idx) { return items[idx]; });
          sortableInstance.sort(reordered, true);
          var newOrderText = Array.from(container.children).map(function(c) { return (c.textContent || '').trim().substring(0, 60); });
          return { success: true, method: 'sortablejs-api', previousOrder: previousOrder, newOrder: newOrderText };
        }
      }

      // Fallback: DOM manipulation + React/framework state sync
      // Clone references in new order
      var reordered = newOrder.map(function(idx) { return children[idx]; });

      // Remove all children
      while (container.firstChild) {
        container.removeChild(container.firstChild);
      }

      // Re-insert in new order
      reordered.forEach(function(child) {
        container.appendChild(child);
      });

      // Try to trigger React state update
      var reactFiberKey = Object.keys(container).find(function(k) { return k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'); });
      if (reactFiberKey) {
        // Dispatch synthetic events to nudge React into recognizing the change
        container.dispatchEvent(new Event('change', { bubbles: true }));
        // Find React's onChange/onDragEnd handler by walking the fiber tree
        var fiber = container[reactFiberKey];
        var current = fiber;
        for (var i = 0; i < 20 && current; i++) {
          if (current.memoizedProps) {
            var props = current.memoizedProps;
            if (props.onSortEnd) {
              props.onSortEnd({ oldIndex: 0, newIndex: 0, collection: 0 });
              break;
            }
            if (props.onDragEnd) {
              props.onDragEnd({ source: { index: 0 }, destination: { index: 0 } });
              break;
            }
          }
          current = current.return;
        }
      }

      // Also dispatch native events that sortable libraries commonly listen to
      container.dispatchEvent(new Event('sort', { bubbles: true }));
      container.dispatchEvent(new Event('update', { bubbles: true }));

      var newOrderText = Array.from(container.children).map(function(c) { return (c.textContent || '').trim().substring(0, 60); });
      return { success: true, method: reactFiberKey ? 'dom-react' : 'dom', previousOrder: previousOrder, newOrder: newOrderText };
    })()
  `);
}

export async function disconnect(): Promise<void> {
  if (client) {
    await client.close();
    client = null;
  }
}
