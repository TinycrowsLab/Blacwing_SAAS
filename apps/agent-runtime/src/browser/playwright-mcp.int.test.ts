import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer as createHttpServer, type Server } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { connect, createServer as createNetServer, type AddressInfo } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppError } from '@blackwing/errors';

import { chromiumProbe } from './chromium-probe.js';
import { installedPlaywright, playwrightMcpServer, setupPlaywrightMcp } from './playwright-mcp.js';

/*
 * Real Chromium through a fake gateway (BROWSER-001, #626). These tests start the pinned headless Chromium and
 * `@playwright/mcp`, so they run under `pnpm test:int`. The gateway records every request it serves, which is the
 * observation the launch self-check and the browser tests rely on.
 */

const CANARY_HOST = 'canary.bw.internal';
const CANARY_URL = `http://${CANARY_HOST}/probe`;
const CANARY_TLS_HOST = 'canary-tls.bw.internal';
const CANARY_TLS_URL = `https://${CANARY_TLS_HOST}/probe`;
const CANARY_BODY = 'bw-canary-7f3a';
/** Where the pinned browsers are installed on the box that runs these tests. */
const BROWSERS_PATH = join(homedir(), '.cache', 'ms-playwright');

interface Gateway {
  readonly url: string;
  readonly seen: string[];
  readonly close: () => Promise<void>;
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve((server.address() as AddressInfo).port);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => {
      resolve();
    });
  });
}

/**
 * A fake egress gateway. Plain requests and CONNECT tunnels are recorded, and only the canary host and the TLS canary
 * are served, so a request that bypasses the gateway has nowhere to go.
 */
async function startGateway(tlsPort: number): Promise<Gateway> {
  const seen: string[] = [];
  const proxy = createHttpServer((req, res) => {
    seen.push(`GET ${req.url ?? ''}`);
    const target = new URL(req.url ?? '/', 'http://invalid');
    if (target.hostname === CANARY_HOST && target.pathname === '/probe') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(CANARY_BODY);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  proxy.on('connect', (req, client, head) => {
    seen.push(`CONNECT ${req.url ?? ''}`);
    const [host] = (req.url ?? '').split(':');
    if (host !== CANARY_TLS_HOST) {
      client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    const upstream = connect(tlsPort, '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on('error', () => {
      client.destroy();
    });
    client.on('error', () => {
      upstream.destroy();
    });
  });
  const port = await listen(proxy);
  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    close: () => closeServer(proxy),
  };
}

/** A port nothing listens on: the gateway is down. */
async function closedPortUrl(): Promise<string> {
  const server = createNetServer();
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve((server.address() as AddressInfo).port);
    });
  });
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  return `http://127.0.0.1:${port}`;
}

let workRoot: string;
let caPath: string;
let tlsServer: Server;
let gateway: Gateway;
let tlsPort: number;

beforeAll(async () => {
  workRoot = mkdtempSync(join(tmpdir(), 'bw-browser-'));
  const keyPath = join(workRoot, 'key.pem');
  caPath = join(workRoot, 'ca.pem');
  // A self-signed certificate that no store trusts: the per-run CA in this test is not in the browser's store.
  execFileSync('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    keyPath,
    '-out',
    caPath,
    '-days',
    '1',
    '-subj',
    `/CN=${CANARY_TLS_HOST}`,
    '-addext',
    `subjectAltName=DNS:${CANARY_TLS_HOST}`,
  ]);
  tlsServer = createHttpsServer(
    { key: readFileSync(keyPath), cert: readFileSync(caPath) },
    (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(CANARY_BODY);
    },
  );
  tlsPort = await listen(tlsServer);
  gateway = await startGateway(tlsPort);
});

afterAll(async () => {
  await gateway.close();
  await closeServer(tlsServer);
  rmSync(workRoot, { recursive: true, force: true });
});

function setupInput(proxyUrl: string, canaryUrl: string) {
  return {
    proxyUrl,
    caBundlePath: caPath,
    workspaceDir: workRoot,
    canaryUrl,
    canaryBody: CANARY_BODY,
    probe: chromiumProbe,
  };
}

describe('agent browser launch self-check, with real Chromium', () => {
  it('loads the canary through the gateway and records the Chromium build', async () => {
    gateway.seen.length = 0;
    const setup = await setupPlaywrightMcp(setupInput(gateway.url, CANARY_URL));
    expect(setup.record.chromium).toMatch(/^\d+\.\d+/);
    expect(setup.record.playwrightCore).toBe('1.63.0');
    expect(gateway.seen).toContain(`GET ${CANARY_URL}`);
  });

  it('fails closed when the gateway is down, so no browser route exists', async () => {
    const down = await closedPortUrl();
    await expect(setupPlaywrightMcp(setupInput(down, CANARY_URL))).rejects.toMatchObject({
      code: 'BROWSER_LAUNCH_FAILED',
    });
  });

  it('refuses an HTTPS canary whose certificate is not trusted, because HTTPS errors are never ignored', async () => {
    gateway.seen.length = 0;
    const failure = await setupPlaywrightMcp(setupInput(gateway.url, CANARY_TLS_URL)).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(AppError);
    expect((failure as AppError).code).toBe('BROWSER_LAUNCH_FAILED');
    expect(gateway.seen).toContain(`CONNECT ${CANARY_TLS_HOST}:443`);
  });
});

describe('@playwright/mcp as a session MCP server, with real Chromium', () => {
  it('navigates through the gateway from an MCP tool call and never reaches the internet directly', async () => {
    gateway.seen.length = 0;
    const server = playwrightMcpServer({
      proxyUrl: gateway.url,
      caBundlePath: caPath,
      workspaceDir: workRoot,
      cliPath: installedPlaywright().cliPath,
      browsersPath: BROWSERS_PATH,
    });
    const client = new Client({ name: 'bw-browser-test', version: '1.0.0' });
    const transport = new StdioClientTransport({
      command: server.command,
      args: server.args ?? [],
      env: server.env ?? {},
    });
    await client.connect(transport);
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toContain('browser_navigate');
      const result = await client.callTool({
        name: 'browser_navigate',
        arguments: { url: CANARY_URL },
      });
      const text = JSON.stringify(result.content);
      expect(text).not.toContain('### Error');
      expect(text).toContain(`Page URL: ${CANARY_URL}`);
      expect(gateway.seen).toContain(`GET ${CANARY_URL}`);
    } finally {
      await client.close();
    }
  });
});
