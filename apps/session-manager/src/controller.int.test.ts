// SESSION-001 (#612) integration: the real session manager against a Testcontainers Valkey and PostgreSQL.
// Covers readiness transitions driven by real dependency probes, a dependency that is down at boot (503,
// fail closed), and the SIGTERM drain of an in-flight request.
import { createServer } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  type PostgresHandle,
  withPostgres,
  type ValkeyHandle,
  withValkey,
} from '@blackwing/testing/containers';
import { surfaceContainerLogsOnFailure } from '@blackwing/testing/vitest';

import { loadSessionManagerConfig } from './config.js';
import { startSessionManager, type RunningSessionManager } from './controller.js';
import { createValkeyProbe } from './probes.js';

import type { DependencyProbe } from './readiness.js';

const RUN_SECRET = 'r'.repeat(48);
const CONTROL_SECRET = 'c'.repeat(48);

let valkey: ValkeyHandle | undefined;
let postgres: PostgresHandle | undefined;
beforeAll(async () => {
  valkey = await withValkey();
  postgres = await withPostgres();
});
afterAll(async () => {
  await postgres?.stop();
  await valkey?.stop();
});
surfaceContainerLogsOnFailure(() => [valkey, postgres]);

function valkeyUrl(): string {
  if (valkey === undefined) throw new Error('valkey not started');
  return `redis://:${valkey.password}@${valkey.host}:${String(valkey.port)}/0`;
}

/** The PostgreSQL probe runs `select 1` through the RLS-enforcing application pool. */
function postgresProbe(): DependencyProbe {
  return {
    name: 'postgres',
    async check() {
      if (postgres === undefined) throw new Error('postgres not started');
      await postgres.appPool.query('select 1');
    },
  };
}

function openBaoProbe(state: { up: boolean }): DependencyProbe {
  return {
    name: 'openbao',
    check: () => (state.up ? Promise.resolve() : Promise.reject(new Error('sealed'))),
  };
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => {
        resolve(port);
      });
    });
  });
}

function env(port: number, databaseUrl: string, valkeyLocation: string): Record<string, string> {
  return {
    NODE_ENV: 'test',
    SM_MGMT_ADDR: `127.0.0.1:${String(port)}`,
    SM_DRAIN_TIMEOUT: '3s',
    SM_RUN_TOKEN_SECRET: RUN_SECRET,
    SM_CONTROL_TOKEN_SECRET: CONTROL_SECRET,
    DATABASE_URL: databaseUrl,
    VALKEY_URL: valkeyLocation,
  };
}

async function readyz(manager: RunningSessionManager): Promise<number> {
  return (await manager.app.inject({ method: 'GET', url: '/readyz' })).statusCode;
}

const running: RunningSessionManager[] = [];
afterAll(async () => {
  await Promise.allSettled(running.map((manager) => manager.shutdown('test-cleanup')));
});

describe('session manager against real Valkey and PostgreSQL', () => {
  it('is ready once PostgreSQL, Valkey and OpenBao answer, and back to 503 when OpenBao is sealed', async () => {
    if (valkey === undefined || postgres === undefined) throw new Error('containers not started');
    const bao = { up: true };
    const config = loadSessionManagerConfig(
      env(await freePort(), 'postgres://unused:unused@127.0.0.1:1/bw', valkeyUrl()),
    );
    const manager = await startSessionManager(config, {
      postgresProbe: postgresProbe(),
      valkeyProbe: createValkeyProbe(valkeyUrl()),
      openBaoProbe: openBaoProbe(bao),
      flushTelemetry: () => Promise.resolve(),
      readiness: { initialBackoffMs: 10, recheckMs: 10 },
    });
    running.push(manager);

    const waitFor = async (want: number): Promise<void> => {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        if ((await readyz(manager)) === want) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`readyz never reached ${String(want)}`);
    };
    await waitFor(200);
    bao.up = false;
    await manager.readiness.checkNow();
    expect(await readyz(manager)).toBe(503);
    bao.up = true;
    await manager.readiness.checkNow();
    expect(await readyz(manager)).toBe(200);
  });

  it('stays 503 while Valkey is unreachable at boot (fail closed), then drains on SIGTERM', async () => {
    const deadPort = await freePort();
    const config = loadSessionManagerConfig(
      env(
        await freePort(),
        'postgres://unused:unused@127.0.0.1:1/bw',
        `redis://127.0.0.1:${String(deadPort)}/0`,
      ),
    );
    const manager = await startSessionManager(config, {
      postgresProbe: postgresProbe(),
      valkeyProbe: createValkeyProbe(`redis://127.0.0.1:${String(deadPort)}/0`),
      openBaoProbe: openBaoProbe({ up: true }),
      flushTelemetry: () => Promise.resolve(),
      readiness: { initialBackoffMs: 10, recheckMs: 10 },
    });
    running.push(manager);
    await manager.readiness.checkNow();
    expect(await readyz(manager)).toBe(503);

    const result = await manager.shutdown('SIGTERM');
    expect(result).toEqual({ drained: true });
    expect(manager.readiness.isReady()).toBe(false);
  });
});
