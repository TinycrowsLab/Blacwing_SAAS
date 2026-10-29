import { Body, Controller, Get, Module, Post, Req, type RawBodyRequest } from '@nestjs/common';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { hashTenantId } from '@blackwing/db/tenant-context';
import { createLogger } from '@blackwing/logger';

import { loadApiConfig } from '../config.js';
import { createApiApp, GLOBAL_PREFIX_EXCLUDES } from './create-app.js';
import { bindTenant, requestLogger } from './request-context.js';

import type { HttpMetrics } from './metrics.js';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { FastifyRequest } from 'fastify';

const BODY_LIMIT = 256;
const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
const SECRET = 'hunter2-not-for-logs';

let echoCalls = 0;

@Controller('graphql')
class FakeGraphqlController {
  @Get()
  graphql(): { readonly graphql: true } {
    return { graphql: true };
  }
}

@Controller('internal/broker/runs')
class FakeBrokerController {
  @Get()
  runs(): { readonly broker: true } {
    return { broker: true };
  }
}

@Controller('probe')
class ProbeController {
  @Post('echo')
  echo(
    @Body() body: unknown,
    @Req() request: RawBodyRequest<FastifyRequest>,
  ): { readonly body: unknown; readonly rawBytes: number } {
    echoCalls += 1;
    return { body, rawBytes: request.rawBody?.length ?? 0 };
  }

  @Get('ip')
  ip(@Req() request: FastifyRequest): { readonly ip: string; readonly protocol: string } {
    return { ip: request.ip, protocol: request.protocol };
  }

  @Get('secret')
  secret(): { readonly logged: true } {
    requestLogger(createLogger('unused')).info({ password: SECRET }, 'probe.secret');
    return { logged: true };
  }

  @Get('tenant')
  tenant(): { readonly bound: true } {
    bindTenant('tnt_test');
    requestLogger(createLogger('unused')).info('probe.tenant');
    return { bound: true };
  }
}

@Module({
  controllers: [FakeGraphqlController, FakeBrokerController, ProbeController],
})
class ProbeModule {}

interface Harness {
  readonly app: NestFastifyApplication;
  readonly metrics: HttpMetrics;
  readonly lines: string[];
  readonly exporter: InMemorySpanExporter;
}

async function harness(env: Record<string, string> = {}): Promise<Harness> {
  const lines: string[] = [];
  const logger = createLogger('api', {
    level: 'info',
    nodeEnv: 'test',
    destination: {
      write(line: string): void {
        lines.push(line);
      },
    },
  });
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  const config = loadApiConfig({
    NODE_ENV: 'test',
    WEB_ORIGIN: 'http://localhost:3000',
    API_BODY_LIMIT_BYTES: String(BODY_LIMIT),
    ...env,
  });
  const { app, metrics } = await createApiApp({
    config,
    logger,
    tracer: provider.getTracer('test'),
    imports: [ProbeModule],
  });
  await app.getHttpAdapter().getInstance().ready();
  return { app, metrics, lines, exporter };
}

function records(lines: readonly string[]): Record<string, unknown>[] {
  return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
}

function accessLogs(lines: readonly string[]): Record<string, unknown>[] {
  return records(lines).filter((record) => record.msg === 'http.request');
}

