import type { HealthProbe } from './health.types.js';

/** Structural view of a `pg.Pool`: the health module needs no driver dependency. */
export interface QueryablePool {
  query(sql: string): Promise<unknown>;
}

/** Structural view of an ioredis client. */
export interface PingableClient {
  ping(): Promise<string>;
}

/** Structural view of the namespace API of a Temporal connection. */
export interface NamespaceDescriber {
  describeNamespace(namespace: string): Promise<unknown>;
}

/** `SELECT 1` on the application pool. Critical. */
export function postgresProbe(pool: QueryablePool): HealthProbe {
  return {
    name: 'postgres',
    critical: true,
    async check(): Promise<void> {
      await pool.query('SELECT 1');
    },
  };
}

/** `PING` against Valkey. Critical. */
export function valkeyProbe(client: PingableClient): HealthProbe {
  return {
    name: 'valkey',
    critical: true,
    async check(): Promise<void> {
      const reply = await client.ping();
      if (reply !== 'PONG') throw new Error('unexpected PING reply');
    },
  };
}

/** Describes the configured namespace. Not critical: the API serves reads without Temporal. */
export function temporalProbe(client: NamespaceDescriber, namespace: string): HealthProbe {
  return {
    name: 'temporal',
    critical: false,
    async check(): Promise<void> {
      await client.describeNamespace(namespace);
    },
  };
}
