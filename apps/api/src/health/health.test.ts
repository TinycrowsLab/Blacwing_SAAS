import { afterEach, describe, expect, it } from 'vitest';

import { createLogger } from '@blackwing/logger';

import { createApiApp, type CreateApiAppOptions } from '../bootstrap/create-app.js';
import { ShutdownDrain } from '../bootstrap/shutdown.js';
import { loadApiConfig } from '../config.js';
import { HealthService } from './health.service.js';
import { postgresProbe, temporalProbe, valkeyProbe } from './probes.js';

import type { HealthProbe } from './health.types.js';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

const SECRET_HOST = 'db.internal.example:5432/postgres://user:hunter2@';

interface Switch {
  down: boolean;
  slow: boolean;
  calls: number;
}

function probe(name: string, critical: boolean, state: Switch): HealthProbe {
  return {
    name,
    critical,
    async check(): Promise<void> {
      state.calls += 1;
      if (state.slow) await new Promise<void>(() => undefined);
      if (state.down) throw new Error(`connect ECONNREFUSED ${SECRET_HOST}`);
    },
  };
}

const apps: NestFastifyApplication[] = [];
const lines: string[] = [];

async function start(
  probes: readonly HealthProbe[],
  env: Record<string, string> = {},
  extra: Partial<CreateApiAppOptions> = {},
): Promise<NestFastifyApplication> {
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
    API_HEALTH_CACHE_MS: '0',
    API_VERSION: '1.2.3',
    API_COMMIT: 'abc1234',
    ...env,
  });
  const { app } = await createApiApp({ config, logger, healthProbes: probes, ...extra });
  await app.getHttpAdapter().getInstance().ready();
  apps.push(app);
  return app;
}

const get = (app: NestFastifyApplication, url: string) => app.inject({ method: 'GET', url });