describe('createApiApp', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await harness();
  });

  afterAll(async () => {
    await h.app.close();
  });

  it('serves the API docs at /v1/docs and counts the published operations', async () => {
    const page = await h.app.inject({ method: 'GET', url: '/v1/docs' });
    expect(page.statusCode).toBe(200);
    const spec = await h.app.inject({ method: 'GET', url: '/v1/docs/openapi.json' });
    expect(spec.json<{ openapi: string }>().openapi).toBe('3.1.0');
    expect(await h.metrics.registry.metrics()).toMatch(/openapi_operations_total 21/);
  });

  it('serves the smoke controller under /v1', async () => {
    const response = await h.app.inject({ method: 'GET', url: '/v1' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ service: 'api', status: 'ok' });
    expect((await h.app.inject({ method: 'GET', url: '/' })).statusCode).toBe(404);
  });

  it('excludes health, GraphQL and the internal broker from the /v1 prefix', async () => {
    expect(GLOBAL_PREFIX_EXCLUDES).toEqual(
      expect.arrayContaining(['health', 'health/live', 'health/ready', 'graphql']),
    );
    expect((await h.app.inject({ method: 'GET', url: '/health' })).json()).toMatchObject({
      status: 'ok',
    });
    expect((await h.app.inject({ method: 'GET', url: '/graphql' })).json()).toEqual({
      graphql: true,
    });
    expect((await h.app.inject({ method: 'GET', url: '/internal/broker/runs' })).statusCode).toBe(
      200,
    );
    for (const url of ['/v1/health', '/v1/graphql', '/v1/internal/broker/runs', '/probe/ip']) {
      expect((await h.app.inject({ method: 'GET', url })).statusCode, url).toBe(404);
    }
    expect((await h.app.inject({ method: 'GET', url: '/v1/probe/ip' })).statusCode).toBe(200);
  });

  it('writes single-line JSON access logs with traceId and the request fields', async () => {
    h.lines.length = 0;
    const response = await h.app.inject({
      method: 'GET',
      url: '/v1?token=should-not-be-logged',
      headers: { traceparent: `00-${TRACE}-00f067aa0ba902b7-01` },
    });
    expect(response.headers['x-request-id']).toBe(TRACE);
    for (const line of h.lines) {
      expect(line.endsWith('\n')).toBe(true);
      expect(line.trimEnd()).not.toContain('\n');
    }
    const [entry] = accessLogs(h.lines);
    expect(entry).toMatchObject({
      name: 'api',
      traceId: TRACE,
      method: 'GET',
      path: '/v1',
      route: '/v1',
      statusCode: 200,
    });
    expect(typeof entry?.durationMs).toBe('number');
    expect(entry).not.toHaveProperty('tenantId');
    expect(h.lines.join('')).not.toContain('should-not-be-logged');
  });

  it('generates a UUIDv7 trace id when the client sends none, and ignores unsafe request ids', async () => {
    h.lines.length = 0;
    const response = await h.app.inject({
      method: 'GET',
      url: '/v1',
      headers: { 'x-request-id': 'bad id\twith tabs' },
    });
    const traceId = response.headers['x-request-id'];
    expect(traceId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(accessLogs(h.lines)[0]?.traceId).toBe(traceId);
  });

  it('redacts secrets in request-scoped logs (logger redaction stays active)', async () => {
    h.lines.length = 0;
    await h.app.inject({ method: 'GET', url: '/v1/probe/secret' });
    const output = h.lines.join('');
    expect(output).not.toContain(SECRET);
    const entry = records(h.lines).find((record) => record.msg === 'probe.secret');
    expect(entry?.password).toBe('[REDACTED]');
    expect(entry?.traceId).toEqual(expect.any(String));
  });

  it('binds tenantId to the request logger and the access log once a tenant is set', async () => {
    h.lines.length = 0;
    await h.app.inject({ method: 'GET', url: '/v1/probe/tenant' });
    const all = records(h.lines);
    expect(all.find((record) => record.msg === 'probe.tenant')?.tenantId).toBe(
      hashTenantId('tnt_test'),
    );
    expect(accessLogs(h.lines)[0]?.tenantId).toBe(hashTenantId('tnt_test'));
    expect(JSON.stringify(all)).not.toContain('tnt_test');
  });

  it('accepts a body within the limit and keeps the raw body', async () => {
    const payload = JSON.stringify({ hello: 'world' });
    const response = await h.app.inject({
      method: 'POST',
      url: '/v1/probe/echo',
      headers: { 'content-type': 'application/json' },
      payload,
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({ body: { hello: 'world' }, rawBytes: payload.length });
  });

  it('rejects an oversized body with 413 before the handler runs', async () => {
    const before = echoCalls;
    const response = await h.app.inject({
      method: 'POST',
      url: '/v1/probe/echo',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ blob: 'x'.repeat(BODY_LIMIT * 2) }),
    });
    expect(response.statusCode).toBe(413);
    expect(echoCalls).toBe(before);
  });

  it('sets Helmet security headers', async () => {
    const response = await h.app.inject({ method: 'GET', url: '/v1' });
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(response.headers['strict-transport-security']).toEqual(expect.any(String));
  });

  it('allows CORS only for the configured web origin', async () => {
    const allowed = await h.app.inject({
      method: 'GET',
      url: '/v1',
      headers: { origin: 'http://localhost:3000' },
    });
    expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:3000');
    const denied = await h.app.inject({
      method: 'GET',
      url: '/v1',
      headers: { origin: 'https://evil.example.test' },
    });
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('trusts X-Forwarded-* by default (API_TRUST_PROXY=true)', async () => {
    const response = await h.app.inject({
      method: 'GET',
      url: '/v1/probe/ip',
      headers: { 'x-forwarded-for': '203.0.113.9', 'x-forwarded-proto': 'https' },
    });
    expect(response.json()).toEqual({ ip: '203.0.113.9', protocol: 'https' });
  });

  it('records request metrics by method, route template and status', async () => {
    await h.app.inject({ method: 'GET', url: '/v1' });
    await h.app.inject({ method: 'GET', url: '/v1/does-not-exist/123' });
    const text = await h.metrics.registry.metrics();
    expect(text).toMatch(
      /http_server_requests_total\{method="GET",route="\/v1",status="200"\} \d+/,
    );
    expect(text).toContain('route="unmatched",status="404"');
    expect(text).not.toContain('does-not-exist');
    expect(text).toContain('http_server_request_duration_seconds_bucket');
  });

  it('opens one server span per request, named after the route and continued from traceparent', async () => {
    h.exporter.reset();
    await h.app.inject({
      method: 'GET',
      url: '/v1',
      headers: { traceparent: `00-${TRACE}-00f067aa0ba902b7-01` },
    });
    const [span] = h.exporter.getFinishedSpans();
    expect(span?.name).toBe('HTTP GET /v1');
    expect(span?.spanContext().traceId).toBe(TRACE);
    expect(span?.parentSpanContext?.spanId).toBe('00f067aa0ba902b7');
    expect(span?.attributes['http.response.status_code']).toBe(200);
  });
});

describe('createApiApp with API_TRUST_PROXY=false', () => {
  it('ignores X-Forwarded-* headers', async () => {
    const h = await harness({ API_TRUST_PROXY: 'false' });
    try {
      const response = await h.app.inject({
        method: 'GET',
        url: '/v1/probe/ip',
        headers: { 'x-forwarded-for': '203.0.113.9', 'x-forwarded-proto': 'https' },
      });
      expect(response.json()).toEqual({ ip: '127.0.0.1', protocol: 'http' });
    } finally {
      await h.app.close();
    }
  });
});
