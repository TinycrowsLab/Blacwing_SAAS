// Integration tests for GATEWAY-001 (#404): the gateway on a real socket against a local mock Anthropic
// upstream (no network egress). Covers stream/non-stream fidelity, health/metrics, size and JSON guards,
// status passthrough, client-abort cleanup, version defaulting, timeouts and trace propagation.
import { request as httpRequest, type ServerResponse } from 'node:http';

import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { afterEach, describe, expect, it } from 'vitest';

import { anthropicErrorBodySchema, DEFAULT_ANTHROPIC_VERSION } from '@blackwing/contracts';
import { createLogger } from '@blackwing/logger';

import { createGatewayMetrics, type GatewayMetrics } from './metrics.js';
import { AnthropicAdapter } from './providers/anthropic.js';
import { staticApiKeyResolver } from './providers/credentials.js';
import { buildGateway } from './server.js';
import {
  type MockAnthropic,
  sampleStream,
  sseEvent,
  startMockAnthropic,
} from './testing/mock-anthropic.js';

import type { ProviderAdapter } from './provider.js';
import type { FastifyInstance } from 'fastify';
import type { AddressInfo } from 'node:net';

const SECRET_PROMPT = 'prompt-text-that-must-never-be-logged';
const PROVIDER_KEY = 'sk-provider-test-key-0123456789';

