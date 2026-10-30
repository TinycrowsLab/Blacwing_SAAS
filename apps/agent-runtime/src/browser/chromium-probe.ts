import { chromium } from 'playwright-core';

import type { BrowserProbe } from './playwright-mcp.js';

/** Bound on the launch and on the canary navigation, in milliseconds. Past it the launch fails closed. */
const PROBE_TIMEOUT_MS = 15_000;

/**
 * The production launch probe (BROWSER-001). It starts a headless Chromium through the gateway proxy, loads the canary
 * over HTTPS with certificate errors not ignored, and closes the browser. The browser is ephemeral: no profile is
 * written to disk.
 */
export const chromiumProbe: BrowserProbe = async ({ proxyServer, canaryUrl, canaryBody }) => {
  const browser = await chromium.launch({
    headless: true,
    proxy: { server: proxyServer },
    timeout: PROBE_TIMEOUT_MS,
  });
  try {
    const page = await browser.newPage();
    const response = await page.goto(canaryUrl, { timeout: PROBE_TIMEOUT_MS });
    const body = response === null ? '' : await response.text();
    return { chromium: browser.version(), canarySeen: body.includes(canaryBody) };
  } finally {
    await browser.close();
  }
};
