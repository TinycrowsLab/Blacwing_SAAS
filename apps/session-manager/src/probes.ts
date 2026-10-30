import { Redis } from 'ioredis';
import { Client } from 'pg';

import type { DependencyProbe } from './readiness.js';

const CONNECT_TIMEOUT_MS = 2000;
/** OpenBao health codes that mean "reachable and serving": active, standby, and the DR or performance variants. */
const OPENBAO_STANDBY = 429;
const OPENBAO_DR_SECONDARY = 472;
const OPENBAO_PERFORMANCE_STANDBY = 473;
const OPENBAO_REACHABLE_STATUSES: ReadonlySet<number> = new Set([
  OPENBAO_STANDBY,
  OPENBAO_DR_SECONDARY,
  OPENBAO_PERFORMANCE_STANDBY,
]);

export interface ClosableProbe extends DependencyProbe {
  close(): Promise<void>;
}

/**
 * PostgreSQL readiness probe. Each probe opens a short-lived client and runs `select 1`, so a dropped
 * connection cannot leave readiness reporting a stale socket. The readiness monitor owns the retry backoff.
 */
export function createPostgresProbe(url: string): ClosableProbe {
  return {
    name: 'postgres',
    async check() {
      const client = new Client({
        connectionString: url,
        connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
        query_timeout: CONNECT_TIMEOUT_MS,
      });
      client.on('error', () => undefined);
      await client.connect();
      try {
        await client.query('select 1');
      } finally {
        await client.end().catch(() => undefined);
      }
    },
    close: () => Promise.resolve(),
  };
}

/**
 * Valkey readiness probe. The client is created lazily on the first probe, never reconnects on its own (the
 * readiness monitor owns backoff) and never queues commands while offline, so a down Valkey fails the probe
 * immediately instead of hanging it.
 */
export function createValkeyProbe(url: string): ClosableProbe {
  let client: Redis | undefined;
  const get = (): Redis => {
    if (client !== undefined) return client;
    const created = new Redis(url, {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
      connectTimeout: CONNECT_TIMEOUT_MS,
      retryStrategy: () => null,
    });
    // Connection errors surface through `connect()`/`ping()`; an unhandled 'error' event would crash.
    created.on('error', () => undefined);
    client = created;
    return created;
  };
  return {
    name: 'valkey',
    async check() {
      const redis = get();
      if (redis.status === 'wait' || redis.status === 'end' || redis.status === 'close') {
        await redis.connect();
      }
      await redis.ping();
    },
    async close() {
      if (client === undefined) return;
      const redis = client;
      client = undefined;
      if (redis.status === 'ready') {
        await redis.quit().catch(() => undefined);
      } else {
        redis.disconnect();
      }
    },
  };
}

/**
 * OpenBao readiness probe: `GET /v1/sys/health`. A 2xx answer or a standby-style code counts as reachable;
 * a sealed, uninitialised or unreachable OpenBao fails the probe (fail closed: no secret can be resolved).
 */
export function createOpenBaoProbe(addr: string, fetchImpl: typeof fetch = fetch): DependencyProbe {
  return {
    name: 'openbao',
    async check() {
      const response = await fetchImpl(new URL('/v1/sys/health', addr), {
        method: 'GET',
        redirect: 'error',
        signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS),
      });
      await response.body?.cancel();
      if (!response.ok && !OPENBAO_REACHABLE_STATUSES.has(response.status)) {
        throw new Error(`openbao health answered ${String(response.status)}`);
      }
    },
  };
}