interface Harness {
  readonly mock: MockAnthropic;
  readonly app: FastifyInstance;
  readonly url: string;
  readonly metrics: GatewayMetrics;
  readonly logs: string[];
  readonly spans: InMemorySpanExporter;
}

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup(
  options: { maxBodyBytes?: number; timeoutMs?: number; adapter?: ProviderAdapter } = {},
): Promise<Harness> {
  const mock = await startMockAnthropic();
  cleanups.push(() => mock.close());
  const logs: string[] = [];
  const logger = createLogger('model-gateway-test', {
    level: 'debug',
    nodeEnv: 'test',
    destination: { write: (line: string) => logs.push(line) },
  });
  const spans = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(spans)] });
  const metrics = createGatewayMetrics();
  const app = buildGateway({
    config: {
      GATEWAY_MAX_BODY_BYTES: options.maxBodyBytes ?? 10_485_760,
      GATEWAY_UPSTREAM_TIMEOUT_MS: options.timeoutMs ?? 5_000,
    },
    adapter:
      options.adapter ??
      new AnthropicAdapter({
        baseUrl: mock.url,
        resolveCredential: staticApiKeyResolver(PROVIDER_KEY),
        metrics,
      }),
    logger,
    metrics,
    tracer: provider.getTracer('test'),
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  cleanups.push(() => app.close());
  const { port } = app.server.address() as AddressInfo;
  return { mock, app, url: `http://127.0.0.1:${String(port)}`, metrics, logs, spans };
}

function messagesBody(stream: boolean): string {
  return JSON.stringify({
    model: 'claude-test',
    max_tokens: 64,
    stream,
    messages: [{ role: 'user', content: SECRET_PROMPT }],
  });
}

const clientHeaders = {
  'content-type': 'application/json',
  'anthropic-version': '2023-06-01',
  'x-api-key': 'bw_vk_sandbox_session_key',
  authorization: 'Bearer bw_vk_sandbox_session_key',
};

/** Writes `payload` in irregular slices, splitting events mid-line and mid-UTF-8 sequence. */
async function writeInSlices(response: ServerResponse, payload: string): Promise<void> {
  const bytes = Buffer.from(payload, 'utf8');
  const sizes = [1, 7, 13, 2, 50, 3, 97, 5];
  let offset = 0;
  let index = 0;
  while (offset < bytes.length) {
    const size = sizes[index % sizes.length] ?? 16;
    response.write(bytes.subarray(offset, offset + size));
    offset += size;
    index += 1;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  response.end();
}

function parseSse(text: string): { event: string; data: unknown }[] {
  return text
    .split('\n\n')
    .filter((block) => block.length > 0)
    .map((block) => {
      const event = /^event: (.*)$/m.exec(block)?.[1] ?? '';
      const data = /^data: (.*)$/m.exec(block)?.[1] ?? 'null';
      return { event, data: JSON.parse(data) as unknown };
    });
}

async function metricValue(
  metrics: GatewayMetrics,
  name: string,
  labels: Record<string, string> = {},
): Promise<number> {
  const metric = await metrics.registry.getSingleMetric(name)?.get();
  const match = metric?.values.find((value) =>
    Object.entries(labels).every(([key, expected]) => String(value.labels[key]) === expected),
  );
  return match?.value ?? 0;
}

async function waitFor(check: () => Promise<boolean> | boolean, ms = 2_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('POST /v1/messages streaming', () => {
  it('yields byte-identical SSE events to a direct upstream call, even with irregular chunking', async () => {
    const h = await setup();
    h.mock.handle(async (_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream', 'request-id': 'req_mock_1' });
      await writeInSlices(response, sampleStream());
    });

    const direct = await fetch(`${h.mock.url}/v1/messages`, {
      method: 'POST',
      headers: clientHeaders,
      body: messagesBody(true),
    });
    const directBytes = Buffer.from(await direct.arrayBuffer());

    const proxied = await fetch(`${h.url}/v1/messages`, {
      method: 'POST',
      headers: clientHeaders,
      body: messagesBody(true),
    });
    const proxiedBytes = Buffer.from(await proxied.arrayBuffer());

    expect(proxied.status).toBe(200);
    expect(proxied.headers.get('content-type')).toBe('text/event-stream');
    expect(proxied.headers.get('request-id')).toBe('req_mock_1');
    expect(proxiedBytes.equals(directBytes)).toBe(true);
    expect(proxiedBytes.toString('utf8')).toBe(sampleStream());
    expect(parseSse(proxiedBytes.toString('utf8')).map((e) => e.event)).toEqual([
      'message_start',
      'content_block_start',
      'ping',
      'content_block_delta',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ]);
  });

  it('forwards the first event before the upstream finishes (no whole-body buffering)', async () => {
    const h = await setup();
    let release: () => void = () => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.mock.handle(async (_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(sseEvent('message_start', { type: 'message_start' }));
      await released;
      response.end(sseEvent('message_stop', { type: 'message_stop' }));
    });

    const response = await fetch(`${h.url}/v1/messages`, {
      method: 'POST',
      headers: clientHeaders,
      body: messagesBody(true),
    });
    const reader = response.body?.getReader();
    const first = await reader?.read();
    expect(Buffer.from(first?.value ?? new Uint8Array()).toString('utf8')).toContain(
      'message_start',
    );
    release();
    let rest = '';
    for (;;) {
      const next = await reader?.read();
      if (next === undefined || next.done) break;
      rest += Buffer.from(next.value).toString('utf8');
    }
    expect(rest).toContain('message_stop');
  });

  it('aborts the upstream request promptly when the client disconnects mid-stream', async () => {
    const h = await setup();
    h.mock.handle((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(sseEvent('message_start', { type: 'message_start' }));
      // Never ends: only a client abort can close it.
    });

    await new Promise<void>((resolve, reject) => {
      const req = httpRequest(
        `${h.url}/v1/messages`,
        { method: 'POST', headers: clientHeaders },
        (res) => {
          res.once('data', () => {
            req.destroy();
            resolve();
          });
        },
      );
      req.on('error', () => undefined);
      req.once('error', reject);
      req.end(messagesBody(true));
    });

    const upstream = h.mock.requests[0];
    expect(upstream).toBeDefined();
    await Promise.race([
      upstream?.closedPromise,
      new Promise((_, reject) =>
        setTimeout(() => {
          reject(new Error('upstream socket leaked'));
        }, 2_000),
      ),
    ]);
    expect(upstream?.closed).toBe(true);
    await waitFor(async () => (await metricValue(h.metrics, 'bw_gw_upstream_inflight')) === 0);
    await waitFor(
      async () =>
        (await metricValue(h.metrics, 'bw_gw_requests_total', { status: 'client_closed' })) === 1,
    );
  });

  it('aborts the stream when the upstream goes silent longer than the timeout', async () => {
    const h = await setup({ timeoutMs: 150 });
    h.mock.handle((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(sseEvent('message_start', { type: 'message_start' }));
    });
    const response = await fetch(`${h.url}/v1/messages`, {
      method: 'POST',
      headers: clientHeaders,
      body: messagesBody(true),
    });
    await expect(response.text()).rejects.toThrow();
    await h.mock.requests[0]?.closedPromise;
    await waitFor(
      async () => (await metricValue(h.metrics, 'bw_gw_requests_total', { status: '504' })) === 1,
    );
    expect(await metricValue(h.metrics, 'bw_gw_upstream_inflight')).toBe(0);
  });
});

describe('POST /v1/messages non-stream', () => {
  it('returns a well-formed Messages response and forwards the request faithfully', async () => {
    const h = await setup();
    const message = {
      id: 'msg_2',
      type: 'message',
      role: 'assistant',
      model: 'claude-test',
      content: [{ type: 'text', text: 'hi' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 3, output_tokens: 1 },
    };
    h.mock.handle((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'cf=1' });
      response.end(JSON.stringify(message));
    });

    const body = messagesBody(false);
    const response = await fetch(`${h.url}/v1/messages?beta=true`, {
      method: 'POST',
      headers: { ...clientHeaders, 'anthropic-beta': 'tools-2024', cookie: 'session=abc' },
      body,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(message);
    expect(response.headers.get('set-cookie')).toBeNull();

    const upstream = h.mock.requests[0];
    expect(upstream?.url).toBe('/v1/messages?beta=true');
    expect(upstream?.body).toBe(body);
    expect(upstream?.headers['anthropic-version']).toBe('2023-06-01');
    expect(upstream?.headers['anthropic-beta']).toBe('tools-2024');
    expect(upstream?.headers['content-type']).toBe('application/json');
    // The sandbox's session key never leaves the gateway; the provider key is injected instead.
    expect(upstream?.headers['x-api-key']).toBe(PROVIDER_KEY);
    expect(upstream?.headers.authorization).toBeUndefined();
    expect(upstream?.headers.cookie).toBeUndefined();
  });

  it.each([429, 500, 529])(
    'passes upstream status %i and body through unchanged',
    async (status) => {
      const h = await setup();
      const errorBody = JSON.stringify({
        type: 'error',
        error: { type: 'rate_limit_error', message: 'slow down' },
      });
      h.mock.handle((_request, response) => {
        response.writeHead(status, { 'content-type': 'application/json', 'retry-after': '7' });
        response.end(errorBody);
      });
      const response = await fetch(`${h.url}/v1/messages`, {
        method: 'POST',
        headers: clientHeaders,
        body: messagesBody(false),
      });
      expect(response.status).toBe(status);
      expect(response.headers.get('retry-after')).toBe('7');
      expect(await response.text()).toBe(errorBody);
      expect(h.mock.requests).toHaveLength(1);
    },
  );

  it('defaults a missing anthropic-version to the pinned version and logs a warning', async () => {
    const h = await setup();
    h.mock.handle((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{}');
    });
    const headers: Record<string, string> = { ...clientHeaders };
    delete headers['anthropic-version'];
    const response = await fetch(`${h.url}/v1/messages`, {
      method: 'POST',
      headers,
      body: messagesBody(false),
    });
    expect(response.status).toBe(200);
    expect(h.mock.requests[0]?.headers['anthropic-version']).toBe(DEFAULT_ANTHROPIC_VERSION);
    const warning = h.logs
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((entry) => entry.msg === 'gw.anthropic_version_defaulted');
    expect(warning).toMatchObject({ level: 'warn', route: '/v1/messages' });
    expect(typeof warning?.traceId).toBe('string');
  });
});

describe('request guards (Anthropic-shaped errors)', () => {
  async function expectAnthropicError(
    response: Response,
    status: number,
    type: string,
  ): Promise<void> {
    expect(response.status).toBe(status);
    const body = anthropicErrorBodySchema.parse(await response.json());
    expect(body.error.type).toBe(type);
  }

  it('rejects a body larger than GATEWAY_MAX_BODY_BYTES with request_too_large', async () => {
    const h = await setup({ maxBodyBytes: 256 });
    const response = await fetch(`${h.url}/v1/messages`, {
      method: 'POST',
      headers: clientHeaders,
      body: JSON.stringify({
        model: 'm',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'x'.repeat(1_000) }],
      }),
    });
    await expectAnthropicError(response, 413, 'request_too_large');
    expect(h.mock.requests).toHaveLength(0);
    expect(await metricValue(h.metrics, 'bw_gw_requests_total', { status: '413' })).toBe(1);
  });

  it('rejects malformed JSON with a 400 invalid_request_error', async () => {
    const h = await setup();
    const response = await fetch(`${h.url}/v1/messages`, {
      method: 'POST',
      headers: clientHeaders,
      body: `{"model": "m", ${SECRET_PROMPT}`,
    });
    await expectAnthropicError(response, 400, 'invalid_request_error');
    expect(h.mock.requests).toHaveLength(0);
  });

  it('rejects a request that is not a Messages request', async () => {
    const h = await setup();
    const response = await fetch(`${h.url}/v1/messages`, {
      method: 'POST',
      headers: clientHeaders,
      body: JSON.stringify({ model: 'm', messages: [] }),
    });
    await expectAnthropicError(response, 400, 'invalid_request_error');
    expect(h.mock.requests).toHaveLength(0);
  });

  it('rejects a non-JSON content type', async () => {
    const h = await setup();
    const response = await fetch(`${h.url}/v1/messages`, {
      method: 'POST',
      headers: { ...clientHeaders, 'content-type': 'text/plain' },
      body: 'hello',
    });
    await expectAnthropicError(response, 415, 'invalid_request_error');
    expect(h.mock.requests).toHaveLength(0);
  });

  it('answers unknown routes with not_found_error', async () => {
    const h = await setup();
    await expectAnthropicError(await fetch(`${h.url}/v1/nope`), 404, 'not_found_error');
    expect(h.mock.requests).toHaveLength(0);
  });

  it('maps an upstream that never answers to 504 timeout_error', async () => {
    const h = await setup({ timeoutMs: 100 });
    h.mock.handle(() => undefined);
    const response = await fetch(`${h.url}/v1/messages`, {
      method: 'POST',
      headers: clientHeaders,
      body: messagesBody(false),
    });
    await expectAnthropicError(response, 504, 'timeout_error');
    await h.mock.requests[0]?.closedPromise;
    expect(await metricValue(h.metrics, 'bw_gw_upstream_inflight')).toBe(0);
  });

  it('gw.anthropic.noSubscription: answers a subscription-style credential with 403 and never calls upstream', async () => {
    const h = await setup({
      adapter: new AnthropicAdapter({
        baseUrl: 'http://127.0.0.1:1',
        resolveCredential: () =>
          Promise.resolve({ kind: 'subscription_session', token: 'session-secret-value' }),
      }),
    });
    const response = await fetch(`${h.url}/v1/messages`, {
      method: 'POST',
      headers: clientHeaders,
      body: messagesBody(false),
    });
    const text = await response.text();
    expect(response.status).toBe(403);
    expect(JSON.parse(text)).toMatchObject({ error: { type: 'permission_error' } });
    expect(text).toContain('PROVIDER_CRED_UNSUPPORTED');
    expect(text).not.toContain('session-secret-value');
    expect(await metricValue(h.metrics, 'bw_gw_upstream_inflight')).toBe(0);
  });

  it('maps an unreachable upstream to 502 api_error', async () => {
    const h = await setup({
      adapter: new AnthropicAdapter({
        baseUrl: 'http://127.0.0.1:1',
        resolveCredential: staticApiKeyResolver(PROVIDER_KEY),
      }),
    });
    const response = await fetch(`${h.url}/v1/messages`, {
      method: 'POST',
      headers: clientHeaders,
      body: messagesBody(false),
    });
    await expectAnthropicError(response, 502, 'api_error');
    expect(await metricValue(h.metrics, 'bw_gw_upstream_inflight')).toBe(0);
  });
});

describe('health, readiness, metrics, traces and logs', () => {
  it('serves /healthz and /readyz, and /readyz fails when the adapter is not ready', async () => {
    const h = await setup();
    expect(await (await fetch(`${h.url}/healthz`)).json()).toEqual({ status: 'ok' });
    const ready = await fetch(`${h.url}/readyz`);
    expect(ready.status).toBe(200);

    const notReady = await setup({
      adapter: {
        name: 'anthropic',
        ready: () => false,
        healthCheck: () => Promise.resolve({ healthy: false, reachable: false }),
        resolveModelId: (model) => model,
        send: () => Promise.reject(new Error('unused')),
      },
    });
    expect((await fetch(`${notReady.url}/readyz`)).status).toBe(503);
    expect((await fetch(`${notReady.url}/healthz`)).status).toBe(200);
  });

  it('exposes request counters, durations and the inflight gauge on /metrics', async () => {
    const h = await setup();
    h.mock.handle((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{}');
    });
    await fetch(`${h.url}/v1/messages`, {
      method: 'POST',
      headers: clientHeaders,
      body: messagesBody(false),
    });
    await waitFor(
      async () => (await metricValue(h.metrics, 'bw_gw_requests_total', { status: '200' })) >= 1,
    );
    const response = await fetch(`${h.url}/metrics`);
    expect(response.headers.get('content-type')).toContain('text/plain');
    const text = await response.text();
    expect(text).toContain('bw_gw_requests_total{route="/v1/messages",status="200"} 1');
    expect(text).toContain('bw_gw_request_duration_ms_count{route="/v1/messages",status="200"} 1');
    expect(text).toContain('bw_gw_upstream_inflight 0');
  });

  it('records a gw.messages span that continues the caller trace and propagates it upstream', async () => {
    const h = await setup();
    h.mock.handle((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{}');
    });
    const traceId = '4bf92f3577b34da6a3ce929d0e0e4736';
    await fetch(`${h.url}/v1/messages`, {
      method: 'POST',
      headers: { ...clientHeaders, traceparent: `00-${traceId}-00f067aa0ba902b7-01` },
      body: messagesBody(false),
    });
    await waitFor(() => h.spans.getFinishedSpans().length === 1);
    const span = h.spans.getFinishedSpans()[0];
    expect(span?.name).toBe('gw.messages');
    expect(span?.spanContext().traceId).toBe(traceId);
    expect(span?.attributes['http.response.status_code']).toBe(200);
    expect(h.mock.requests[0]?.headers.traceparent).toMatch(
      new RegExp(`^00-${traceId}-[0-9a-f]{16}-01$`),
    );

    const line = h.logs
      .map((entry) => JSON.parse(entry) as Record<string, unknown>)
      .find((entry) => entry.msg === 'gw.request');
    expect(line).toMatchObject({ traceId, route: '/v1/messages', status: 200 });
    expect(typeof line?.durationMs).toBe('number');
  });

  it('never logs request or response bodies, or credentials', async () => {
    const h = await setup();
    h.mock.handle(async (_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      await writeInSlices(response, sampleStream());
    });
    await (
      await fetch(`${h.url}/v1/messages`, {
        method: 'POST',
        headers: clientHeaders,
        body: messagesBody(true),
      })
    ).text();
    await fetch(`${h.url}/v1/messages`, {
      method: 'POST',
      headers: clientHeaders,
      body: `{${SECRET_PROMPT}`,
    });
    await waitFor(() => h.logs.some((entry) => entry.includes('gw.request')));
    const all = h.logs.join('\n');
    expect(all).not.toContain(SECRET_PROMPT);
    expect(all).not.toContain('wörld');
    expect(all).not.toContain(PROVIDER_KEY);
    expect(all).not.toContain('bw_vk_sandbox_session_key');
  });
});
