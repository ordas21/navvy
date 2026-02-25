import * as cdp from './cdp.js';

/**
 * Translate a CSS selector to absolute screen coordinates (center of the element).
 * Accounts for Chrome's window position and toolbar height.
 */
export async function elementToScreenCoords(selector: string): Promise<{ x: number; y: number }> {
  const bounds = await cdp.getElementBounds(selector);
  const win = await cdp.getWindowBounds();

  // Chrome toolbar height = outerHeight - innerHeight
  const toolbarHeight = win.outerHeight - win.innerHeight;

  // Center of the element in screen coordinates
  const screenX = win.screenX + bounds.x + bounds.width / 2;
  const screenY = win.screenY + toolbarHeight + bounds.y + bounds.height / 2;

  return { x: Math.round(screenX), y: Math.round(screenY) };
}

/**
 * Translate a page-relative point to screen coordinates.
 */
export async function pageToScreenCoords(pageX: number, pageY: number): Promise<{ x: number; y: number }> {
  const win = await cdp.getWindowBounds();
  const toolbarHeight = win.outerHeight - win.innerHeight;

  return {
    x: Math.round(win.screenX + pageX),
    y: Math.round(win.screenY + toolbarHeight + pageY),
  };
}
