import puppeteer, { Browser, Page, BrowserContext } from 'puppeteer';

const BROWSER_MODE = process.env.NAVVY_PUPPETEER_MODE || 'headless';

let browser: Browser | null = null;
let defaultContext: BrowserContext | null = null;

// Per-session browser contexts for multi-session isolation
const sessionContexts = new Map<string, BrowserContext>();
const sessionPages = new Map<string, Page>();

// Network capture state
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
let networkCapturing = false;

// Console capture state
interface CapturedLog {
  level: string;
  text: string;
  timestamp: number;
  url?: string;
  lineNumber?: number;
}

const capturedLogs: CapturedLog[] = [];
let consoleCapturing = false;

export async function launchBrowser(): Promise<Browser> {
  if (browser) return browser;

  const headless = BROWSER_MODE === 'headless' || BROWSER_MODE === 'new';

  browser = await puppeteer.launch({
    headless: headless ? 'shell' : false,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-web-security',
      '--window-size=1280,800',
    ],
    defaultViewport: { width: 1280, height: 800 },
  });

  defaultContext = browser.defaultBrowserContext();
  return browser;
}

export async function getPage(sessionId?: string): Promise<Page> {
  if (sessionId && sessionPages.has(sessionId)) {
    const page = sessionPages.get(sessionId)!;
    if (!page.isClosed()) return page;
    sessionPages.delete(sessionId);
  }

  await launchBrowser();

  if (sessionId) {
    let ctx = sessionContexts.get(sessionId);
    if (!ctx) {
      ctx = await browser!.createBrowserContext();
      sessionContexts.set(sessionId, ctx);
    }
    const page = await ctx.newPage();
    sessionPages.set(sessionId, page);
    return page;
  }

  // Default: use the first page or create one
  const pages = await browser!.pages();
  if (pages.length > 0) return pages[0];
  return await browser!.newPage();
}

export async function captureScreenshot(sessionId?: string): Promise<string> {
  const page = await getPage(sessionId);
  const buffer = await page.screenshot({ encoding: 'base64' });
  return buffer as string;
}

export async function navigate(url: string, sessionId?: string): Promise<void> {
  const page = await getPage(sessionId);
  await page.goto(url, { waitUntil: 'load', timeout: 30000 });
}

export async function evaluate<T = unknown>(expression: string, sessionId?: string): Promise<T> {
  const page = await getPage(sessionId);
  return await page.evaluate(expression) as T;
}

export async function getPageInfo(sessionId?: string): Promise<{ url: string; title: string }> {
  const page = await getPage(sessionId);
  return {
    url: page.url(),
    title: await page.title(),
  };
}

export async function getSimplifiedDOM(selector?: string, sessionId?: string): Promise<string> {
  const page = await getPage(sessionId);
  return await page.evaluate((sel) => {
    function walk(node: Node, depth: number): string {
      if (depth > 8) return '';
      let result = '';
      const indent = '  '.repeat(depth);

      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent?.trim();
        if (text && text.length < 200) {
          return indent + JSON.stringify(text) + '\n';
        }
        return '';
      }

      if (node.nodeType !== Node.ELEMENT_NODE) return '';

      const el = node as Element;
      const tag = el.tagName.toLowerCase();
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return '';
      if (['script', 'style', 'noscript', 'svg', 'path'].includes(tag)) return '';

      const attrs: string[] = [];
      if (el.id) attrs.push(`id="${el.id}"`);
      if (el.className && typeof el.className === 'string') {
        const classes = el.className.trim();
        if (classes) attrs.push(`class="${classes.substring(0, 50)}"`);
      }
      for (const name of ['href', 'src', 'type', 'name', 'value', 'placeholder', 'aria-label', 'role']) {
        const val = el.getAttribute(name);
        if (val) attrs.push(`${name}="${val.substring(0, 100)}"`);
      }

      const attrStr = attrs.length > 0 ? ' ' + attrs.join(' ') : '';
      result += `${indent}<${tag}${attrStr}>\n`;
      for (const child of el.childNodes) {
        result += walk(child, depth + 1);
      }
      return result;
    }

    const root = sel ? document.querySelector(sel) : document.body;
    if (!root) throw new Error(`Selector not found: ${sel}`);
    return walk(root, 0);
  }, selector);
}

