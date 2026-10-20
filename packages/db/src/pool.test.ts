import { readFileSync } from 'node:fs';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { isAppError } from '@blackwing/errors';

import { createAppDatabase, pingPool } from './client.js';
import { DbUnavailableError, type DbLogger } from './pool.js';

const PASSWORD = 'pool-test-secret-9f8e7d';

interface Line {
  level: 'info' | 'warn' | 'error';
  fields: Record<string, unknown>;
  message: string;
}

function captureLogger(): { logger: DbLogger; lines: Line[] } {
  const lines: Line[] = [];
  const at =
    (level: Line['level']) =>
    (fields: unknown, message?: string): void => {
      lines.push({ level, fields: fields as Record<string, unknown>, message: message ?? '' });
    };
  // Only the (fields, message) form is used by this package.
  const logger = { info: at('info'), warn: at('warn'), error: at('error') };
  return { logger, lines };
}

/** A TCP port with nothing listening (connection refused). */
async function closedPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  await new Promise<void>((resolve) =>
    server.close(() => {
      resolve();
    }),
  );
  if (address === null || typeof address === 'string') throw new Error('no port');
  return address.port;
}

/** A server that accepts TCP connections and never answers (a hung database). */
async function blackHole(): Promise<{ port: number; close: () => Promise<void> }> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return {
    port: address.port,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) =>
        server.close(() => {
          resolve();
        }),
      );
    },
  };
}

const env = (port: number, extra: Record<string, string> = {}): Record<string, string> => ({
  NODE_ENV: 'test',
  PGHOST: '127.0.0.1',
  PGPORT: String(port),
  PG_APP_PASSWORD: PASSWORD,
  ...extra,
});

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe('app pool failure modes', () => {
  it('surfaces an unreachable server as DbUnavailableError and logs no credentials', async () => {
    const { logger, lines } = captureLogger();
    const database = createAppDatabase({ source: env(await closedPort()), logger });
    cleanups.push(() => database.close());

    const error: unknown = await database.pool.query('SELECT 1').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DbUnavailableError);
    expect(isAppError(error)).toBe(true);
    expect(error).toMatchObject({
      code: 'DB_UNAVAILABLE',
      reason: 'connection_failed',
      pool: 'app',
    });
    expect(error).toMatchObject({ httpStatus: 503, retryable: true });

    const health = await database.ping();
    expect(health.ok).toBe(false);

    const failure = lines.find((line) => line.message === 'db.pool.error');
    expect(failure?.fields).toMatchObject({ pool: 'app', errorCode: 'ECONNREFUSED' });
    expect(JSON.stringify(lines)).not.toContain(PASSWORD);
  });

  it('queues callers on an exhausted pool, then fails them with pool_exhausted after the timeout', async () => {
    const hole = await blackHole();
    cleanups.push(hole.close);
    const { logger, lines } = captureLogger();
    const database = createAppDatabase({
      source: env(hole.port, { PG_POOL_MAX: '1', PG_ACQUIRE_TIMEOUT: '150ms' }),
      logger,
    });
    cleanups.push(() => database.close());

    // The only connection slot is taken by a connection attempt that never completes.
    const first = database.pool.connect().catch((e: unknown) => e);
    const second: unknown = await database.pool.connect().catch((e: unknown) => e);
    expect(second).toBeInstanceOf(DbUnavailableError);
    expect(second).toMatchObject({ reason: 'pool_exhausted' });
    expect(await first).toBeInstanceOf(DbUnavailableError);

    const exhausted = lines.filter((line) => line.message === 'db.pool.exhausted');
    expect(exhausted).toHaveLength(1);
    expect(exhausted[0]?.fields).toMatchObject({ pool: 'app', waiting: 1, size: 1 });
  });

  it('reports a hung server as unhealthy within the ping timeout', async () => {
    const hole = await blackHole();
    cleanups.push(hole.close);
    const { logger } = captureLogger();
    const database = createAppDatabase({ source: env(hole.port), logger });
    cleanups.push(() => database.close());

    const health = await pingPool(database.pool, 100);
    expect(health).toMatchObject({ ok: false });
    expect(health.latencyMs).toBeLessThan(2_000);
  });

  it('fails a closed pool with pool_closed and closes idempotently', async () => {
    const { logger, lines } = captureLogger();
    const database = createAppDatabase({ source: env(await closedPort()), logger });
    await Promise.all([database.close(), database.close()]);
    expect(lines.filter((line) => line.message === 'db.pool.end')).toHaveLength(1);
    const error: unknown = await database.pool.connect().catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'DB_UNAVAILABLE', reason: 'pool_closed' });
  });

  it('throws CONFIG_INVALID before creating any pool on a bad environment', () => {
    let thrown: unknown;
    try {
      createAppDatabase({ source: { NODE_ENV: 'test', PGHOST: 'h' } });
    } catch (error) {
      thrown = error;
    }
    expect(isAppError(thrown)).toBe(true);
    expect(thrown).toMatchObject({ code: 'CONFIG_INVALID' });
  });
});

describe('runtime entry point', () => {
  const src = (file: string): string =>
    readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8');

  it('never reaches the owner pool or owner credentials', () => {
    for (const file of ['./index.ts', './client.ts', './pool.ts']) {
      expect(src(file)).not.toMatch(/owner\.js|loadOwnerDbConfig|ownerDbEnvSchema|PG_OWNER/);
    }
  });
});
