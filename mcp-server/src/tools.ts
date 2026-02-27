import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as cdp from './cdp.js';
import * as input from './input.js';
import { elementToScreenCoords, pageToScreenCoords } from './coordinates.js';
import { generateSplinePath } from './motion.js';

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
      steps: z.number().optional().describe('Number of intermediate mouse moves (default 15, increase for sensitive UIs)'),
      activationDirection: z.enum(['auto', 'horizontal', 'vertical']).optional().describe('Direction of initial activation move: auto (toward target), horizontal, or vertical. Default: auto'),
    },
    async ({ from, to, html5, native, steps, activationDirection }) => {
      if (html5) {
        const result = await cdp.dragHTML5(from, to);
        return { content: [{ type: 'text', text: `Dragged "${from}" → "${to}" (HTML5 DnD API) — ${result.success ? 'OK' : 'failed'}` }] };
      }

      if (native) {
        const fromCoords = await elementToScreenCoords(from);
        const toCoords = await elementToScreenCoords(to);
        await input.dragSmooth(fromCoords.x, fromCoords.y, toCoords.x, toCoords.y, steps ?? 20);
        return { content: [{ type: 'text', text: `Dragged "${from}" → "${to}" (native smooth, ${steps ?? 20} steps)` }] };
      }

      // Default: CDP mouse events with bezier-eased interpolation
      const result = await cdp.dragCDP(from, to, steps ?? 15, 500, activationDirection ?? 'auto');
      return { content: [{ type: 'text', text: `Dragged "${from}" → "${to}" (CDP, ${result.steps} steps, ${result.from.x.toFixed(0)},${result.from.y.toFixed(0)} → ${result.to.x.toFixed(0)},${result.to.y.toFixed(0)})` }] };
    }
  );

  // ---- browser_draw ----
  server.tool(
    'browser_draw',
    `Draw a smooth path through a series of viewport-coordinate waypoints.
Uses Catmull-Rom spline interpolation for C1 continuity between segments.
Use cases: signing documents, drawing shapes, connecting diagram nodes, canvas interactions.
- Default: uses CDP mouse events (works for most canvas/drawing apps)
- native: true: routes through OS-level input for apps needing real OS events`,
    {
      waypoints: z.array(z.object({
        x: z.number().describe('Viewport X coordinate'),
        y: z.number().describe('Viewport Y coordinate'),
      })).min(2).describe('Array of 2+ viewport-coordinate waypoints to draw through'),
      steps: z.number().optional().describe('Total number of interpolated points (default 30)'),
      durationMs: z.number().optional().describe('Total drawing duration in milliseconds (default 600)'),
      native: z.boolean().optional().describe('Use OS-level mouse input instead of CDP'),
    },
    async ({ waypoints, steps, durationMs, native }) => {
      const path = generateSplinePath(waypoints, {
        steps: steps ?? 30,
        durationMs: durationMs ?? 600,
        easing: 'easeInOutCubic',
      });

      if (native) {
        // Route through OS input using dragSmooth from first to last point
        const first = path[0];
        const last = path[path.length - 1];
        const screenFirst = await pageToScreenCoords(first.x, first.y);
        const screenLast = await pageToScreenCoords(last.x, last.y);
        await input.dragSmooth(screenFirst.x, screenFirst.y, screenLast.x, screenLast.y, steps ?? 30, durationMs ?? 600);
        return { content: [{ type: 'text', text: `Drew path through ${waypoints.length} waypoints (native, ${path.length} points)` }] };
      }

      const result = await cdp.drawCDP(path);
      return { content: [{ type: 'text', text: `Drew path through ${waypoints.length} waypoints (CDP, ${result.pointCount} points)` }] };
    }
  );

  // ---- browser_move_smoothly ----
  server.tool(
    'browser_move_smoothly',
    `Move the cursor smoothly along a bezier curve to a target element or coordinates.
Uses OS-level input with eased motion for natural deceleration.
For hover effects requiring gradual approach (menus tracking mouse velocity, tooltip animations).`,
    {
      selector: z.string().optional().describe('CSS selector of the target element (alternative to x/y)'),
      x: z.number().optional().describe('Target viewport X coordinate'),
      y: z.number().optional().describe('Target viewport Y coordinate'),
      fromX: z.number().optional().describe('Starting viewport X coordinate (default: current cursor position estimated as 0,0)'),
      fromY: z.number().optional().describe('Starting viewport Y coordinate'),
      durationMs: z.number().optional().describe('Duration of movement in milliseconds (default 300)'),
    },
    async ({ selector, x, y, fromX, fromY, durationMs }) => {
      let targetX: number;
      let targetY: number;

      if (selector) {
        const coords = await elementToScreenCoords(selector);
        targetX = coords.x;
        targetY = coords.y;
      } else if (x !== undefined && y !== undefined) {
        const coords = await pageToScreenCoords(x, y);
        targetX = coords.x;
        targetY = coords.y;
      } else {
        return { content: [{ type: 'text', text: 'Must provide either selector or both x and y coordinates' }], isError: true };
      }

      const startX = fromX !== undefined ? (await pageToScreenCoords(fromX, fromY ?? 0)).x : targetX - 100;
      const startY = fromY !== undefined ? (await pageToScreenCoords(0, fromY)).y : targetY - 50;

      await input.moveSmooth(targetX, targetY, startX, startY, 15, durationMs ?? 300);
      return { content: [{ type: 'text', text: `Moved cursor smoothly to ${selector ?? `(${x},${y})`} over ${durationMs ?? 300}ms` }] };
    }
  );

  // ---- browser_reorder ----
  server.tool(
    'browser_reorder',
    `Reorder items in a sortable list by specifying the desired order.
Works with SortableJS, react-sortable-hoc, @dnd-kit, and plain DOM lists.
Provide the container CSS selector and an array of 0-based indices representing the new order.
Example: to move the 3rd item to position 1 in a 4-item list, use newOrder: [0, 2, 1, 3].`,
    {
      containerSelector: z.string().describe('CSS selector of the sortable list container'),
      newOrder: z.array(z.number()).describe('Array of 0-based indices in the desired new order (e.g. [2, 0, 1] moves item 2 first)'),
    },
    async ({ containerSelector, newOrder }) => {
      const result = await cdp.reorderList(containerSelector, newOrder);
      if (result.success) {
        const lines = [`Reordered ${result.newOrder.length} items (${result.method})`];
        lines.push(`Before: ${result.previousOrder.map((t, i) => `[${i}] ${t}`).join(', ')}`);
        lines.push(`After:  ${result.newOrder.map((t, i) => `[${i}] ${t}`).join(', ')}`);
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      } else {
        return { content: [{ type: 'text', text: `Reorder failed: ${result.error ?? 'unknown error'}` }], isError: true };
      }
    }
  );
}
