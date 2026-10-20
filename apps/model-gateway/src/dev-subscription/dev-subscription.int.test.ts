// Integration tests for the dev subscription provider (#883): the gateway booted from config on a real
// socket against a local mock Anthropic upstream (no network egress). A sandbox stand-in authenticates
// with a `bwk_` virtual key; the host login is swapped in server-side and must never leak.
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { afterEach, describe, expect, it } from 'vitest';

import { createLogger } from '@blackwing/logger';

import { bootGateway } from '../boot.js';
import { loadGatewayConfig, type BwEnvironment } from '../config.js';
import { createGatewayMetrics, type GatewayMetrics } from '../metrics.js';
import { buildGateway } from '../server.js';
import {
  DEV_SUBSCRIPTION_OAUTH_BETA,
  DEFAULT_RETRY_AFTER_SECONDS,
  DevSubscriptionAdapter,
} from './adapter.js';
import { ClaudeCodeLoginStore } from './credentials.js';
import { DEV_SUBSCRIPTION_BANNER } from './guard.js';
import { sampleStream, startMockAnthropic, type MockAnthropic } from '../testing/mock-anthropic.js';

import type { GatewayAuditEvent } from '../audit.js';
import type { FastifyInstance } from 'fastify';
import type { AddressInfo } from 'node:net';

const DEV_TENANT = '0192f7a0-0000-7000-8000-000000000001';
const OTHER_TENANT = '0192f7a0-0000-7000-8000-000000000002';
const DEV_KEY = `bwk_${randomBytes(24).toString('hex')}`;
const DEV_KEY_SHA = createHash('sha256').update(DEV_KEY).digest('hex');

/** Subscription-format tokens generated per run: none is ever committed to the repo. */
function fakeOauthToken(): string {
  return `sk-ant-oat01-${randomBytes(32).toString('base64url')}`;
}

interface Harness {
  readonly mock: MockAnthropic;
  readonly app: FastifyInstance;
  readonly url: string;
  readonly logs: string[];
  readonly banner: string[];
  readonly audit: GatewayAuditEvent[];
  readonly spans: InMemorySpanExporter;
  readonly metrics: GatewayMetrics;
  readonly credentialsPath: string;
  readonly token: string;
  readonly refresh: string;
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function writeLogin(path: string, token: string, refresh: string, expiresAt: number): void {
  writeFileSync(
    path,
    JSON.stringify({ claudeAiOauth: { accessToken: token, refreshToken: refresh, expiresAt } }),
  );
}

async function setup(options: { expiresAt?: number } = {}): Promise<Harness> {
  const mock = await startMockAnthropic();
  cleanups.push(() => mock.close());
  const dir = mkdtempSync(join(tmpdir(), 'bw-devsub-int-'));
  cleanups.push(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const credentialsPath = join(dir, '.credentials.json');
  const token = fakeOauthToken();
  const refresh = fakeOauthToken();
  writeLogin(credentialsPath, token, refresh, options.expiresAt ?? Date.now() + 3_600_000);

  const logs: string[] = [];
  const logger = createLogger('devsub-int', {
    level: 'debug',
    nodeEnv: 'test',
    destination: { write: (line: string) => logs.push(line) },
  });
  const spans = new InMemorySpanExporter();
  const tracer = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(spans)],
  }).getTracer('test');
  const metrics = createGatewayMetrics();
  const audit: GatewayAuditEvent[] = [];
  const banner: string[] = [];
  const config = loadGatewayConfig({
    NODE_ENV: 'development',
    BW_ENV: 'dev',
    GATEWAY_ANTHROPIC_BASE_URL: mock.url,
    GATEWAY_UPSTREAM_TIMEOUT_MS: '5000',
    GATEWAY_DEFAULT_PROVIDER: 'dev_subscription',
    GATEWAY_DEV_SUBSCRIPTION_ENABLED: 'true',
    GATEWAY_DEV_SUBSCRIPTION_TENANT_IDS: DEV_TENANT,
    GATEWAY_DEV_VIRTUAL_KEY_SHA256: DEV_KEY_SHA,
    GATEWAY_DEV_SUBSCRIPTION_CREDENTIALS_FILE: credentialsPath,
  });
  const booted = bootGateway(config, {
    logger,
    write: (text) => banner.push(text),
    audit: { record: (event) => audit.push(event) },
    tracer,
    metrics,
  });
  cleanups.push(() => {
    booted.stop();
  });
  await booted.app.listen({ host: '127.0.0.1', port: 0 });
  cleanups.push(() => booted.app.close());
  const { port } = booted.app.server.address() as AddressInfo;
  return {
    mock,
    app: booted.app,
    url: `http://127.0.0.1:${String(port)}`,
    logs,
    banner,
    audit,
    spans,
    metrics,
    credentialsPath,
    token,
    refresh,
  };
}