afterEach(async () => {
  lines.length = 0;
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('health endpoints', () => {
  it('serves live, ready and the detailed report without auth and outside /v1', async () => {
    const app = await start([
      probe('postgres', true, { down: false, slow: false, calls: 0 }),
      probe('valkey', true, { down: false, slow: false, calls: 0 }),
    ]);
    expect((await get(app, '/health/live')).statusCode).toBe(200);
    expect((await get(app, '/health/ready')).statusCode).toBe(200);
    const detail = await get(app, '/health');
    expect(detail.statusCode).toBe(200);
    const body = detail.json<{
      status: string;
      version: string;
      commit: string;
      checks: Record<string, { status: string; latencyMs: number }>;
    }>();
    expect(body.status).toBe('ok');
    expect(body.version).toBe('1.2.3');
    expect(body.commit).toBe('abc1234');
    expect(Object.keys(body.checks)).toEqual(['postgres', 'valkey']);
    expect(body.checks.postgres).toMatchObject({ status: 'ok' });
    expect(body.checks.postgres?.latencyMs).toBeGreaterThanOrEqual(0);
    for (const url of ['/v1/health', '/v1/health/live', '/v1/health/ready']) {
      expect((await get(app, url)).statusCode, url).toBe(404);
    }
  });

  it('is ready with no probes registered', async () => {
    const app = await start([]);
    expect((await get(app, '/health/ready')).statusCode).toBe(200);
    expect((await get(app, '/health')).json()).toMatchObject({ status: 'ok', checks: {} });
  });

  it('returns 503 from ready and down from /health when a critical dependency is down, without leaking', async () => {
    const pg: Switch = { down: true, slow: false, calls: 0 };
    const app = await start([
      probe('postgres', true, pg),
      probe('valkey', true, { down: false, slow: false, calls: 0 }),
    ]);
    expect((await get(app, '/health/ready')).statusCode).toBe(503);
    expect((await get(app, '/health/live')).statusCode).toBe(200);
    const detail = await get(app, '/health');
    expect(detail.statusCode).toBe(503);
    expect(detail.json()).toMatchObject({
      status: 'down',
      checks: { postgres: { status: 'down', error: 'unreachable' }, valkey: { status: 'ok' } },
    });
    for (const text of [detail.body, (await get(app, '/health/ready')).body]) {
      expect(text).not.toContain('hunter2');
      expect(text).not.toContain('ECONNREFUSED');
      expect(text).not.toContain('db.internal');
    }
    pg.down = false;
    expect((await get(app, '/health/ready')).statusCode).toBe(200);
  });

  it('marks a slow dependency down at the timeout and still answers fast', async () => {
    const app = await start([probe('valkey', true, { down: false, slow: true, calls: 0 })], {
      API_HEALTH_CHECK_TIMEOUT_MS: '50',
    });
    const started = performance.now();
    const ready = await get(app, '/health/ready');
    expect(performance.now() - started).toBeLessThan(1000);
    expect(ready.statusCode).toBe(503);
    expect((await get(app, '/health')).json()).toMatchObject({
      checks: { valkey: { status: 'down', error: 'timeout' } },
    });
  });

  it('reports degraded but stays ready when only a non-critical dependency is down', async () => {
    const app = await start([
      probe('postgres', true, { down: false, slow: false, calls: 0 }),
      probe('temporal', false, { down: true, slow: false, calls: 0 }),
    ]);
    expect((await get(app, '/health/ready')).statusCode).toBe(200);
    const detail = await get(app, '/health');
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({
      status: 'degraded',
      checks: { temporal: { status: 'down' } },
    });
  });

  it('skips Temporal entirely when API_HEALTH_CHECK_TEMPORAL is false', async () => {
    const temporal: Switch = { down: true, slow: false, calls: 0 };
    const app = await start([probe('temporal', false, temporal)], {
      API_HEALTH_CHECK_TEMPORAL: 'false',
    });
    const body = (await get(app, '/health')).json<{ status: string; checks: object }>();
    expect(body.status).toBe('ok');
    expect(body.checks).toEqual({});
    expect(temporal.calls).toBe(0);
  });

  it('caches results for API_HEALTH_CACHE_MS so probe bursts do not hammer dependencies', async () => {
    const pg: Switch = { down: false, slow: false, calls: 0 };
    const app = await start([probe('postgres', true, pg)], { API_HEALTH_CACHE_MS: '60s' });
    await Promise.all([get(app, '/health/ready'), get(app, '/health/ready'), get(app, '/health')]);
    await get(app, '/health/ready');
    expect(pg.calls).toBe(1);
  });

  it('flips live and ready to 503 the instant shutdown begins, before draining', async () => {
    const app = await start([probe('postgres', true, { down: false, slow: false, calls: 0 })]);
    expect((await get(app, '/health/ready')).statusCode).toBe(200);
    app.get(ShutdownDrain, { strict: false }).beforeApplicationShutdown('SIGTERM');
    expect((await get(app, '/health/ready')).statusCode).toBe(503);
    expect((await get(app, '/health/live')).statusCode).toBe(503);
    const detail = await get(app, '/health');
    expect(detail.statusCode).toBe(503);
    expect(detail.json()).toMatchObject({ status: 'down' });
    app.get(ShutdownDrain, { strict: false }).onApplicationShutdown('SIGTERM');
  });

  it('logs ok to down and down to ok transitions at warn, and nothing on a steady state', async () => {
    const pg: Switch = { down: false, slow: false, calls: 0 };
    const app = await start([probe('postgres', true, pg)]);
    await get(app, '/health/ready');
    pg.down = true;
    await get(app, '/health/ready');
    await get(app, '/health/ready');
    pg.down = false;
    await get(app, '/health/ready');
    const transitions = lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((entry) => entry.msg === 'api.health.transition');
    expect(transitions.map((entry) => [entry.from, entry.to, entry.level])).toEqual([
      ['ok', 'down', 'warn'],
      ['down', 'ok', 'warn'],
    ]);
    expect(JSON.stringify(transitions)).not.toContain('hunter2');
  });

  it('exports health_check_status and health_check_latency_seconds per dependency', async () => {
    const { createHttpMetrics } = await import('../bootstrap/metrics.js');
    const metrics = createHttpMetrics();
    const app = await start(
      [
        probe('postgres', true, { down: false, slow: false, calls: 0 }),
        probe('valkey', true, { down: true, slow: false, calls: 0 }),
      ],
      {},
      { metrics },
    );
    await get(app, '/health/ready');
    const text = await metrics.registry.metrics();
    expect(text).toContain('health_check_status{dependency="postgres"} 1');
    expect(text).toContain('health_check_status{dependency="valkey"} 0');
    expect(text).toContain('health_check_latency_seconds{dependency="postgres"}');
    expect(app.get(HealthService, { strict: false })).toBeInstanceOf(HealthService);
  });
});

describe('probe factories', () => {
  it('postgres runs SELECT 1, valkey requires PONG, temporal describes the namespace', async () => {
    const queries: string[] = [];
    const signal = new AbortController().signal;
    await postgresProbe({
      query: (sql) => {
        queries.push(sql);
        return Promise.resolve();
      },
    }).check(signal);
    expect(queries).toEqual(['SELECT 1']);

    await expect(
      valkeyProbe({ ping: () => Promise.resolve('PONG') }).check(signal),
    ).resolves.toBeUndefined();
    await expect(
      valkeyProbe({ ping: () => Promise.resolve('NOPE') }).check(signal),
    ).rejects.toThrow();

    const described: string[] = [];
    const temporal = temporalProbe(
      {
        describeNamespace: (ns) => {
          described.push(ns);
          return Promise.resolve();
        },
      },
      'blackwing',
    );
    await temporal.check(signal);
    expect(described).toEqual(['blackwing']);
    expect(temporal.critical).toBe(false);
    expect(postgresProbe({ query: () => Promise.resolve() }).critical).toBe(true);
  });
});
