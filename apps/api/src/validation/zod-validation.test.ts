import { Body, Catch, Controller, Get, Module, Post, type ArgumentsHost } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createLogger } from '@blackwing/logger';

import { createApiApp } from '../bootstrap/create-app.js';
import { loadApiConfig } from '../config.js';
import { exceedsJsonDepth } from './json-depth.js';
import { RequestValidationError } from './request-validation.error.js';
import { serialize } from './serialize.js';
import { createZodDto } from './zod-dto.js';
import {
  formatIssuePath,
  ZodBody,
  ZodHeaders,
  ZodParam,
  ZodQuery,
  ZodValidationPipe,
} from './zod-validation.pipe.js';

import type { HttpMetrics } from '../bootstrap/metrics.js';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { FastifyReply } from 'fastify';

// In production these schemas come from @blackwing/contracts; tests define them next to the DTOs.
const MAX_NAME = 20;
const MAX_LIMIT = 100;
const createThing = z.object({
  name: z.string().min(1).max(MAX_NAME),
  note: z.string().optional(),
});
const listThings = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(25),
});
const thingParams = z.object({ id: z.string().regex(/^thg_[a-z0-9]+$/) });
const thingHeaders = z.object({ 'x-client': z.string().min(1) });

class CreateThingDto extends createZodDto(createThing) {}
class ListThingsDto extends createZodDto(listThings) {}
class ThingParamsDto extends createZodDto(thingParams) {}
class ThingHeadersDto extends createZodDto(thingHeaders) {}

@Controller('things')
class ThingsController {
  @Post()
  create(@ZodBody(CreateThingDto) body: CreateThingDto): unknown {
    return body;
  }

  @Get()
  list(@ZodQuery(ListThingsDto) query: ListThingsDto): unknown {
    return { limit: query.limit, type: typeof query.limit };
  }

  @Get(':id')
  one(@ZodParam(ThingParamsDto) params: ThingParamsDto): unknown {
    return params;
  }

  @Get('hdr/check')
  header(@ZodHeaders(ThingHeadersDto) headers: ThingHeadersDto): unknown {
    return { client: headers['x-client'] };
  }
}

/** Raw-body (webhook-style) route: no DTO, so the global pipe must leave the body untouched. */
@Controller('hooks')
class HookController {
  @Post()
  hook(@Body() body: unknown): unknown {
    return { received: body };
  }
}

/** Stand-in for the API-004 filter: status + the structured errors array. */
@Catch(RequestValidationError)
class TestValidationFilter {
  catch(error: RequestValidationError, host: ArgumentsHost): void {
    const reply = host.switchToHttp().getResponse<FastifyReply>();
    void reply.status(error.httpStatus).send({ code: error.code, errors: error.errors });
  }
}

@Module({
  controllers: [ThingsController, HookController],
  providers: [{ provide: APP_FILTER, useClass: TestValidationFilter }],
})
class ThingsModule {}

const DEPTH = 5;

async function boot(): Promise<{
  app: NestFastifyApplication;
  metrics: HttpMetrics;
  lines: string[];
}> {
  const lines: string[] = [];
  const logger = createLogger('api', {
    level: 'debug',
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
    API_MAX_JSON_DEPTH: String(DEPTH),
  });
  const { app, metrics } = await createApiApp({ config, logger, imports: [ThingsModule] });
  await app.getHttpAdapter().getInstance().ready();
  return { app, metrics, lines };
}

