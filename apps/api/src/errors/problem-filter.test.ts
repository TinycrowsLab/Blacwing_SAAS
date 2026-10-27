import {
  Controller,
  ForbiddenException,
  Get,
  HttpException,
  Module,
  NotFoundException,
  Post,
  Res,
} from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type Problem, problemSchema } from '@blackwing/contracts';
import {
  AuthError,
  ConflictError,
  ForbiddenError,
  InternalError,
  NotFoundError,
  PreconditionFailedError,
  RateLimitedError,
  TenantContextMissingError,
  ValidationError,
} from '@blackwing/errors';
import { createLogger, registerSecretPattern } from '@blackwing/logger';

import { createApiApp } from '../bootstrap/create-app.js';
import { loadApiConfig } from '../config.js';
import { ApiProblemError, FieldValidationError } from './problem-errors.js';
import { problemRegistry } from './registry.js';

import type { SecurityErrorEvent } from './problem-filter.js';
import type { HttpMetrics } from '../bootstrap/metrics.js';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { FastifyReply } from 'fastify';

const SECRET = 'zq9-sekrit-token-value';
const events: SecurityErrorEvent[] = [];

registerSecretPattern('api004_test_secret', /zq9-sekrit-token-value/g);
problemRegistry.register('run_locked', { status: 423, title: 'Run locked' });

@Controller('boom')
class BoomController {
  @Get('validation')
  validation(): never {
    throw new FieldValidationError('invalid', {
      detail: 'The request body is invalid.',
      errors: [
        { path: 'name', message: 'Required', code: 'invalid_type' },
        { path: 'token', message: `bad value ${SECRET}`, code: 'custom' },
      ],
    });
  }
  @Get('validation-plain')
  validationPlain(): never {
    throw new ValidationError('plain');
  }
  @Get('unauthenticated')
  unauthenticated(): never {
    throw new AuthError();
  }
  @Get('forbidden')
  forbidden(): never {
    throw new ForbiddenError();
  }
  @Get('not-found')
  notFound(): never {
    throw new NotFoundError();
  }
  @Get('conflict')
  conflict(): never {
    throw new ConflictError();
  }
  @Get('precondition-failed')
  preconditionFailed(): never {
    throw new PreconditionFailedError();
  }
  @Get('precondition-required')
  preconditionRequired(): never {
    throw new ApiProblemError('precondition_required');
  }
  @Get('rate-limited')
  rateLimited(): never {
    throw new RateLimitedError(undefined, { retryAfterSeconds: 7 });
  }
  @Get('rate-limited-unknown')
  rateLimitedUnknown(): never {
    throw new RateLimitedError();
  }
  @Get('idempotency')
  idempotency(): never {
    throw new ApiProblemError('idempotency_conflict');
  }
  @Get('module-code')
  moduleCode(): never {
    throw new ApiProblemError('run_locked', 'locked', { detail: 'Run is locked.' });
  }
  @Get('unregistered-code')
  unregisteredCode(): never {
    throw new ApiProblemError('never_registered', 'x', { detail: 'internal' });
  }
  @Get('tenant')
  tenant(): never {
    throw new TenantContextMissingError();
  }
  @Get('internal-app')
  internalApp(): never {
    throw new InternalError('db down', { detail: 'connection refused to 10.0.0.5' });
  }
  @Get('uncaught')
  uncaught(): never {
    throw new Error(`SELECT * FROM users WHERE token='${SECRET}' failed`);
  }
  @Get('http-exception')
  httpException(): never {
    throw new HttpException('teapot internals', 418);
  }
  @Get('nest-forbidden')
  nestForbidden(): never {
    throw new ForbiddenException('only admins of tenant 42');
  }
  @Get('nest-not-found')
  nestNotFound(): never {
    throw new NotFoundException();
  }
  @Get('huge')
  huge(): never {
    throw new ConflictError('x', { detail: 'a'.repeat(50_000) });
  }
  @Get('secret-detail')
  secretDetail(): never {
    throw new ConflictError('x', { detail: `already used ${SECRET}` });
  }
  @Get('stack-detail')
  stackDetail(): never {
    throw new ConflictError('x', { detail: 'oops\n    at fn (/srv/app/file.js:10:5)' });
  }
  @Get('circular')
  circular(): never {
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    const error = new Error('circular', { cause: loop });
    Object.assign(error, { context: loop });
    throw error;
  }
  @Post('echo')
  echo(): { readonly ok: true } {
    return { ok: true };
  }
  @Get('sse')
  sse(@Res() reply: FastifyReply): void {
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream' });
    reply.raw.write('data: one\n\n');
    throw new Error('after headers sent');
  }
}

