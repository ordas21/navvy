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
      const data = await cdp.captureScreenshot();
      return {
        content: [{ type: 'image', data, mimeType: 'image/png' }],
      };
    }
  );

  server.tool(
    'browser_get_dom',
    'Get a simplified DOM tree of the current page showing tags, ids, classes, roles, hrefs, and text content. Useful for understanding page structure and finding selectors.',
    {},
    async () => {
      const dom = await cdp.getSimplifiedDOM();
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
    'Type text using native OS keyboard input. The text will be typed at the currently focused element.',
    { text: z.string().describe('Text to type') },
    async ({ text }) => {
      await input.type(text);
      return { content: [{ type: 'text', text: `Typed: "${text}"` }] };
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
    'Scroll the page up or down.',
    {
      direction: z.enum(['up', 'down']).describe('Scroll direction'),
      amount: z.number().optional().describe('Scroll amount in pixels (default 500)'),
    },
    async ({ direction, amount }) => {
      await cdp.scrollPage(direction, amount ?? 500);
      return { content: [{ type: 'text', text: `Scrolled ${direction} by ${amount ?? 500}px` }] };
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
      const text = tabs.map((t, i) => `[${i}] ${t.title}\n    ${t.url}\n    id: ${t.id}`).join('\n\n');
      return { content: [{ type: 'text', text: text || 'No tabs found' }] };
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
}
