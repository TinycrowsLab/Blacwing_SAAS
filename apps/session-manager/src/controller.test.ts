import { afterEach, describe, expect, it } from 'vitest';

import { createLogger } from '@blackwing/logger';

import { loadSessionManagerConfig } from './config.js';
import { startSessionManager, type RunningSessionManager } from './controller.js';

import type { AuditEmitter, SessionManagerAuditEvent } from './audit.js';
import type { DependencyProbe } from './readiness.js';

const VALID_ENV = {
  NODE_ENV: 'test',
  // A random high loopback port per run: port 0 is refused by the config (a fixed address is the contract).
  SM_MGMT_ADDR: `127.0.0.1:${String(20_000 + Math.floor(Math.random() * 20_000))}`,
  SM_DRAIN_TIMEOUT: '2s',
  SM_RUN_TOKEN_SECRET: 'r'.repeat(48),
  SM_CONTROL_TOKEN_SECRET: 'c'.repeat(48),
  DATABASE_URL: 'postgres://sm:pw@127.0.0.1:1/bw',
  VALKEY_URL: 'redis://127.0.0.1:1/0',
  SM_BUILD_COMMIT: 'abc123',
};

function toggle(name: string): DependencyProbe & { up: boolean } {
  const probe = {
    name,
    up: false,
    check: () => (probe.up ? Promise.resolve() : Promise.reject(new Error('down'))),
  };
  return probe;
}

function recordingAudit(): AuditEmitter & { events: SessionManagerAuditEvent[] } {
  const events: SessionManagerAuditEvent[] = [];
  return {
    events,
    emit(event) {
      events.push(event);
      return Promise.resolve();
    },
  };
}

let running: RunningSessionManager | undefined;
afterEach(async () => {
  await running?.shutdown('test-cleanup');
  running = undefined;
});

async function boot(overrides: Record<string, string> = {}): Promise<{
  manager: RunningSessionManager;
  postgres: DependencyProbe & { up: boolean };
  valkey: DependencyProbe & { up: boolean };
  openbao: DependencyProbe & { up: boolean };
  audit: ReturnType<typeof recordingAudit>;
}> {
  const config = loadSessionManagerConfig({ ...VALID_ENV, ...overrides });
  const postgres = toggle('postgres');
  const valkey = toggle('valkey');
  const openbao = toggle('openbao');
  const audit = recordingAudit();
  const manager = await startSessionManager(config, {
    logger: createLogger('session-manager', {
      level: 'error',
      nodeEnv: 'test',
      destination: { write: () => undefined },
    }),
    postgresProbe: postgres,
    valkeyProbe: valkey,
    openBaoProbe: openbao,
    audit,
    flushTelemetry: () => Promise.resolve(),
    readiness: { initialBackoffMs: 5, recheckMs: 5 },
  });
  running = manager;
  return { manager, postgres, valkey, openbao, audit };
}

describe('startSessionManager', () => {
  it('serves health immediately but stays not ready until every dependency answers', async () => {
    const { manager, postgres, valkey, openbao } = await boot();
    const status = async (url: string): Promise<number> =>
      (await manager.app.inject({ method: 'GET', url })).statusCode;

    expect(await status('/healthz')).toBe(200);
    expect(await status('/readyz')).toBe(503);
    postgres.up = true;
    valkey.up = true;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(await status('/readyz')).toBe(503);
    openbao.up = true;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(await status('/readyz')).toBe(200);
  });

  it('binds the configured address and emits session_manager.started with a config hash only', async () => {
    const { manager, audit } = await boot();
    expect(manager.address.host).toBe('127.0.0.1');
    const started = audit.events.find((event) => event.type === 'session_manager.started');
    expect(started?.configHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(started)).not.toContain('r'.repeat(48));
  });

  it('drains on shutdown, reports drained, emits stopped and marks not ready', async () => {
    const { manager, audit } = await boot();
    const result = await manager.shutdown('SIGTERM');
    expect(result).toEqual({ drained: true });
    const stopped = audit.events.find((event) => event.type === 'session_manager.stopped');
    expect(stopped).toMatchObject({ signal: 'SIGTERM', drained: true });
    const up = await manager.metrics.up.get();
    expect(up.values[0]?.value).toBe(0);
    expect(manager.readiness.isReady()).toBe(false);
  });

  it('shutdown is idempotent: a second call returns the first result', async () => {
    const { manager, audit } = await boot();
    const first = await manager.shutdown('SIGTERM');
    const second = await manager.shutdown('SIGINT');
    expect(second).toEqual(first);
    expect(audit.events.filter((event) => event.type === 'session_manager.stopped')).toHaveLength(
      1,
    );
  });
});
