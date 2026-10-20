// GATEWAY-003 (#406): AnthropicAdapter against a local mock Anthropic upstream (no network egress).
import { afterEach, describe, expect, it } from 'vitest';

import { createGatewayMetrics } from '../metrics.js';
import { AnthropicAdapter, type ProviderCallAuditEvent } from './anthropic.js';
import { type ProviderCredential, staticApiKeyResolver } from './credentials.js';
import { ProviderError } from './errors.js';
import {
  sampleStream,
  sseEvent,
  startMockAnthropic,
  type MockAnthropic,
} from '../testing/mock-anthropic.js';

import type { ProviderRequest, ProviderResponse } from '../provider.js';

const KEY = 'sk-ant-api03-test-key-0123456789';
const MODEL = 'claude-opus-4-1';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function mockUpstream(): Promise<MockAnthropic> {
  const mock = await startMockAnthropic();
  cleanups.push(() => mock.close());
  return mock;
}

function request(overrides: { model?: string; stream?: boolean } = {}): ProviderRequest {
  const model = overrides.model ?? MODEL;
  const body = JSON.stringify({
    model,
    max_tokens: 16,
    stream: overrides.stream === true,
    messages: [{ role: 'user', content: 'hi' }],
  });
  return {
    pathAndQuery: '/v1/messages',
    headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
    body: new TextEncoder().encode(body),
    model,
  };
}

async function read(response: ProviderResponse): Promise<string> {
  const decoder = new TextDecoder();
  let text = '';
  if (response.body !== null) {
    for await (const chunk of response.body) text += decoder.decode(chunk, { stream: true });
  }
  return text;
}

function adapterFor(
  mock: MockAnthropic,
  extra: Partial<ConstructorParameters<typeof AnthropicAdapter>[0]> = {},
): AnthropicAdapter {
  return new AnthropicAdapter({
    baseUrl: mock.url,
    resolveCredential: staticApiKeyResolver(KEY),
    ...extra,
  });
}

const signal = (): AbortSignal => new AbortController().signal;

function ok(mock: MockAnthropic): void {
  mock.handle((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
  });
}

describe('AnthropicAdapter round trip', () => {
  it('returns a non-stream response with identical content and injects the tenant key', async () => {
    const mock = await mockUpstream();
    const payload = JSON.stringify({ id: 'msg_1', type: 'message', content: [{ text: 'ok ✓' }] });
    mock.handle((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' }).end(payload);
    });
    const response = await adapterFor(mock).send(request(), { signal: signal() });
    expect(response.status).toBe(200);
    expect(await read(response)).toBe(payload);
    expect(mock.requests[0]?.headers['x-api-key']).toBe(KEY);
    expect(mock.requests[0]?.url).toBe('/v1/messages');
  });

  it('streams SSE events byte-identically and incrementally', async () => {
    const mock = await mockUpstream();
    const first = sseEvent('message_start', { type: 'message_start' });
    mock.handle(async (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(first);
      await new Promise((resolve) => setTimeout(resolve, 150));
      res.end(sampleStream());
    });
    const response = await adapterFor(mock).send(request({ stream: true }), { signal: signal() });
    if (response.body === null) throw new Error('expected a body');
    const iterator = response.body[Symbol.asyncIterator]();
    const head = await iterator.next();
    // The first event arrives before the upstream finished: nothing is buffered.
    expect(mock.requests[0]?.closed).toBe(false);
    let text = new TextDecoder().decode(head.value as Uint8Array);
    for (let step = await iterator.next(); step.done !== true; step = await iterator.next()) {
      text += new TextDecoder().decode(step.value);
    }
    expect(text).toBe(first + sampleStream());
  });

  it('forwards the query string', async () => {
    const mock = await mockUpstream();
    ok(mock);
    await adapterFor(mock).send(
      { ...request(), pathAndQuery: '/v1/messages?beta=true' },
      { signal: signal() },
    );
    expect(mock.requests[0]?.url).toBe('/v1/messages?beta=true');
  });
});

