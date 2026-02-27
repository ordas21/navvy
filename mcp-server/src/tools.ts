import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as cdp from './cdp.js';
import * as input from './input.js';
import { elementToScreenCoords } from './coordinates.js';

export function registerTools(server: McpServer): void {

  server.tool(
    'browser_screenshot',
    'Capture a screenshot of the current page. Returns base64 PNG image.',
    {},
    async () => {
      const [data, info, bounds] = await Promise.all([
        cdp.captureScreenshot(),
        cdp.getPageInfo(),
        cdp.getWindowBounds(),
      ]);
      return {
        content: [
          { type: 'text', text: `URL: ${info.url}\nTitle: ${info.title}\nViewport: ${bounds.innerWidth}x${bounds.innerHeight}` },
          { type: 'image', data, mimeType: 'image/png' },
        ],
      };
    }
  );

  server.tool(
    'browser_get_dom',
    'Get a simplified DOM tree of the current page showing tags, ids, classes, roles, hrefs, and text content. Useful for understanding page structure and finding selectors. Optionally scope to a subtree with a CSS selector.',
    {
      selector: z.string().optional().describe('Optional CSS selector to scope the DOM query to a subtree'),
    },
    async ({ selector }) => {
      const dom = await cdp.getSimplifiedDOM(selector);
      const DOM_LIMIT = 50000;
      if (dom.length > DOM_LIMIT) {
        return { content: [{ type: 'text', text: dom.substring(0, DOM_LIMIT) + '\n\n... (truncated — use a selector to scope the query)' }] };
      }
      return { content: [{ type: 'text', text: dom }] };
    }
  );

  server.tool(
    'browser_click',
    'Click an element on the page using a CSS selector. Uses native OS-level mouse input.',
    { selector: z.string().describe('CSS selector of the element to click') },
    async ({ selector }) => {
      const coords = await elementToScreenCoords(selector);
      await input.click(coords.x, coords.y);
      // Small delay to let the page react
      await new Promise(r => setTimeout(r, 300));
      return { content: [{ type: 'text', text: `Clicked element "${selector}" at screen position (${coords.x}, ${coords.y})` }] };
    }
  );

  server.tool(
    'browser_click_at',
    'Click at specific page coordinates (relative to viewport). Uses native OS-level mouse input.',
    {
      x: z.number().describe('X coordinate relative to viewport'),
      y: z.number().describe('Y coordinate relative to viewport'),
    },
    async ({ x, y }) => {
      const { pageToScreenCoords } = await import('./coordinates.js');
      const screen = await pageToScreenCoords(x, y);
      await input.click(screen.x, screen.y);
      await new Promise(r => setTimeout(r, 300));
      return { content: [{ type: 'text', text: `Clicked at page (${x}, ${y}) → screen (${screen.x}, ${screen.y})` }] };
    }
  );

  server.tool(
    'browser_type',
    'Type text using native OS keyboard input. The text will be typed at the currently focused element. Optionally provide a CSS selector to click the element first (to focus it).',
    {
      text: z.string().describe('Text to type'),
      selector: z.string().optional().describe('Optional CSS selector — if provided, clicks the element to focus it before typing'),
    },
    async ({ text, selector }) => {
      if (selector) {
        const coords = await elementToScreenCoords(selector);
        await input.click(coords.x, coords.y);
        await new Promise(r => setTimeout(r, 200));
      }
      await input.type(text);
      return { content: [{ type: 'text', text: selector ? `Clicked "${selector}" and typed: "${text}"` : `Typed: "${text}"` }] };
    }
  );

  server.tool(
    'browser_key_press',
    'Press a keyboard key. Common keys: return, tab, escape, space, delete, arrow-up, arrow-down, arrow-left, arrow-right.',
    { key: z.string().describe('Key to press (e.g. "return", "tab", "escape")') },
    async ({ key }) => {
      await input.keyPress(key);
      return { content: [{ type: 'text', text: `Pressed key: ${key}` }] };
    }
  );

  server.tool(
    'browser_navigate',
    'Navigate to a URL.',
    { url: z.string().describe('URL to navigate to') },
    async ({ url }) => {
      await cdp.navigate(url);
      const info = await cdp.getPageInfo();
      return { content: [{ type: 'text', text: `Navigated to: ${info.url}\nTitle: ${info.title}` }] };
    }
  );

  server.tool(
    'browser_scroll',
    'Scroll the page or a scrollable container up or down. If selector is provided, scrolls that container instead of the page.',
    {
      direction: z.enum(['up', 'down']).describe('Scroll direction'),
      amount: z.number().optional().describe('Scroll amount in pixels (default 500)'),
      selector: z.string().optional().describe('Optional CSS selector of a scrollable container. If omitted, scrolls the page.'),
    },
    async ({ direction, amount, selector }) => {
      if (selector) {
        const result = await cdp.scrollInContainer(selector, direction, amount ?? 500);
        return { content: [{ type: 'text', text: `Scrolled container "${selector}" ${direction} by ${amount ?? 500}px (scrollTop: ${Math.round(result.scrollTop)}/${result.scrollHeight - result.clientHeight})` }] };
      }
      await cdp.scrollPage(direction, amount ?? 500);
      return { content: [{ type: 'text', text: `Scrolled ${direction} by ${amount ?? 500}px` }] };
    }
  );

  server.tool(
    'browser_hover',
    'Move the mouse over an element to trigger hover effects (menus, tooltips, etc.).',
    { selector: z.string().describe('CSS selector of the element to hover over') },
    async ({ selector }) => {
      const coords = await elementToScreenCoords(selector);
      await input.moveTo(coords.x, coords.y);
      await new Promise(r => setTimeout(r, 300));
      return { content: [{ type: 'text', text: `Hovered over "${selector}" at (${coords.x}, ${coords.y})` }] };
    }
  );

  server.tool(
    'browser_select',
    'Select an option from a <select> dropdown by value or visible text.',
    {
      selector: z.string().describe('CSS selector of the <select> element'),
      value: z.string().optional().describe('Option value to select'),
      text: z.string().optional().describe('Visible text of the option to select'),
    },
    async ({ selector, value, text }) => {
      if (!value && !text) {
        return { content: [{ type: 'text', text: 'Error: Provide either "value" or "text" to select an option.' }], isError: true };
      }
      const selected = await cdp.evaluate<string>(`
        (function() {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el || el.tagName !== 'SELECT') throw new Error('Element is not a <select>: ${selector}');
          const options = Array.from(el.options);
          const opt = ${value ? `options.find(o => o.value === ${JSON.stringify(value)})` : `options.find(o => o.textContent.trim() === ${JSON.stringify(text)})`};
          if (!opt) throw new Error('Option not found');
          el.value = opt.value;
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return opt.textContent.trim();
        })()
      `);
      return { content: [{ type: 'text', text: `Selected "${selected}" in ${selector}` }] };
    }
  );

  server.tool(
    'browser_clear_input',
    'Clear the currently focused input field by selecting all text and deleting it.',
    {},
    async () => {
      // Select all and delete
      await input.keyDown('Meta');
      await input.keyPress('a');
      await input.keyUp('Meta');
      await input.keyPress('delete');
      return { content: [{ type: 'text', text: 'Cleared input field' }] };
    }
  );

  server.tool(
    'browser_evaluate',
    'Execute JavaScript on the page and return the result.',
    { expression: z.string().describe('JavaScript expression to evaluate') },
    async ({ expression }) => {
      const result = await cdp.evaluate(expression);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    'browser_get_url',
    'Get the current page URL and title.',
    {},
    async () => {
      const info = await cdp.getPageInfo();
      return { content: [{ type: 'text', text: `URL: ${info.url}\nTitle: ${info.title}` }] };
    }
  );

  server.tool(
    'browser_wait',
    'Wait for a CSS selector to appear on the page, or wait for a specified duration.',
    {
      selector: z.string().optional().describe('CSS selector to wait for'),
      timeout: z.number().optional().describe('Timeout in milliseconds (default 10000)'),
    },
    async ({ selector, timeout }) => {
      if (selector) {
        const found = await cdp.waitForSelector(selector, timeout ?? 10000);
        return {
          content: [{ type: 'text', text: found ? `Element "${selector}" found` : `Timeout waiting for "${selector}"` }],
        };
      } else {
        await new Promise(r => setTimeout(r, timeout ?? 1000));
        return { content: [{ type: 'text', text: `Waited ${timeout ?? 1000}ms` }] };
      }
    }
  );

  server.tool(
    'browser_tabs',
    'List all open browser tabs.',
    {},
    async () => {
      const tabs = await cdp.listTabs();
      const data = tabs.map((t, i) => ({ index: i, id: t.id, title: t.title, url: t.url }));
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    'browser_switch_tab',
    'Switch to a different browser tab by its ID (from browser_tabs).',
    { tabId: z.string().describe('Tab ID to switch to') },
    async ({ tabId }) => {
      await cdp.switchTab(tabId);
      const info = await cdp.getPageInfo();
      return { content: [{ type: 'text', text: `Switched to tab: ${info.title}\nURL: ${info.url}` }] };
    }
  );

  // ---- Network tools ----

  server.tool(
    'browser_network_start',
    'Start capturing network requests (XHR, fetch, etc.). Call this before performing actions you want to monitor.',
    {},
    async () => {
      await cdp.startNetworkCapture();
      return { content: [{ type: 'text', text: 'Network capture started. Perform actions, then use browser_network_get_requests to see traffic.' }] };
    }
  );

  server.tool(
    'browser_network_get_requests',
    'Get captured network requests. Optionally filter by URL substring.',
    {
      filter: z.string().optional().describe('Optional URL substring to filter requests'),
    },
    async ({ filter }) => {
      let requests = cdp.getNetworkRequests();
      if (filter) {
        requests = requests.filter((r) => r.url.includes(filter));
      }
      const summary = requests.map((r) => ({
        requestId: r.requestId,
        method: r.method,
        url: r.url,
        type: r.type,
        status: r.status,
        size: r.size,
      }));
      return { content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }] };
    }
  );

  server.tool(
    'browser_network_get_response',
    'Get the response body for a specific network request by its requestId.',
    {
      requestId: z.string().describe('The requestId from browser_network_get_requests'),
    },
    async ({ requestId }) => {
      try {
        const { body, base64Encoded } = await cdp.getNetworkResponseBody(requestId);
        const text = base64Encoded ? `[base64 encoded, ${body.length} chars]` : body;
        const LIMIT = 50000;
        if (text.length > LIMIT) {
          return { content: [{ type: 'text', text: text.substring(0, LIMIT) + '\n\n... (truncated at 50k chars)' }] };
        }
        return { content: [{ type: 'text', text }] };
      } catch (e) {
        return { content: [{ type: 'text', text: `Failed to get response body: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  server.tool(
    'browser_network_stop',
    'Stop capturing network requests and clear captured data.',
    {},
    async () => {
      cdp.stopNetworkCapture();
      cdp.clearNetworkCapture();
      return { content: [{ type: 'text', text: 'Network capture stopped and cleared.' }] };
    }
  );

  // ---- Accessibility tool ----

  server.tool(
    'browser_get_accessibility_tree',
    'Get the Chrome accessibility tree showing roles, names, values, and states of elements. Useful for understanding page structure from an assistive technology perspective.',
    {},
    async () => {
      const tree = await cdp.getAccessibilityTree();
      return { content: [{ type: 'text', text: tree }] };
    }
  );

  // ---- Console tools ----

  server.tool(
    'browser_console_start',
    'Start capturing browser console output (log, warn, error, exceptions). Call this before performing actions you want to debug.',
    {},
    async () => {
      await cdp.startConsoleCapture();
      return { content: [{ type: 'text', text: 'Console capture started. Perform actions, then use browser_console_get_logs to see output.' }] };
    }
  );

  server.tool(
    'browser_console_get_logs',
    'Get captured console logs. Optionally filter by level.',
    {
      level: z.enum(['all', 'log', 'warning', 'error', 'debug']).optional().describe('Filter by log level (default: all)'),
    },
    async ({ level }) => {
      let logs = cdp.getConsoleLogs();
      if (level && level !== 'all') {
        logs = logs.filter((l) => l.level === level);
      }
      if (logs.length === 0) {
        return { content: [{ type: 'text', text: 'No console logs captured.' }] };
      }
      const formatted = logs.map((l) => {
        let line = `[${l.level.toUpperCase()}] ${l.text}`;
        if (l.url) line += `\n  at ${l.url}${l.lineNumber !== undefined ? ':' + l.lineNumber : ''}`;
        return line;
      }).join('\n\n');
      return { content: [{ type: 'text', text: formatted }] };
    }
  );

  server.tool(
    'browser_console_stop',
    'Stop capturing console output and clear captured logs.',
    {},
    async () => {
      cdp.stopConsoleCapture();
      cdp.clearConsoleLogs();
      return { content: [{ type: 'text', text: 'Console capture stopped and cleared.' }] };
    }
  );

  // ---- Efficiency tools ----

  server.tool(
    'browser_inspect_page',
    'Get a structured overview of all interactive elements on the page with ready-to-use CSS selectors. Much more efficient than browser_get_dom for understanding what you can interact with. Returns elements with their types, labels, values, options, and states.',
    {},
    async () => {
      const inspection = await cdp.inspectPage();

      const lines: string[] = [];
      const scrollPct = inspection.scrollHeight <= inspection.viewportHeight
        ? 'no scroll'
        : `${Math.round((inspection.scrollTop / (inspection.scrollHeight - inspection.viewportHeight)) * 100)}%`;
      lines.push(`Page: ${inspection.title} | ${inspection.url}`);
      lines.push(`Viewport: ${inspection.viewportWidth}x${inspection.viewportHeight} | Scroll: ${Math.round(inspection.scrollTop)}/${inspection.scrollHeight} (${scrollPct})`);
      if (inspection.hasDialog) lines.push('⚠ Dialog detected');
      if (inspection.focusedSelector) lines.push(`Focused: ${inspection.focusedSelector}`);
      lines.push('');

      lines.push(`## Interactive Elements (${inspection.elements.length})`);
      for (const el of inspection.elements) {
        let line = `[${el.index}] ${el.tag}`;
        if (el.type) line += `[type=${el.type}]`;
        line += ` ${el.selector}`;
        if (el.label) line += ` | label: "${el.label}"`;
        if (el.text) line += ` | text: "${el.text}"`;
        if (el.value !== undefined) line += ` | value: "${el.value}"`;
        if (el.placeholder) line += ` | placeholder: "${el.placeholder}"`;
        if (el.options) line += ` | options: ${JSON.stringify(el.options)}`;
        if (el.checked !== undefined) line += ` | checked: ${el.checked}`;
        if (el.disabled) line += ' | DISABLED';
        if (el.draggable) line += ' | draggable';
        if (!el.inViewport) line += ' | OFF-SCREEN';
        lines.push(line);
      }

      if (inspection.forms.length > 0) {
        lines.push('');
        lines.push(`## Forms (${inspection.forms.length})`);
        for (const form of inspection.forms) {
          let line = form.selector;
          if (form.action) line += ` action="${form.action}"`;
          if (form.method) line += ` method="${form.method}"`;
          line += ` | contains elements [${form.elementIndices.join(', ')}]`;
          lines.push(line);
        }
      }

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }
  );

  server.tool(
    'browser_fill_form',
    'Batch-fill multiple form fields in a single call. Much more efficient than clicking and typing each field individually. Supports text inputs, textareas, selects, checkboxes, radios, and contenteditable elements. Works with React/Vue/Angular.',
    {
      actions: z.array(z.object({
        selector: z.string().describe('CSS selector of the form field'),
        value: z.string().optional().describe('Value to set (for text inputs, textareas, selects)'),
        selectText: z.string().optional().describe('For selects: visible text of the option to select'),
        check: z.boolean().optional().describe('For checkboxes/radios: whether to check (true) or uncheck (false)'),
        clear: z.boolean().optional().describe('Clear the field before setting value'),
      })).describe('Array of form fill actions'),
    },
    async ({ actions }) => {
      const result = await cdp.fillForm(actions);
      const lines = [`Filled ${result.succeeded}/${result.total} fields`];
      for (const r of result.results) {
        if (r.ok) {
          lines.push(`OK: ${r.selector} — "${r.previousValue}" → "${r.newValue}"`);
        } else {
          lines.push(`FAIL: ${r.selector} — ${r.error}`);
        }
      }
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }
  );

  server.tool(
    'browser_scroll_to',
    'Scroll an element into view. More precise than browser_scroll for targeting specific elements.',
    {
      selector: z.string().describe('CSS selector of the element to scroll into view'),
      block: z.enum(['start', 'center', 'end', 'nearest']).optional().describe('Vertical alignment (default: center)'),
    },
    async ({ selector, block }) => {
      const result = await cdp.scrollToElement(selector, block);
      return { content: [{ type: 'text', text: result.inViewport ? `Scrolled "${selector}" into view` : `Scrolled toward "${selector}" but it may not be fully in viewport` }] };
    }
  );

  server.tool(
    'browser_double_click',
    'Double-click an element on the page using a CSS selector.',
    { selector: z.string().describe('CSS selector of the element to double-click') },
    async ({ selector }) => {
      const coords = await elementToScreenCoords(selector);
      await input.doubleClick(coords.x, coords.y);
      await new Promise(r => setTimeout(r, 300));
      return { content: [{ type: 'text', text: `Double-clicked "${selector}" at (${coords.x}, ${coords.y})` }] };
    }
  );

  server.tool(
    'browser_right_click',
    'Right-click (context menu) an element on the page using a CSS selector.',
    { selector: z.string().describe('CSS selector of the element to right-click') },
    async ({ selector }) => {
      const coords = await elementToScreenCoords(selector);
      await input.rightClick(coords.x, coords.y);
      await new Promise(r => setTimeout(r, 300));
      return { content: [{ type: 'text', text: `Right-clicked "${selector}" at (${coords.x}, ${coords.y})` }] };
    }
  );

  server.tool(
    'browser_drag',
    `Drag from one element to another. Three modes:
- Default (no flags): Uses CDP mouse events with smooth intermediate moves. Works for most drag UIs (Sortable.js, React DnD with mouse backend, custom mousedown/mousemove/mouseup handlers).
- html5: true: Dispatches full HTML5 Drag and Drop API events (dragstart/dragenter/dragover/drop/dragend) with correct coordinates. Use for apps with [draggable="true"] and HTML5 DnD event listeners.
- native: true: Uses OS-level mouse input (cliclick/PowerShell). Only needed for canvas-based or non-standard UIs that don't respond to CDP events.`,
    {
      from: z.string().describe('CSS selector of the drag source element'),
      to: z.string().describe('CSS selector of the drop target element'),
      html5: z.boolean().optional().describe('Use HTML5 Drag and Drop API events (for [draggable="true"] elements)'),
      native: z.boolean().optional().describe('Use OS-level mouse input instead of CDP (for canvas/non-standard UIs)'),
      steps: z.number().optional().describe('Number of intermediate mouse moves (default 10, increase for sensitive UIs)'),
    },
    async ({ from, to, html5, native, steps }) => {
      if (html5) {
        const result = await cdp.dragHTML5(from, to);
        return { content: [{ type: 'text', text: `Dragged "${from}" → "${to}" (HTML5 DnD API) — ${result.success ? 'OK' : 'failed'}` }] };
      }

      if (native) {
        const fromCoords = await elementToScreenCoords(from);
        const toCoords = await elementToScreenCoords(to);
        await input.drag(fromCoords.x, fromCoords.y, toCoords.x, toCoords.y);
        return { content: [{ type: 'text', text: `Dragged "${from}" → "${to}" (native OS input)` }] };
      }

      // Default: CDP mouse events with smooth interpolation
      const result = await cdp.dragCDP(from, to, steps ?? 10);
      return { content: [{ type: 'text', text: `Dragged "${from}" → "${to}" (CDP, ${result.steps} steps, ${result.from.x.toFixed(0)},${result.from.y.toFixed(0)} → ${result.to.x.toFixed(0)},${result.to.y.toFixed(0)})` }] };
    }
  );
}
