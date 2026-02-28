/**
 * Browser abstraction layer.
 *
 * Delegates to either:
 * - cdp.ts (default for extension mode / local visible Chrome)
 * - puppeteer-backend.ts (for headless server mode)
 *
 * Controlled by NAVVY_BROWSER env var:
 *   - "cdp" (default) — uses existing CDP module
 *   - "puppeteer" — uses Puppeteer for headless operation
 */

const BROWSER_BACKEND = process.env.NAVVY_BROWSER || 'cdp';

export function getBrowserBackend(): 'cdp' | 'puppeteer' {
  return BROWSER_BACKEND === 'puppeteer' ? 'puppeteer' : 'cdp';
}

export function isPuppeteerMode(): boolean {
  return BROWSER_BACKEND === 'puppeteer';
}

// Re-export everything from the appropriate backend
// The tools.ts module continues to import from cdp.ts directly
// (which is the default and most used path).
//
// For Puppeteer mode, tools.ts should check isPuppeteerMode()
// and use the puppeteer-backend module instead.
//
// This module provides a unified namespace for code that
// needs to work with both backends.

export async function getBackendModule() {
  if (BROWSER_BACKEND === 'puppeteer') {
    return await import('./puppeteer-backend.js');
  }
  return await import('./cdp.js');
}
