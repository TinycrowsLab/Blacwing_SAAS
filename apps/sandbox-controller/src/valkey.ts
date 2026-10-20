import { Redis } from 'ioredis';

import type { DependencyProbe } from './readiness.js';

const CONNECT_TIMEOUT_MS = 2000;

export interface ValkeyProbe extends DependencyProbe {
  close(): Promise<void>;
}

/**
 * Readiness probe for Valkey. The client is created lazily on the first probe, never reconnects on its
 * own (the readiness monitor owns backoff) and never queues commands while offline, so a down Valkey fails
 * the probe immediately instead of hanging it.
 */
export function createValkeyProbe(url: string): ValkeyProbe {
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
