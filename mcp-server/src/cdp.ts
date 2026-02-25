import CDP from 'chrome-remote-interface';

let client: CDP.Client | null = null;

export async function getClient(): Promise<CDP.Client> {
  if (client) {
    try {
      // Test if connection is still alive
      await client.Browser.getVersion();
      return client;
    } catch {
      client = null;
    }
  }
  client = await CDP({ port: 9222 });
  // Enable required domains
  await client.Page.enable();
  await client.Runtime.enable();
  await client.DOM.enable();
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

export async function getSimplifiedDOM(): Promise<string> {
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
      return walk(document.body, 0);
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
    .filter(t => t.type === 'page')
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
}

export async function scrollPage(direction: 'up' | 'down', amount: number = 500): Promise<void> {
  const dy = direction === 'down' ? amount : -amount;
  await evaluate(`window.scrollBy(0, ${dy})`);
}

export async function disconnect(): Promise<void> {
  if (client) {
    await client.close();
    client = null;
  }
}
