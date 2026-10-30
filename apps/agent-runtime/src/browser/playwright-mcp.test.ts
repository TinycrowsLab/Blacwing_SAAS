import { describe, expect, it, vi } from 'vitest';

import { AppError } from '@blackwing/errors';

import { createRuntimeMetrics } from '../metrics.js';
import {
  assertPinnedVersions,
  assertProxyServer,
  checkBrowserLaunch,
  installedPlaywright,
  PLAYWRIGHT_PIN,
  PLAYWRIGHT_SERVER_NAME,
  playwrightMcpServer,
  setupPlaywrightMcp,
  type BrowserProbe,
  type PlaywrightVersions,
} from './playwright-mcp.js';

const PINNED: PlaywrightVersions = {
  playwrightMcp: PLAYWRIGHT_PIN.playwrightMcp,
  playwrightCore: PLAYWRIGHT_PIN.playwrightCore,
};
const PROXY = 'http://egress.bw.internal:3128';
const CA = '/etc/bw/ca.pem';
const WORKSPACE = '/workspace/session-1';
const CANARY_URL = 'http://canary.bw.internal/probe';
const CANARY_BODY = 'bw-canary-7f3a';
const CLI = '/opt/bw/node_modules/@playwright/mcp/cli.js';

/** A probe that stands in for a real browser. It records its input and returns the given result. */
function fakeProbe(result: { chromium?: string; canarySeen?: boolean } = {}): {
  probe: BrowserProbe;
  calls: unknown[];
} {
  const calls: unknown[] = [];
  const probe: BrowserProbe = (input) => {
    calls.push(input);
    return Promise.resolve({
      chromium: result.chromium ?? '153.0.8010.12',
      canarySeen: result.canarySeen ?? true,
    });
  };
  return { probe, calls };
}

function codeOf(error: unknown): string | undefined {
  return error instanceof AppError ? error.code : undefined;
}

/** The `AppError` code a synchronous call throws, or `undefined` when it does not throw. */
function thrownCode(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return codeOf(error);
  }
  return undefined;
}

describe('pinned Playwright versions', () => {
  it('accepts exactly the pinned @playwright/mcp and playwright-core', () => {
    expect(() => {
      assertPinnedVersions(PINNED);
    }).not.toThrow();
  });

  it('refuses any other @playwright/mcp or playwright-core before a browser starts', () => {
    for (const drift of [
      { ...PINNED, playwrightMcp: '0.0.81' },
      { ...PINNED, playwrightCore: '1.63.0-alpha-2026-08-31' },
      { playwrightMcp: '0.0.80', playwrightCore: '1.64.0' },
    ]) {
      expect(
        thrownCode(() => {
          assertPinnedVersions(drift);
        }),
      ).toBe('BROWSER_VERSION_MISMATCH');
    }
  });

  it('reads the installed packages and they match the pin', () => {
    const installed = installedPlaywright();
    expect(installed.versions).toEqual(PINNED);
    expect(installed.cliPath.endsWith('cli.js')).toBe(true);
  });
});

describe('assertProxyServer', () => {
  it('normalises a bare HTTP(S) gateway origin', () => {
    expect(assertProxyServer(PROXY)).toBe(PROXY);
    expect(assertProxyServer('https://egress.bw.internal:3129/')).toBe(
      'https://egress.bw.internal:3129',
    );
  });

  it('fails closed on a missing, malformed or non-HTTP proxy', () => {
    for (const bad of ['', 'not a url', 'socks5://egress:1080', 'ftp://egress:21', 'http://']) {
      expect(
        thrownCode(() => assertProxyServer(bad)),
        bad,
      ).toBe('BROWSER_PROXY_INVALID');
    }
  });

  it('refuses credentials, paths, queries and fragments so no secret reaches argv or logs', () => {
    for (const bad of [
      'http://session-1:secret@egress:3128',
      'http://session-1@egress:3128',
      'http://egress:3128/path',
      'http://egress:3128?x=1',
      'http://egress:3128#frag',
    ]) {
      expect(
        thrownCode(() => assertProxyServer(bad)),
        bad,
      ).toBe('BROWSER_PROXY_INVALID');
    }
  });
});