export async function getWindowBounds(sessionId?: string): Promise<{
  windowX: number; windowY: number; windowWidth: number; windowHeight: number;
  viewportWidth: number; viewportHeight: number;
  devicePixelRatio: number;
}> {
  const page = await getPage(sessionId);
  return await page.evaluate(() => ({
    windowX: window.screenX,
    windowY: window.screenY,
    windowWidth: window.outerWidth,
    windowHeight: window.outerHeight,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    devicePixelRatio: window.devicePixelRatio,
  }));
}

export async function waitForSelector(selector: string, timeoutMs: number = 10000, sessionId?: string): Promise<boolean> {
  const page = await getPage(sessionId);
  try {
    await page.waitForSelector(selector, { timeout: timeoutMs });
    return true;
  } catch {
    return false;
  }
}

export async function listTabs(sessionId?: string): Promise<Array<{ id: string; title: string; url: string }>> {
  await launchBrowser();
  const pages = await browser!.pages();
  return pages.map((p, i) => ({
    id: String(i),
    title: p.url(), // Will get actual title via evaluate
    url: p.url(),
  }));
}

export async function scrollPage(direction: 'up' | 'down', amount: number = 500, sessionId?: string): Promise<void> {
  const page = await getPage(sessionId);
  const delta = direction === 'down' ? amount : -amount;
  await page.evaluate((d) => window.scrollBy(0, d), delta);
}

export async function startNetworkCapture(sessionId?: string): Promise<void> {
  const page = await getPage(sessionId);
  capturedRequests.clear();
  networkCapturing = true;

  const client = await page.createCDPSession();
  await client.send('Network.enable');

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (client as any).on('Network.requestWillBeSent', (params: any) => {
    if (!networkCapturing) return;
    capturedRequests.set(params.requestId, {
      requestId: params.requestId,
      method: params.request.method,
      url: params.request.url,
      type: params.type || 'Other',
      size: 0,
      timestamp: params.timestamp,
    });
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (client as any).on('Network.responseReceived', (params: any) => {
    const req = capturedRequests.get(params.requestId);
    if (req) {
      req.status = params.response.status;
      req.statusText = params.response.statusText;
      req.responseHeaders = params.response.headers;
    }
  });
}

export function stopNetworkCapture(): void {
  networkCapturing = false;
}

export function getNetworkRequests(): CapturedRequest[] {
  return Array.from(capturedRequests.values());
}

export function clearNetworkCapture(): void {
  capturedRequests.clear();
}

export async function startConsoleCapture(sessionId?: string): Promise<void> {
  const page = await getPage(sessionId);
  capturedLogs.length = 0;
  consoleCapturing = true;

  page.on('console', (msg) => {
    if (!consoleCapturing) return;
    capturedLogs.push({
      level: msg.type(),
      text: msg.text(),
      timestamp: Date.now(),
      url: msg.location()?.url,
      lineNumber: msg.location()?.lineNumber,
    });
  });
}

export function stopConsoleCapture(): void {
  consoleCapturing = false;
}

export function getConsoleLogs(): CapturedLog[] {
  return [...capturedLogs];
}

export function clearConsoleLogs(): void {
  capturedLogs.length = 0;
}

export async function createTab(url?: string, sessionId?: string): Promise<string> {
  const page = await getPage(sessionId);
  const context = page.browserContext();
  const newPage = await context.newPage();
  if (url) {
    await newPage.goto(url, { waitUntil: 'load', timeout: 30000 });
  }
  const pages = await browser!.pages();
  return String(pages.indexOf(newPage));
}

export async function closeTab(tabId: string): Promise<void> {
  const pages = await browser!.pages();
  const idx = parseInt(tabId, 10);
  if (idx >= 0 && idx < pages.length) {
    await pages[idx].close();
  }
}

export async function destroySession(sessionId: string): Promise<void> {
  const ctx = sessionContexts.get(sessionId);
  if (ctx) {
    await ctx.close();
    sessionContexts.delete(sessionId);
  }
  sessionPages.delete(sessionId);
}

export async function disconnect(): Promise<void> {
  for (const ctx of sessionContexts.values()) {
    try { await ctx.close(); } catch { /* ignore */ }
  }
  sessionContexts.clear();
  sessionPages.clear();

  if (browser) {
    await browser.close();
    browser = null;
    defaultContext = null;
  }
}
