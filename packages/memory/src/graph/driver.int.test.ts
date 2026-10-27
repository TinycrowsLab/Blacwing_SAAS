// Integration: needs Docker for Testcontainers Neo4j 5 (`pnpm test:int`). Not run on machines without Docker.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppError } from '@blackwing/errors';
import { withNeo4j, type Neo4jHandle } from '@blackwing/testing/containers';

import {
  checkGraphHealth,
  createGraphRuntime,
  type GraphRuntime,
  withSessionOn,
} from './driver.js';

import type { Neo4jConfig } from './config.js';

let neo: Neo4jHandle;

function configFor(handle: Neo4jHandle, overrides: Partial<Neo4jConfig> = {}): Neo4jConfig {
  return {
    uri: handle.boltUrl,
    username: handle.username,
    password: handle.password,
    database: 'neo4j',
    maxPoolSize: 50,
    connectionTimeoutMs: 5000,
    maxTxRetryMs: 15000,
    ...overrides,
  };
}

function runtimeFor(config: Neo4jConfig): GraphRuntime {
  const logs: string[] = [];
  const logger = {
    debug: (...args: unknown[]) => logs.push(JSON.stringify(args)),
    info: (...args: unknown[]) => logs.push(JSON.stringify(args)),
    warn: (...args: unknown[]) => logs.push(JSON.stringify(args)),
    error: (...args: unknown[]) => logs.push(JSON.stringify(args)),
  };
  return createGraphRuntime(config, {
    logger: logger,
  });
}

beforeAll(async () => {
  neo = await withNeo4j();
}, 180_000);

afterAll(async () => {
  await neo.stop();
});

describe('graph driver against Neo4j 5', () => {
  it('reports ok:true for a live database', async () => {
    const runtime = runtimeFor(configFor(neo));
    try {
      const health = await checkGraphHealth(runtime);
      expect(health.ok).toBe(true);
      expect(health.latencyMs).toBeGreaterThanOrEqual(0);
    } finally {
      await runtime.driver.close();
    }
  });

  it('reports ok:false and does not throw when the database is down', async () => {
    const runtime = runtimeFor(
      configFor(neo, { uri: 'bolt://127.0.0.1:1', connectionTimeoutMs: 500 }),
    );
    try {
      const health = await checkGraphHealth(runtime);
      expect(health.ok).toBe(false);
    } finally {
      await runtime.driver.close();
    }
  });

  it('runs read and write sessions and always closes them', async () => {
    const runtime = runtimeFor(configFor(neo));
    try {
      await withSessionOn(runtime, 'WRITE', (session) =>
        session.run('CREATE (:GraphProbe {probe: $probe})', { probe: 'write-ok' }),
      );
      const count = await withSessionOn(runtime, 'READ', async (session) => {
        const result = await session.run(
          'MATCH (n:GraphProbe {probe: $probe}) RETURN count(n) AS c',
          {
            probe: 'write-ok',
          },
        );
        return Number(result.records[0]?.get('c'));
      });
      expect(count).toBeGreaterThanOrEqual(1);
    } finally {
      await runtime.driver.close();
    }
  });

  it('surfaces pool exhaustion as GRAPH_POOL_TIMEOUT instead of hanging', async () => {
    const runtime = runtimeFor(configFor(neo, { maxPoolSize: 1, connectionTimeoutMs: 300 }));
    try {
      const holder = runtime.driver.session({ database: 'neo4j' });
      const tx = await holder.beginTransaction();
      await tx.run('RETURN 1');
      try {
        const error = await withSessionOn(runtime, 'READ', (session) =>
          session.run('RETURN 1'),
        ).catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(AppError);
        expect((error as AppError).code).toBe('GRAPH_POOL_TIMEOUT');
      } finally {
        await tx.rollback();
        await holder.close();
      }
    } finally {
      await runtime.driver.close();
    }
  });
});