describe('playwrightMcpServer', () => {
  const server = playwrightMcpServer({
    proxyUrl: PROXY,
    caBundlePath: CA,
    workspaceDir: WORKSPACE,
    cliPath: CLI,
  });

  it('runs @playwright/mcp as a stdio server with the gateway as its only proxy', () => {
    expect(server.type).toBe('stdio');
    expect(server.command).toBe(process.execPath);
    expect(server.args).toEqual([
      CLI,
      '--headless',
      '--browser',
      'chromium',
      '--isolated',
      '--snapshot-mode',
      'full',
      '--proxy-server',
      PROXY,
      '--output-dir',
      `${WORKSPACE}/browser`,
    ]);
  });

  it('never ignores HTTPS errors and never keeps a persistent profile', () => {
    expect(server.args).not.toContain('--ignore-https-errors');
    expect(server.args).not.toContain('--user-data-dir');
    expect(server.args).not.toContain('--storage-state');
  });

  it('builds its environment from an allowlist with the proxy and the per-run CA only', () => {
    expect(server.env).toEqual({
      PATH: '/usr/local/bin:/usr/bin:/bin',
      HOME: WORKSPACE,
      HTTP_PROXY: PROXY,
      HTTPS_PROXY: PROXY,
      ALL_PROXY: PROXY,
      NODE_EXTRA_CA_CERTS: CA,
      SSL_CERT_FILE: CA,
    });
  });

  it('passes the browser install path only when one is given', () => {
    const withBrowsers = playwrightMcpServer({
      proxyUrl: PROXY,
      caBundlePath: CA,
      workspaceDir: WORKSPACE,
      cliPath: CLI,
      browsersPath: '/opt/bw/browsers',
    });
    expect(withBrowsers.env).toMatchObject({ PLAYWRIGHT_BROWSERS_PATH: '/opt/bw/browsers' });
    expect(server.env).not.toHaveProperty('PLAYWRIGHT_BROWSERS_PATH');
  });

  it('refuses a missing proxy, a credentialed proxy and relative paths', () => {
    expect(
      thrownCode(() =>
        playwrightMcpServer({
          proxyUrl: '',
          caBundlePath: CA,
          workspaceDir: WORKSPACE,
          cliPath: CLI,
        }),
      ),
    ).toBe('BROWSER_PROXY_INVALID');
    expect(
      thrownCode(() =>
        playwrightMcpServer({
          proxyUrl: 'http://u:p@egress:3128',
          caBundlePath: CA,
          workspaceDir: WORKSPACE,
          cliPath: CLI,
        }),
      ),
    ).toBe('BROWSER_PROXY_INVALID');
    expect(
      thrownCode(() =>
        playwrightMcpServer({
          proxyUrl: PROXY,
          caBundlePath: 'ca.pem',
          workspaceDir: WORKSPACE,
          cliPath: CLI,
        }),
      ),
    ).toBe('CONFIG_INVALID');
    expect(
      thrownCode(() =>
        playwrightMcpServer({
          proxyUrl: PROXY,
          caBundlePath: CA,
          workspaceDir: WORKSPACE,
          cliPath: CLI,
          browsersPath: 'relative/browsers',
        }),
      ),
    ).toBe('CONFIG_INVALID');
  });

  it('is named playwright, which is the server name the exposure matrix uses', () => {
    expect(PLAYWRIGHT_SERVER_NAME).toBe('playwright');
  });
});