function body(stream = false): string {
  return JSON.stringify({
    model: 'claude-test',
    max_tokens: 16,
    stream,
    messages: [{ role: 'user', content: 'hello' }],
  });
}

function sandboxHeaders(key = DEV_KEY): Record<string, string> {
  return {
    'content-type': 'application/json',
    'anthropic-version': '2023-06-01',
    'x-api-key': key,
  };
}

const okMessage = { id: 'msg_1', type: 'message', role: 'assistant', content: [] };

describe('dev subscription provider through the gateway', () => {
  it('prints the banner at boot and audits activation', async () => {
    const h = await setup();
    expect(h.banner.join('')).toContain(DEV_SUBSCRIPTION_BANNER);
    expect(h.logs.some((line) => line.includes(DEV_SUBSCRIPTION_BANNER))).toBe(true);
    expect(h.audit[0]).toEqual({
      type: 'gateway.dev_provider.active',
      provider: 'dev_subscription',
    });
  });

  it('serves a sandbox holding only a virtual key; the login is substituted server-side', async () => {
    const h = await setup();
    h.mock.handle((_request, response) => {
      response
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify(okMessage));
    });
    const response = await fetch(`${h.url}/v1/messages`, {
      method: 'POST',
      headers: { ...sandboxHeaders(), 'anthropic-beta': 'tools-2024-04-04' },
      body: body(),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(okMessage);
    const upstream = h.mock.requests[0];
    expect(upstream?.headers.authorization).toBe(`Bearer ${h.token}`);
    expect(upstream?.headers['x-api-key']).toBeUndefined();
    expect(upstream?.headers['anthropic-beta']).toBe(
      `tools-2024-04-04,${DEV_SUBSCRIPTION_OAUTH_BETA}`,
    );
    expect(JSON.stringify(upstream?.headers)).not.toContain(DEV_KEY);
    const request = h.audit.find((event) => event.type === 'gateway.request');
    expect(request).toMatchObject({
      provider: 'dev_subscription',
      status: 200,
      tenantId: DEV_TENANT,
    });
    const text = await h.metrics.registry.metrics();
    expect(text).toContain('provider="dev_subscription"');
  });

  it('streams SSE through unchanged', async () => {
    const h = await setup();
    h.mock.handle((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' }).end(sampleStream());
    });
    const response = await fetch(`${h.url}/v1/messages`, {
      method: 'POST',
      headers: sandboxHeaders(),
      body: body(true),
    });
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(await response.text()).toBe(sampleStream());
  });

  it('rejects a missing or unknown virtual key before reaching the provider', async () => {
    const h = await setup();
    for (const headers of [
      { 'content-type': 'application/json' },
      sandboxHeaders(`bwk_${randomBytes(24).toString('hex')}`),
    ]) {
      const response = await fetch(`${h.url}/v1/messages`, {
        method: 'POST',
        headers,
        body: body(),
      });
      expect(response.status).toBe(401);
    }
    expect(h.mock.requests).toHaveLength(0);
  });

  it('expired login: clear 401, no fallback to any other credential; a refreshed login works', async () => {
    const h = await setup({ expiresAt: Date.now() - 1_000 });
    h.mock.handle((_request, response) => {
      response
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify(okMessage));
    });
    const expired = await fetch(`${h.url}/v1/messages`, {
      method: 'POST',
      headers: sandboxHeaders(),
      body: body(),
    });
    expect(expired.status).toBe(401);
    const error = (await expired.json()) as { error: { type: string; message: string } };
    expect(error.error.type).toBe('authentication_error');
    expect(error.error.message).toMatch(/expired/);
    expect(h.mock.requests).toHaveLength(0);

    const refreshed = fakeOauthToken();
    writeLogin(h.credentialsPath, refreshed, h.refresh, Date.now() + 60_000);
    const ok = await fetch(`${h.url}/v1/messages`, {
      method: 'POST',
      headers: sandboxHeaders(),
      body: body(),
    });
    expect(ok.status).toBe(200);
    expect(h.mock.requests[0]?.headers.authorization).toBe(`Bearer ${refreshed}`);
  });

  it('surfaces subscription rate limits as 429 with retry hints', async () => {
    const h = await setup();
    const resetAt = Math.ceil(Date.now() / 1000) + 120;
    const cases: { headers: Record<string, string>; expected: (value: number) => boolean }[] = [
      { headers: { 'retry-after': '7' }, expected: (value) => value === 7 },
      {
        headers: { 'anthropic-ratelimit-unified-reset': String(resetAt) },
        expected: (value) => value > 100 && value <= 121,
      },
      { headers: {}, expected: (value) => value === DEFAULT_RETRY_AFTER_SECONDS },
    ];
    for (const testCase of cases) {
      h.mock.handle((_request, response) => {
        response
          .writeHead(429, { 'content-type': 'application/json', ...testCase.headers })
          .end(
            JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'slow' } }),
          );
      });
      const response = await fetch(`${h.url}/v1/messages`, {
        method: 'POST',
        headers: sandboxHeaders(),
        body: body(),
      });
      expect(response.status).toBe(429);
      const retryAfter = Number(response.headers.get('retry-after'));
      expect({ retryAfter, ok: testCase.expected(retryAfter) }).toEqual({ retryAfter, ok: true });
    }
  });

  it('secret scan: the login never appears in responses, logs, traces, metrics or audit', async () => {
    const h = await setup();
    // A hostile or buggy upstream echoes the credential in a header and inside the streamed body.
    h.mock.handle((_request, response) => {
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'x-echo': `token=${h.token}`,
      });
      const payload = `event: x\ndata: {"leak":"${h.token}","r":"${h.refresh}"}\n\n`;
      const middle = Math.floor(payload.length / 2);
      response.write(payload.slice(0, middle));
      setTimeout(() => response.end(payload.slice(middle)), 5);
    });
    const response = await fetch(`${h.url}/v1/messages`, {
      method: 'POST',
      headers: sandboxHeaders(),
      body: body(true),
    });
    const text = await response.text();
    const headers = JSON.stringify([...response.headers.entries()]);
    expect(text).toContain('[REDACTED]');
    const spans = JSON.stringify(
      h.spans.getFinishedSpans().map((span) => ({ name: span.name, attributes: span.attributes })),
    );
    const outputs = [
      text,
      headers,
      h.logs.join('\n'),
      spans,
      await h.metrics.registry.metrics(),
      JSON.stringify(h.audit),
    ];
    for (const output of outputs) {
      expect(output).not.toContain(h.token);
      expect(output).not.toContain(h.refresh);
      expect(output).not.toContain(DEV_KEY);
    }
  });

  it('a sandbox process never receives the login in its env or filesystem', async () => {
    const h = await setup();
    h.mock.handle((_request, response) => {
      response
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify(okMessage));
    });
    const workspace = mkdtempSync(join(tmpdir(), 'bw-devsub-sandbox-'));
    cleanups.push(() => {
      rmSync(workspace, { recursive: true, force: true });
    });
    // The sandbox stand-in gets the gateway URL and its virtual key, plus (worst case) everything the
    // gateway process itself has in its environment after loading the login.
    const script = `
      const fs = require('node:fs');
      fetch(process.env.ANTHROPIC_BASE_URL + '/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY },
        body: ${JSON.stringify(body())},
      }).then(async (r) => {
        fs.writeFileSync('response.json', await r.text());
        process.stdout.write(JSON.stringify({ status: r.status, env: process.env }));
      });`;
    const child = spawn(process.execPath, ['-e', script], {
      cwd: workspace,
      env: { ...process.env, ANTHROPIC_BASE_URL: h.url, ANTHROPIC_API_KEY: DEV_KEY },
    });
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    await new Promise<void>((resolve) =>
      child.once('close', () => {
        resolve();
      }),
    );
    const result = JSON.parse(stdout) as { status: number; env: Record<string, string> };
    expect(result.status).toBe(200);
    expect(JSON.stringify(result.env)).not.toContain(h.token);
    for (const file of readdirSync(workspace)) {
      expect(readFileSync(join(workspace, file), 'utf8')).not.toContain(h.token);
    }
  });
});