describe('model ids', () => {
  it('passes exact model ids through unchanged, with the body forwarded verbatim', async () => {
    const mock = await mockUpstream();
    ok(mock);
    const req = request({ model: 'claude-sonnet-4-5-20250929' });
    const adapter = adapterFor(mock);
    await adapter.send(req, { signal: signal() });
    expect(mock.requests[0]?.body).toBe(new TextDecoder().decode(req.body));
    expect(adapter.resolveModelId('claude-opus-4-1')).toBe('claude-opus-4-1');
    expect(adapter.resolveModelId('claude-sonnet-4-5')).toBe('claude-sonnet-4-5');
  });

  it('resolves only configured aliases and rewrites the model for them', async () => {
    const mock = await mockUpstream();
    ok(mock);
    const adapter = adapterFor(mock, { aliases: { smart: 'claude-opus-4-1' } });
    expect(adapter.resolveModelId('smart')).toBe('claude-opus-4-1');
    expect(adapter.resolveModelId('constructor')).toBe('constructor');
    await adapter.send(request({ model: 'smart' }), { signal: signal() });
    expect(JSON.parse(mock.requests[0]?.body ?? '{}')).toMatchObject({ model: 'claude-opus-4-1' });
  });

  it('passes an unknown model id upstream unchanged, and the upstream decides', async () => {
    const mock = await mockUpstream();
    mock.handle((_req, res) => {
      res
        .writeHead(404, { 'content-type': 'application/json' })
        .end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'm' } }));
    });
    const response = await adapterFor(mock).send(request({ model: 'mystery-model' }), {
      signal: signal(),
    });
    expect(response.status).toBe(404);
    expect(JSON.parse(mock.requests[0]?.body ?? '{}')).toMatchObject({ model: 'mystery-model' });
  });
});

describe('credential guard', () => {
  async function rejection(credential: ProviderCredential): Promise<ProviderError> {
    const mock = await mockUpstream();
    const adapter = adapterFor(mock, { resolveCredential: () => Promise.resolve(credential) });
    const error = await adapter.send(request(), { signal: signal() }).catch((e: unknown) => e);
    expect(mock.requests).toHaveLength(0);
    expect(error).toBeInstanceOf(ProviderError);
    return error as ProviderError;
  }

  it('gw.anthropic.noSubscription: rejects subscription-style credentials', async () => {
    const session = await rejection({
      kind: 'subscription_session',
      token: 'secret-session-token',
    });
    expect(session.code).toBe('PROVIDER_CRED_UNSUPPORTED');
    expect(session.message).not.toContain('secret-session-token');

    const oauth = await rejection({ kind: 'api_key', apiKey: 'sk-ant-oat01-abcdefghijklmnop' });
    expect(oauth.code).toBe('PROVIDER_CRED_UNSUPPORTED');
    expect(oauth.message).not.toContain('abcdefghijklmnop');

    const bearer = await rejection({ kind: 'api_key', apiKey: 'Bearer abcdefghijklmnop' });
    expect(bearer.code).toBe('PROVIDER_CRED_UNSUPPORTED');
  });

  it('fails with PROVIDER_CRED_MISSING when no credential is configured', async () => {
    const missing = await rejection({ kind: 'api_key', apiKey: '' });
    expect(missing.code).toBe('PROVIDER_CRED_MISSING');
  });

  it('passes the tenant id to the credential resolver', async () => {
    const mock = await mockUpstream();
    ok(mock);
    const seen: (string | undefined)[] = [];
    const adapter = adapterFor(mock, {
      resolveCredential: (tenantId) => {
        seen.push(tenantId);
        return Promise.resolve({ kind: 'api_key', apiKey: KEY });
      },
    });
    await adapter.send(request(), { signal: signal(), tenantId: 'tnt_1' });
    expect(seen).toEqual(['tnt_1']);
  });
});