describe('global Zod validation pipe', () => {
  let app: NestFastifyApplication;
  let metrics: HttpMetrics;
  let lines: string[];

  beforeAll(async () => {
    ({ app, metrics, lines } = await boot());
  });
  afterAll(async () => {
    await app.close();
  });

  const post = (payload: unknown) =>
    app.inject({ method: 'POST', url: '/v1/things', payload: payload as object });

  it('accepts a valid body and returns the parsed value', async () => {
    const res = await post({ name: 'alpha' });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ name: 'alpha' });
  });

  it('rejects an extra field with 422 and a structured errors array', async () => {
    const res = await post({ name: 'alpha', isAdmin: true });
    expect(res.statusCode).toBe(422);
    const body = res.json<{
      code: string;
      errors: { path: string; message: string; code: string }[];
    }>();
    expect(body.code).toBe('VALIDATION_FAILED');
    expect(body.errors).toHaveLength(1);
    expect(body.errors[0]).toMatchObject({ code: 'unrecognized_keys' });
    expect(Object.keys(body.errors[0] ?? {}).sort()).toEqual(['code', 'message', 'path']);
  });

  it('reports the path of a wrong field and never echoes the submitted value', async () => {
    const secret = 'hunter2-secret-value';
    const res = await post({ name: 123, note: secret, extra: secret });
    expect(res.statusCode).toBe(422);
    expect(res.body).not.toContain(secret);
    const paths = res.json<{ errors: { path: string }[] }>().errors.map((e) => e.path);
    expect(paths).toContain('name');
    expect(lines.join('\n')).not.toContain(secret);
  });

  it('rejects an empty body on a required-body route', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/things' });
    expect(res.statusCode).toBe(422);
    expect(res.json<{ code: string }>().code).toBe('VALIDATION_FAILED');
  });

  it('distinguishes null from a missing optional', async () => {
    expect((await post({ name: 'a' })).statusCode).toBe(201);
    const withNull = await post({ name: 'a', note: null });
    expect(withNull.statusCode).toBe(422);
    expect(withNull.json<{ errors: { path: string }[] }>().errors[0]?.path).toBe('note');
  });

  it('rejects overlong and empty strings, including multi-byte ones', async () => {
    expect((await post({ name: 'x'.repeat(MAX_NAME + 1) })).statusCode).toBe(422);
    expect((await post({ name: '' })).statusCode).toBe(422);
    expect((await post({ name: '\u{1F600}'.repeat(MAX_NAME + 1) })).statusCode).toBe(422);
    expect((await post({ name: '\u{1F600}'.repeat(2) })).statusCode).toBe(201);
  });

  it('rejects bodies nested deeper than API_MAX_JSON_DEPTH', async () => {
    const nest = (levels: number): unknown => (levels === 0 ? 'leaf' : { n: nest(levels - 1) });
    const res = await post({ name: 'a', note: JSON.stringify(nest(1)), deep: nest(DEPTH + 1) });
    expect(res.statusCode).toBe(422);
    expect(res.json<{ errors: { code: string }[] }>().errors[0]?.code).toBe('json_depth_exceeded');
  });

  it('leaves routes without a Zod DTO (webhooks, raw bodies) untouched', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/hooks',
      payload: { anything: [1], deep: { a: { b: { c: { d: { e: 1 } } } } } },
    });
    expect(res.statusCode).toBe(201);
  });

  it('coerces and bounds the query limit', async () => {
    const ok = await app.inject({ method: 'GET', url: '/v1/things?limit=7' });
    expect(ok.json()).toEqual({ limit: 7, type: 'number' });
    const dflt = await app.inject({ method: 'GET', url: '/v1/things' });
    expect(dflt.json()).toEqual({ limit: 25, type: 'number' });
    for (const bad of ['abc', '0', String(MAX_LIMIT + 1), '-3', '1.5']) {
      const res = await app.inject({ method: 'GET', url: `/v1/things?limit=${bad}` });
      expect(res.statusCode, bad).toBe(422);
    }
  });

  it('strips unknown query keys instead of failing', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/things?limit=2&utm=x' });
    expect(res.statusCode).toBe(200);
  });

  it('validates path params and headers', async () => {
    expect((await app.inject({ method: 'GET', url: '/v1/things/thg_abc1' })).json()).toEqual({
      id: 'thg_abc1',
    });
    expect((await app.inject({ method: 'GET', url: '/v1/things/NOPE' })).statusCode).toBe(422);
    const ok = await app.inject({
      method: 'GET',
      url: '/v1/things/hdr/check',
      headers: { 'x-client': 'cli' },
    });
    expect(ok.json()).toEqual({ client: 'cli' });
    expect((await app.inject({ method: 'GET', url: '/v1/things/hdr/check' })).statusCode).toBe(422);
  });

  it('counts failures per route template and logs only field paths at debug', async () => {
    await post({ bogus: 1 });
    const text = await metrics.registry.metrics();
    expect(text).toMatch(/http_validation_failures_total\{route="\/v1\/things"\} [1-9]/);
    const entry = lines
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .find((r) => r.msg === 'http.validation_failed');
    expect(entry?.level).toBe('debug');
    expect(JSON.stringify(entry)).not.toContain('bogus":1');
  });
});

describe('ZodValidationPipe', () => {
  const pipe = new ZodValidationPipe({ maxJsonDepth: DEPTH });

  it('passes through parameters that are not bound to a Zod DTO (raw-body and webhook routes)', () => {
    const raw = Buffer.from('{"x":1,"unknown":true}');
    expect(pipe.transform(raw, { type: 'body', metatype: Object })).toBe(raw);
    expect(pipe.transform('x', { type: 'custom', data: 'anything' })).toBe('x');
    expect(pipe.transform({ a: 1 }, { type: 'body' })).toEqual({ a: 1 });
  });

  it('validates a @Body() whose emitted metatype is a Zod DTO', () => {
    expect(pipe.transform({ name: 'a' }, { type: 'body', metatype: CreateThingDto })).toEqual({
      name: 'a',
    });
    expect(() =>
      pipe.transform({ name: 'a', extra: 1 }, { type: 'body', metatype: CreateThingDto }),
    ).toThrow(RequestValidationError);
  });

  it('keeps a schema that chose its own unknown-key policy', () => {
    class Loose extends createZodDto(z.looseObject({ a: z.string() })) {}
    expect(pipe.transform({ a: 'x', b: 1 }, { type: 'body', metatype: Loose })).toEqual({
      a: 'x',
      b: 1,
    });
  });
});

describe('helpers', () => {
  it('measures JSON depth iteratively', () => {
    expect(exceedsJsonDepth('x', 1)).toBe(false);
    expect(exceedsJsonDepth({ a: [{ b: 1 }] }, 3)).toBe(false);
    expect(exceedsJsonDepth({ a: [{ b: 1 }] }, 2)).toBe(true);
    let deep: unknown = 'leaf';
    const HUGE = 200_000;
    for (let i = 0; i < HUGE; i += 1) deep = [deep];
    expect(exceedsJsonDepth(deep, 32)).toBe(true);
  });

  it('formats issue paths', () => {
    expect(formatIssuePath([])).toBe('');
    expect(formatIssuePath(['a', 0, 'b'])).toBe('a[0].b');
    expect(formatIssuePath([0, 'x'])).toBe('[0].x');
  });

  it('serialize validates outbound shapes outside production only', () => {
    const out = z.object({ id: z.string() });
    const drifted = { id: 5 } as unknown as z.input<typeof out>;
    expect(serialize(out, { id: 'a' }, 'test')).toEqual({ id: 'a' });
    expect(() => serialize(out, drifted, 'development')).toThrow(/contract/);
    expect(serialize(out, drifted, 'production')).toBe(drifted);
  });
});
