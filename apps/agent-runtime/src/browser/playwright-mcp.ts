import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join } from 'node:path';

import { trace } from '@opentelemetry/api';
import { z } from 'zod';

import { AppError } from '@blackwing/errors';

import type { RuntimeMetrics } from '../metrics.js';
import type { McpStdioServerConfig } from '@anthropic-ai/claude-agent-sdk';
import type { Logger } from '@blackwing/logger';

/**
 * The agent browser: `@playwright/mcp` run as a stdio MCP server for specialist and recon sessions (BROWSER-001,
 * #626; CONTEXT_PACK §4.6, §5, §8.2, §8.9; REFERENCES §4).
 *
 * The browser has no path to the internet except the egress gateway. The server is launched with `--proxy-server`
 * set to the gateway, an isolated (in-memory) profile, headless Chromium and the accessibility-tree snapshot. HTTPS
 * errors are never ignored, so the per-run CA must validate. Before a session may use the browser, a launch
 * self-check proves the pinned versions, the proxy and the CA trust by loading a gateway-only canary page. Any
 * failure fails closed, and the browser is never handed to a session.
 */

/** The MCP server name. Its tools reach Claude as `mcp__playwright__<tool>` (the exposure matrix row). */
export const PLAYWRIGHT_SERVER_NAME = 'playwright';

/**
 * The pinned Playwright triple (IMAGE-005, §8.9). `@playwright/mcp` runs on `playwright-core`, which the root
 * `pnpm.overrides` pin to the same release as `@playwright/test`. Chromium is the build that core downloads. A launch
 * whose installed versions differ fails with `BROWSER_VERSION_MISMATCH`.
 */
export const PLAYWRIGHT_PIN = { playwrightMcp: '0.0.80', playwrightCore: '1.63.0' } as const;

/** The sandbox's own PATH. The host PATH is never inherited (same rule as the session environment). */
const SANDBOX_PATH = '/usr/local/bin:/usr/bin:/bin';
/** Browser artifacts (snapshots, screenshots) are written under the session workspace only. */
const BROWSER_OUTPUT_DIR = 'browser';

const manifestSchema = z.object({ version: z.string() });

export interface PlaywrightVersions {
  readonly playwrightMcp: string;
  readonly playwrightCore: string;
}

/** The versions a browser launch was verified against, plus the Chromium build it started (recorded per session). */
export interface BrowserLaunchRecord extends PlaywrightVersions {
  readonly chromium: string;
}

/** The result of the installed-package lookup: the versions and the MCP server's entry script. */
export interface InstalledPlaywright {
  readonly versions: PlaywrightVersions;
  readonly cliPath: string;
}

/** Refuses any installed triple other than the pin, before a browser is started (fail closed). */
export function assertPinnedVersions(versions: PlaywrightVersions): void {
  if (
    versions.playwrightMcp !== PLAYWRIGHT_PIN.playwrightMcp ||
    versions.playwrightCore !== PLAYWRIGHT_PIN.playwrightCore
  ) {
    throw new AppError(
      'BROWSER_VERSION_MISMATCH',
      'agent browser versions are not the pinned set',
      {
        detail:
          `expected @playwright/mcp ${PLAYWRIGHT_PIN.playwrightMcp} and playwright-core ${PLAYWRIGHT_PIN.playwrightCore}; ` +
          `found @playwright/mcp ${versions.playwrightMcp} and playwright-core ${versions.playwrightCore}`,
      },
    );
  }
}

/**
 * The version of the installed `@playwright/mcp` and of the `playwright-core` it resolves, read from their manifests,
 * plus the server's entry script. A package that cannot be resolved fails closed as `BROWSER_LAUNCH_FAILED`.
 */
export function installedPlaywright(): InstalledPlaywright {
  try {
    const require = createRequire(import.meta.url);
    const mcpManifest = require.resolve('@playwright/mcp/package.json');
    const coreManifest = createRequire(mcpManifest).resolve('playwright-core/package.json');
    return {
      cliPath: join(dirname(mcpManifest), 'cli.js'),
      versions: {
        playwrightMcp: readVersion(mcpManifest),
        playwrightCore: readVersion(coreManifest),
      },
    };
  } catch (error) {
    throw new AppError('BROWSER_LAUNCH_FAILED', 'agent browser packages are not installed', {
      cause: error,
    });
  }
}

