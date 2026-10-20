// Readiness against real Postgres and Valkey (API-011, #63): toggling a dependency flips /health/ready.

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createLogger } from '@blackwing/logger';
import {
  type PostgresHandle,
  type ValkeyHandle,
  withPostgres,
  withValkey,
} from '@blackwing/testing/containers';

import { createApiApp } from '../bootstrap/create-app.js';
import { loadApiConfig } from '../config.js';
import { postgresProbe, valkeyProbe } from './probes.js';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';

let postgres: PostgresHandle;
let valkey: ValkeyHandle;
let pool: pg.Pool;
let app: NestFastifyApplication;

const get = (url: string) => app.inject({ method: 'GET', url });

beforeAll(async () => {
  [postgres, valkey] = await Promise.all([withPostgres(), withValkey()]);
  pool = new pg.Pool(postgres.connectionConfig('app'));
  const created = await createApiApp({
    config: loadApiConfig({
      NODE_ENV: 'test',
      WEB_ORIGIN: 'http://localhost:3000',
      API_HEALTH_CACHE_MS: '0',
      API_HEALTH_CHECK_TIMEOUT_MS: '3000',
    }),
    logger: createLogger('api', { level: 'silent', nodeEnv: 'test' }),
    healthProbes: [postgresProbe(pool), valkeyProbe(valkey.client)],
  });
  app = created.app;
  await app.getHttpAdapter().getInstance().ready();
});

afterAll(async () => {
  await app.close();
  await pool.end().catch(() => undefined);
  await valkey.stop();
  await postgres.stop();
});

describe('health readiness with real dependencies', () => {
  it('is ready while Postgres and Valkey answer, with latencies and no connection info', async () => {
    const ready = await get('/health/ready');
    expect(ready.statusCode).toBe(200);
    const detail = await get('/health');
    expect(detail.json()).toMatchObject({
      status: 'ok',
      checks: { postgres: { status: 'ok' }, valkey: { status: 'ok' } },
    });
    expect(detail.body).not.toContain(String(postgres.port));
    expect(detail.body).not.toContain(String(valkey.port));
    expect(detail.body).not.toContain(valkey.password);
  });

  it('turns 503 when Valkey becomes unreachable', async () => {
    valkey.client.disconnect();
    const ready = await get('/health/ready');
    expect(ready.statusCode).toBe(503);
    expect((await get('/health')).json()).toMatchObject({
      checks: { valkey: { status: 'down', error: 'unreachable' } },
    });
  });

  it('turns 503 when Postgres becomes unreachable', async () => {
    await pool.end();
    const ready = await get('/health/ready');
    expect(ready.statusCode).toBe(503);
    expect((await get('/health')).json()).toMatchObject({
      checks: { postgres: { status: 'down' } },
    });
  });
});