describe('error normalisation', () => {
  it('surfaces 429 with retry-after and the Anthropic error body', async () => {
    const mock = await mockUpstream();
    const body = { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } };
    mock.handle((_req, res) => {
      res
        .writeHead(429, { 'content-type': 'application/json', 'retry-after': '7' })
        .end(JSON.stringify(body));
    });
    const response = await adapterFor(mock).send(request(), { signal: signal() });
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('7');
    expect(JSON.parse(await read(response))).toEqual(body);
  });

  it('maps an upstream 401 to PROVIDER_AUTH_FAILED without leaking the key', async () => {
    const mock = await mockUpstream();
    mock.handle((_req, res) => {
      res.writeHead(401, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          type: 'error',
          error: { type: 'authentication_error', message: `invalid x-api-key ${KEY}` },
        }),
      );
    });
    const response = await adapterFor(mock).send(request(), { signal: signal() });
    const text = await read(response);
    expect(response.status).toBe(502);
    expect(text).toContain('PROVIDER_AUTH_FAILED');
    expect(text).not.toContain(KEY);
  });

  it('wraps a non-JSON upstream error body into the Anthropic error shape', async () => {
    const mock = await mockUpstream();
    mock.handle((_req, res) => {
      res.writeHead(503, { 'content-type': 'text/html' }).end('<html>down</html>');
    });
    const response = await adapterFor(mock).send(request(), { signal: signal() });
    expect(response.status).toBe(503);
    expect(JSON.parse(await read(response))).toMatchObject({
      type: 'error',
      error: { type: 'api_error' },
    });
  });

  it('maps a network timeout to the retryable PROVIDER_TIMEOUT', async () => {
    const mock = await mockUpstream();
    mock.handle(() => undefined);
    const adapter = adapterFor(mock, { requestTimeoutMs: 50 });
    const error = await adapter.send(request(), { signal: signal() }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ code: 'PROVIDER_TIMEOUT', httpStatus: 504, retryable: true });
  });

  it('rethrows the abort when the caller cancels and closes the upstream request', async () => {
    const mock = await mockUpstream();
    mock.handle(() => undefined);
    const controller = new AbortController();
    const pending = adapterFor(mock).send(request(), { signal: controller.signal });
    setTimeout(() => {
      controller.abort();
    }, 50);
    await expect(pending).rejects.toThrow();
    await mock.requests[0]?.closedPromise;
  });

  it('ends a stream that fails midway with an Anthropic error event', async () => {
    const mock = await mockUpstream();
    mock.handle((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(sseEvent('message_start', { type: 'message_start' }));
      setTimeout(() => res.destroy(), 30);
    });
    const response = await adapterFor(mock).send(request({ stream: true }), { signal: signal() });
    const text = await read(response);
    expect(text).toContain('event: message_start');
    expect(text).toContain('event: error');
    expect(text).toContain('"type":"api_error"');
    expect(text.endsWith('\n\n')).toBe(true);
  });
});

describe('healthCheck', () => {
  it('reflects upstream reachability and credential acceptance', async () => {
    const mock = await mockUpstream();
    ok(mock);
    expect(await adapterFor(mock).healthCheck()).toEqual({ healthy: true, reachable: true });

    mock.handle((_req, res) => {
      res.writeHead(401).end('{}');
    });
    expect(await adapterFor(mock).healthCheck()).toMatchObject({ healthy: false, reachable: true });

    mock.handle((_req, res) => {
      res.writeHead(503).end('{}');
    });
    expect(await adapterFor(mock).healthCheck()).toMatchObject({ healthy: false, reachable: true });

    const down = new AnthropicAdapter({
      baseUrl: 'http://127.0.0.1:1',
      resolveCredential: staticApiKeyResolver(KEY),
    });
    expect(await down.healthCheck()).toEqual({
      healthy: false,
      reachable: false,
      detail: 'unreachable',
    });
  });

  it('is unhealthy when the credential is unusable, without calling upstream', async () => {
    const mock = await mockUpstream();
    const adapter = adapterFor(mock, { resolveCredential: staticApiKeyResolver(undefined) });
    expect(await adapter.healthCheck()).toMatchObject({ healthy: false, reachable: false });
    expect(mock.requests).toHaveLength(0);
  });
});

describe('observability', () => {
  it('records provider metrics and a coarse audit event without bodies or keys', async () => {
    const mock = await mockUpstream();
    ok(mock);
    const metrics = createGatewayMetrics();
    const events: ProviderCallAuditEvent[] = [];
    const adapter = adapterFor(mock, { metrics, audit: (event) => events.push(event) });
    await adapter.send(request(), { signal: signal(), tenantId: 'tnt_1' });
    const text = await metrics.registry.metrics();
    expect(text).toContain('bw_gw_provider_requests_total{provider="anthropic",status="200"} 1');
    expect(text).toContain('bw_gw_provider_latency_ms_count{provider="anthropic"} 1');
    expect(events).toEqual([
      { action: 'provider.call', provider: 'anthropic', outcome: 'success', tenantId: 'tnt_1' },
    ]);
    expect(JSON.stringify(events)).not.toContain(KEY);
  });
});