function readVersion(manifestPath: string): string {
  return manifestSchema.parse(JSON.parse(readFileSync(manifestPath, 'utf8'))).version;
}

/**
 * The gateway proxy the browser must use, normalised to `scheme://host:port`. It must be an HTTP(S) URL with no
 * credentials (a secret never reaches argv or logs), and it is the only route out. A missing or other URL fails
 * closed as `BROWSER_PROXY_INVALID`.
 */
export function assertProxyServer(proxyUrl: string): string {
  let url: URL;
  try {
    url = new URL(proxyUrl);
  } catch {
    throw new AppError('BROWSER_PROXY_INVALID', 'agent browser proxy is not a valid URL');
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.host === '') {
    throw new AppError(
      'BROWSER_PROXY_INVALID',
      'agent browser proxy must be an HTTP(S) gateway URL',
    );
  }
  if (url.username !== '' || url.password !== '') {
    throw new AppError('BROWSER_PROXY_INVALID', 'agent browser proxy must not carry credentials');
  }
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new AppError('BROWSER_PROXY_INVALID', 'agent browser proxy must be a bare origin');
  }
  return `${url.protocol}//${url.host}`;
}

export interface PlaywrightMcpOptions {
  /** The egress gateway proxy, without credentials. Every browser request goes through it. */
  readonly proxyUrl: string;
  /** The per-run CA bundle. The browser trusts it through the store; HTTPS errors are never ignored. */
  readonly caBundlePath: string;
  /** The session workspace. It is the browser's HOME and holds the browser's output directory. */
  readonly workspaceDir: string;
  /** The `@playwright/mcp` entry script, from {@link installedPlaywright}. */
  readonly cliPath: string;
  /** Where the pinned Chromium is installed in the image. Absent, Playwright uses its default cache. */
  readonly browsersPath?: string;
}

/**
 * The stdio MCP server config for `@playwright/mcp` (BROWSER-001). It runs headless, with an isolated profile that
 * lives in memory and is never persisted, with the accessibility-tree snapshot and the gateway as the only proxy.
 * `--ignore-https-errors` is never passed, and the environment is an explicit allowlist.
 */
export function playwrightMcpServer(options: PlaywrightMcpOptions): McpStdioServerConfig {
  const proxyServer = assertProxyServer(options.proxyUrl);
  if (
    !isAbsolute(options.caBundlePath) ||
    !isAbsolute(options.workspaceDir) ||
    (options.browsersPath !== undefined && !isAbsolute(options.browsersPath))
  ) {
    throw new AppError('CONFIG_INVALID', 'agent browser paths must be absolute');
  }
  return {
    type: 'stdio',
    command: process.execPath,
    args: [
      options.cliPath,
      '--headless',
      '--browser',
      'chromium',
      '--isolated',
      '--snapshot-mode',
      'full',
      '--proxy-server',
      proxyServer,
      '--output-dir',
      join(options.workspaceDir, BROWSER_OUTPUT_DIR),
    ],
    env: {
      PATH: SANDBOX_PATH,
      HOME: options.workspaceDir,
      HTTP_PROXY: proxyServer,
      HTTPS_PROXY: proxyServer,
      ALL_PROXY: proxyServer,
      NODE_EXTRA_CA_CERTS: options.caBundlePath,
      SSL_CERT_FILE: options.caBundlePath,
      ...(options.browsersPath === undefined
        ? {}
        : { PLAYWRIGHT_BROWSERS_PATH: options.browsersPath }),
    },
  };
}

/** One launch probe: start Chromium through the proxy, load the canary and report what the page showed. */
interface BrowserProbeInput {
  readonly proxyServer: string;
  readonly canaryUrl: string;
  readonly canaryBody: string;
}

interface BrowserProbeResult {
  /** The Chromium build version that started. */
  readonly chromium: string;
  /** Whether the canary page showed the expected body. Only a gateway-served canary can show it. */
  readonly canarySeen: boolean;
}