describe('checkBrowserLaunch', () => {
  it('returns the verified versions and the Chromium build when the canary is seen through the gateway', async () => {
    const { probe, calls } = fakeProbe({ chromium: '153.0.8010.12' });
    const metrics = createRuntimeMetrics();
    const record = await checkBrowserLaunch({
      versions: PINNED,
      proxyUrl: PROXY,
      canaryUrl: CANARY_URL,
      canaryBody: CANARY_BODY,
      probe,
      metrics,
    });
    expect(record).toEqual({ ...PINNED, chromium: '153.0.8010.12' });
    expect(calls).toEqual([{ proxyServer: PROXY, canaryUrl: CANARY_URL, canaryBody: CANARY_BODY }]);
    expect(await metrics.registry.metrics()).toContain('browser_launch_total{result="success"} 1');
  });

  it('fails closed with BROWSER_VERSION_MISMATCH without starting a browser', async () => {
    const { probe, calls } = fakeProbe();
    await expect(
      checkBrowserLaunch({
        versions: { ...PINNED, playwrightCore: '1.64.0' },
        proxyUrl: PROXY,
        canaryUrl: CANARY_URL,
        canaryBody: CANARY_BODY,
        probe,
      }),
    ).rejects.toMatchObject({ code: 'BROWSER_VERSION_MISMATCH' });
    expect(calls).toHaveLength(0);
  });

  it('fails closed with BROWSER_PROXY_INVALID when the proxy is missing, before any browser starts', async () => {
    const { probe, calls } = fakeProbe();
    await expect(
      checkBrowserLaunch({
        versions: PINNED,
        proxyUrl: '',
        canaryUrl: CANARY_URL,
        canaryBody: CANARY_BODY,
        probe,
      }),
    ).rejects.toMatchObject({ code: 'BROWSER_PROXY_INVALID' });
    expect(calls).toHaveLength(0);
  });

  it('fails with BROWSER_LAUNCH_FAILED when the probe throws (gateway down, CA not trusted, no browser)', async () => {
    const probe = vi.fn<BrowserProbe>(() => {
      throw new Error('net::ERR_PROXY_CONNECTION_FAILED');
    });
    const metrics = createRuntimeMetrics();
    const failure = await checkBrowserLaunch({
      versions: PINNED,
      proxyUrl: PROXY,
      canaryUrl: CANARY_URL,
      canaryBody: CANARY_BODY,
      probe,
      metrics,
    }).catch((error: unknown) => error);
    expect(codeOf(failure)).toBe('BROWSER_LAUNCH_FAILED');
    expect(await metrics.registry.metrics()).toContain('browser_launch_total{result="failure"} 1');
  });

  it('fails closed when the canary body is not shown, so a direct or unrouted navigation cannot pass', async () => {
    const { probe } = fakeProbe({ canarySeen: false });
    await expect(
      checkBrowserLaunch({
        versions: PINNED,
        proxyUrl: PROXY,
        canaryUrl: CANARY_URL,
        canaryBody: CANARY_BODY,
        probe,
      }),
    ).rejects.toMatchObject({ code: 'BROWSER_LAUNCH_FAILED' });
  });
});

describe('setupPlaywrightMcp', () => {
  it('returns the server config only after the self-check passed', async () => {
    const { probe } = fakeProbe();
    const setup = await setupPlaywrightMcp({
      proxyUrl: PROXY,
      caBundlePath: CA,
      workspaceDir: WORKSPACE,
      canaryUrl: CANARY_URL,
      canaryBody: CANARY_BODY,
      probe,
    });
    expect(setup.record.playwrightMcp).toBe(PINNED.playwrightMcp);
    expect(setup.record.playwrightCore).toBe(PINNED.playwrightCore);
    expect(setup.server.type).toBe('stdio');
    expect(setup.server.args?.[0]).toMatch(/cli\.js$/);
  });

  it('returns nothing when the self-check fails, so a session cannot mount an unchecked browser', async () => {
    const { probe } = fakeProbe({ canarySeen: false });
    await expect(
      setupPlaywrightMcp({
        proxyUrl: PROXY,
        caBundlePath: CA,
        workspaceDir: WORKSPACE,
        canaryUrl: CANARY_URL,
        canaryBody: CANARY_BODY,
        probe,
      }),
    ).rejects.toMatchObject({ code: 'BROWSER_LAUNCH_FAILED' });
  });
});