describe('dev subscription provider: per-request guard and tenant policy', () => {
  async function gateway(
    environment: { BW_ENV: BwEnvironment },
    tenantId: string,
  ): Promise<{ url: string; mock: MockAnthropic }> {
    const mock = await startMockAnthropic();
    cleanups.push(() => mock.close());
    const dir = mkdtempSync(join(tmpdir(), 'bw-devsub-guard-'));
    cleanups.push(() => {
      rmSync(dir, { recursive: true, force: true });
    });
    const path = join(dir, '.credentials.json');
    writeLogin(path, fakeOauthToken(), fakeOauthToken(), Date.now() + 60_000);
    const adapter = new DevSubscriptionAdapter({
      baseUrl: mock.url,
      credentials: new ClaudeCodeLoginStore({ path }),
      allowedTenantIds: [DEV_TENANT],
      environment: () => ({ ...environment, GATEWAY_DEV_SUBSCRIPTION_ENABLED: true }),
    });
    const app = buildGateway({
      config: { GATEWAY_MAX_BODY_BYTES: 1_000_000, GATEWAY_UPSTREAM_TIMEOUT_MS: 5_000 },
      adapter,
      logger: createLogger('devsub-guard', { level: 'silent', nodeEnv: 'test' }),
      verifier: { verify: () => ({ tenantId, keyId: 'k1' }) },
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    cleanups.push(() => app.close());
    const { port } = app.server.address() as AddressInfo;
    return { url: `http://127.0.0.1:${String(port)}`, mock };
  }

  it('denies tenants other than the dev/demo tenant', async () => {
    const { url, mock } = await gateway({ BW_ENV: 'dev' }, OTHER_TENANT);
    const response = await fetch(`${url}/v1/messages`, {
      method: 'POST',
      headers: sandboxHeaders(),
      body: body(),
    });
    expect(response.status).toBe(403);
    expect(mock.requests).toHaveLength(0);
  });

  it('refuses requests once the environment is no longer dev', async () => {
    const environment: { BW_ENV: BwEnvironment } = { BW_ENV: 'dev' };
    const { url, mock } = await gateway(environment, DEV_TENANT);
    environment.BW_ENV = 'production';
    const response = await fetch(`${url}/v1/messages`, {
      method: 'POST',
      headers: sandboxHeaders(),
      body: body(),
    });
    expect(response.status).toBe(403);
    expect(mock.requests).toHaveLength(0);
  });
});

describe('repository secret scan', () => {
  it('no subscription token or Claude Code credential file is committed', () => {
    const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
    const files = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).split('\n');
    expect(files.filter((file) => file.endsWith('.credentials.json'))).toEqual([]);
    let matches = '';
    try {
      matches = execFileSync('git', ['grep', '-nIE', 'sk-ant-o[ar]t[0-9]{2}-[A-Za-z0-9_-]{20,}'], {
        cwd: root,
        encoding: 'utf8',
      });
    } catch (error) {
      // `git grep` exits 1 when nothing matches.
      if ((error as { status?: number }).status !== 1) throw error;
    }
    expect(matches).toBe('');
  });
});