/** Starts a browser, loads the canary and closes the browser. Injected so the self-check is testable offline. */
export type BrowserProbe = (input: BrowserProbeInput) => Promise<BrowserProbeResult>;

export interface BrowserLaunchCheckInput {
  readonly versions: PlaywrightVersions;
  readonly proxyUrl: string;
  readonly canaryUrl: string;
  readonly canaryBody: string;
  readonly probe: BrowserProbe;
  readonly metrics?: RuntimeMetrics;
  readonly log?: Logger;
}

/**
 * The launch self-check (BROWSER-001). It refuses unpinned versions and a bad proxy before any browser starts, then
 * runs the probe. The probe must reach the canary through the gateway and validate HTTPS against the per-run CA.
 * Any probe error, or a canary that does not show, fails with `BROWSER_LAUNCH_FAILED`. The result is recorded.
 */
export async function checkBrowserLaunch(
  input: BrowserLaunchCheckInput,
): Promise<BrowserLaunchRecord> {
  return trace
    .getTracer('@blackwing/agent-runtime')
    .startActiveSpan('browser.launch', async (span) => {
      try {
        const record = await runLaunchCheck(input);
        input.metrics?.browserLaunches.inc({ result: 'success' });
        input.log?.info({ component: 'browser', ...record }, 'browser.launch_ok');
        return record;
      } catch (error) {
        input.metrics?.browserLaunches.inc({ result: 'failure' });
        input.log?.warn(
          { component: 'browser', code: error instanceof AppError ? error.code : 'INTERNAL' },
          'browser.launch_failed',
        );
        throw error;
      } finally {
        span.end();
      }
    });
}

async function runLaunchCheck(input: BrowserLaunchCheckInput): Promise<BrowserLaunchRecord> {
  assertPinnedVersions(input.versions);
  const proxyServer = assertProxyServer(input.proxyUrl);
  let result: BrowserProbeResult;
  try {
    result = await input.probe({
      proxyServer,
      canaryUrl: input.canaryUrl,
      canaryBody: input.canaryBody,
    });
  } catch (error) {
    throw new AppError('BROWSER_LAUNCH_FAILED', 'agent browser could not load the gateway canary', {
      cause: error,
    });
  }
  if (!result.canarySeen) {
    throw new AppError(
      'BROWSER_LAUNCH_FAILED',
      'agent browser navigation did not reach the gateway',
      {
        detail: 'the canary page did not show the expected body',
      },
    );
  }
  return { ...input.versions, chromium: result.chromium };
}

export interface PlaywrightMcpSetupInput extends Omit<PlaywrightMcpOptions, 'cliPath'> {
  readonly canaryUrl: string;
  readonly canaryBody: string;
  readonly probe: BrowserProbe;
  readonly metrics?: RuntimeMetrics;
  readonly log?: Logger;
}

export interface PlaywrightMcpSetup {
  /** The `playwright` entry for a session's `mcpServers`. Only handed out after the self-check passed. */
  readonly server: McpStdioServerConfig;
  readonly record: BrowserLaunchRecord;
}

/**
 * Prepares the agent browser for one session (BROWSER-001): resolves the pinned packages, runs the launch self-check
 * and returns the MCP server config. A failed check throws and no server config is returned, so a session cannot
 * mount an unchecked browser.
 */
export async function setupPlaywrightMcp(
  input: PlaywrightMcpSetupInput,
): Promise<PlaywrightMcpSetup> {
  const installed = installedPlaywright();
  const server = playwrightMcpServer({
    proxyUrl: input.proxyUrl,
    caBundlePath: input.caBundlePath,
    workspaceDir: input.workspaceDir,
    cliPath: installed.cliPath,
    ...(input.browsersPath === undefined ? {} : { browsersPath: input.browsersPath }),
  });
  const record = await checkBrowserLaunch({
    versions: installed.versions,
    proxyUrl: input.proxyUrl,
    canaryUrl: input.canaryUrl,
    canaryBody: input.canaryBody,
    probe: input.probe,
    ...(input.metrics === undefined ? {} : { metrics: input.metrics }),
    ...(input.log === undefined ? {} : { log: input.log }),
  });
  return { server, record };
}