@Module({ controllers: [BoomController] })
class BoomModule {}

interface Harness {
  readonly app: NestFastifyApplication;
  readonly metrics: HttpMetrics;
  readonly lines: string[];
}

async function harness(env: Record<string, string>): Promise<Harness> {
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
  const config = loadApiConfig({
    NODE_ENV: 'test',
    WEB_ORIGIN: 'http://localhost:3000',
    API_BODY_LIMIT_BYTES: '256',
    // These cases fire many requests from one test IP; rate limiting has its own suite (rate-limit.http.test.ts).
    RATE_LIMIT_BURST: '999999',
    ...env,
  });
  const { app, metrics } = await createApiApp({
    config,
    logger,
    imports: [BoomModule],
    securityEventSink: (event) => void events.push(event),
  });
  await app.getHttpAdapter().getInstance().ready();
  return { app, metrics, lines };
}

async function get(h: Harness, path: string) {
  const response = await h.app.inject({ method: 'GET', url: `/v1/boom/${path}` });
  return { response, body: JSON.parse(response.body) as Problem };
}

function logRecord(h: Harness): Record<string, unknown> | undefined {
  return h.lines
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .find((record) => record.msg === 'http.error');
}

describe('ProblemJsonExceptionFilter (test environment)', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await harness({});
  });
  afterAll(async () => {
    await h.app.close();
  });

  it.each([
    ['validation-plain', 422, 'validation_failed'],
    ['unauthenticated', 401, 'unauthenticated'],
    ['forbidden', 403, 'permission_denied'],
    ['not-found', 404, 'not_found'],
    ['conflict', 409, 'conflict'],
    ['precondition-failed', 412, 'precondition_failed'],
    ['precondition-required', 428, 'precondition_required'],
    ['rate-limited', 429, 'rate_limited'],
    ['idempotency', 409, 'idempotency_conflict'],
    ['tenant', 403, 'tenant_context_missing'],
    ['uncaught', 500, 'internal_error'],
    ['module-code', 423, 'run_locked'],
  ])('GET %s -> %i %s as problem+json with a traceId', async (path, status, code) => {
    const { response, body } = await get(h, path);
    expect(response.statusCode).toBe(status);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(problemSchema.safeParse(body).success).toBe(true);
    expect(body.status).toBe(status);
    expect(body.code).toBe(code);
    expect(body.type).toBe(`https://errors.blackwing.dev/${code}`);
    expect(body.traceId).toBe(response.headers['x-request-id']);
  });

  it('renders a ValidationError with errors[] and redacts secrets inside them', async () => {
    const { response, body } = await get(h, 'validation');
    expect(response.statusCode).toBe(422);
    expect(body.errors).toHaveLength(2);
    expect(body.errors?.[0]).toEqual({ path: 'name', message: 'Required', code: 'invalid_type' });
    expect(response.body).not.toContain(SECRET);
    expect(body.traceId.length).toBeGreaterThan(0);
  });

  it('renders an uncaught Error as 500 internal_error without stack, message or detail', async () => {
    const { response, body } = await get(h, 'uncaught');
    expect(response.statusCode).toBe(500);
    expect(body.code).toBe('internal_error');
    expect(body.detail).toBeUndefined();
    expect(response.body).not.toMatch(/SELECT|users|\.ts:|\.js:/);
    expect(response.body).not.toContain(SECRET);
  });

  it('logs an unknown error at error level with the traceId, redacted', async () => {
    h.lines.length = 0;
    const { body } = await get(h, 'uncaught');
    const logged = logRecord(h);
    expect(logged).toBeDefined();
    expect(logged?.level).toBe('error');
    expect(logged?.traceId).toBe(body.traceId);
    expect(logged?.code).toBe('internal_error');
    expect(JSON.stringify(logged)).not.toContain(SECRET);
  });

  it('logs 4xx at warn', async () => {
    h.lines.length = 0;
    await get(h, 'not-found');
    expect(logRecord(h)?.level).toBe('warn');
  });

  it('sends Retry-After on 429 when the thrower provides it, and not otherwise', async () => {
    expect((await get(h, 'rate-limited')).response.headers['retry-after']).toBe('7');
    expect((await get(h, 'rate-limited-unknown')).response.headers['retry-after']).toBeUndefined();
  });

  it('maps HttpException and framework errors without leaking their messages', async () => {
    const teapot = await get(h, 'http-exception');
    expect(teapot.response.statusCode).toBe(400);
    expect(teapot.body.code).toBe('bad_request');
    expect(teapot.response.body).not.toContain('teapot');
    const forbidden = await get(h, 'nest-forbidden');
    expect(forbidden.body.code).toBe('permission_denied');
    expect(forbidden.body.detail).toBeUndefined();
    expect((await get(h, 'nest-not-found')).body.code).toBe('not_found');
  });

  it('renders unknown routes, bad JSON and oversized bodies as problem+json', async () => {
    const missing = await h.app.inject({ method: 'GET', url: '/v1/nope' });
    expect(missing.statusCode).toBe(404);
    expect(missing.headers['content-type']).toContain('application/problem+json');
    expect((JSON.parse(missing.body) as Problem).code).toBe('not_found');

    const badJson = await h.app.inject({
      method: 'POST',
      url: '/v1/boom/echo',
      headers: { 'content-type': 'application/json' },
      payload: '{not json',
    });
    expect(badJson.statusCode).toBe(400);
    expect(badJson.headers['content-type']).toContain('application/problem+json');
    expect((JSON.parse(badJson.body) as Problem).code).toBe('bad_request');

    const big = await h.app.inject({
      method: 'POST',
      url: '/v1/boom/echo',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ a: 'x'.repeat(1000) }),
    });
    expect(big.statusCode).toBe(413);
    expect(big.headers['content-type']).toContain('application/problem+json');
    expect((JSON.parse(big.body) as Problem).code).toBe('payload_too_large');
  });

  it('falls back to internal_error for an unregistered ApiProblemError code', async () => {
    const { body } = await get(h, 'unregistered-code');
    expect(body.code).toBe('internal_error');
    expect(body.detail).toBeUndefined();
  });

  it('truncates a huge detail, redacts secrets in detail and drops stack-like detail', async () => {
    const huge = await get(h, 'huge');
    expect((huge.body.detail ?? '').length).toBeLessThanOrEqual(1024);
    const secret = await get(h, 'secret-detail');
    expect(secret.response.body).not.toContain(SECRET);
    const stack = await get(h, 'stack-detail');
    expect(stack.body.detail).toBeUndefined();
  });

  it('serialises circular error objects safely', async () => {
    const { response, body } = await get(h, 'circular');
    expect(response.statusCode).toBe(500);
    expect(body.code).toBe('internal_error');
  });

  it('counts http_errors_total{code,status}', async () => {
    await get(h, 'conflict');
    const text = await h.metrics.registry.metrics();
    expect(text).toMatch(/http_errors_total\{code="conflict",status="409"\} \d+/);
  });

  it('emits a security event for permission_denied and tenant_context_missing only', async () => {
    events.length = 0;
    await get(h, 'forbidden');
    await get(h, 'tenant');
    await get(h, 'not-found');
    expect(events.map((e) => e.code)).toEqual(['permission_denied', 'tenant_context_missing']);
    expect(events[0]?.status).toBe(403);
  });

  it('does not double-send when the error happens after headers were sent (SSE)', async () => {
    const response = await h.app.inject({ method: 'GET', url: '/v1/boom/sse' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('text/event-stream');
    expect(response.body).toBe('data: one\n\n');
  });
});

describe('ProblemJsonExceptionFilter (production environment)', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await harness({ NODE_ENV: 'production' });
  });
  afterAll(async () => {
    await h.app.close();
  });

  it('withholds detail of 5xx AppErrors and keeps 4xx detail redacted', async () => {
    const internal = await get(h, 'internal-app');
    expect(internal.response.statusCode).toBe(500);
    expect(internal.body.detail).toBeUndefined();
    expect(internal.response.body).not.toContain('10.0.0.5');
    const conflict = await get(h, 'secret-detail');
    expect(conflict.response.body).not.toContain(SECRET);
    expect(conflict.body.detail).toContain('already used');
  });

  it('answers permission_denied and unauthenticated uniformly (no user-enumeration detail)', async () => {
    const forbidden = await get(h, 'forbidden');
    const unauth = await get(h, 'unauthenticated');
    expect(forbidden.body.detail).toBeUndefined();
    expect(unauth.body.detail).toBeUndefined();
  });
});
