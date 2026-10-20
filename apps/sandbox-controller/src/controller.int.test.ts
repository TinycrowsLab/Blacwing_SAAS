// SANDBOX-001 (#448) integration: the real controller against a Testcontainers Valkey. Covers boot,
// /readyz transitions (driver and Valkey), SIGTERM drain in-process and as a real process, and the
// invalid-config exit.
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { type ValkeyHandle, withValkey } from '@blackwing/testing/containers';
import { surfaceContainerLogsOnFailure } from '@blackwing/testing/vitest';

import { signRunToken } from './auth.js';
import { loadSandboxControllerConfig, type SandboxControllerConfig } from './config.js';
import { startSandboxController, type RunningController } from './controller.js';
import { FakeDriver } from './drivers/index.js';

import type { AuditEmitter, ControllerAuditEvent } from './audit.js';
import type { FastifyPluginAsync } from 'fastify';

const SECRET = 'i'.repeat(48);
const DIGEST = `ghcr.io/tinycrows/bw-sandbox@sha256:${'b'.repeat(64)}`;
const TENANT = '0192f5a0-0000-7000-8000-000000000001';
const RUN = '0192f5a0-0000-7000-8000-0000000000aa';
const mainPath = fileURLToPath(new URL('./main.ts', import.meta.url));
const appDir = fileURLToPath(new URL('..', import.meta.url));

let valkey: ValkeyHandle | undefined;
beforeAll(async () => {
  valkey = await withValkey();
});
afterAll(async () => {
  await valkey?.stop();
});
surfaceContainerLogsOnFailure(() => [valkey]);

function valkeyUrl(): string {
  if (valkey === undefined) throw new Error('valkey not started');
  return `redis://:${valkey.password}@${valkey.host}:${String(valkey.port)}/0`;
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

function rawEnv(
  port: number,
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    NODE_ENV: 'test',
    LOG_LEVEL: 'info',
    SBX_MGMT_ADDR: `127.0.0.1:${String(port)}`,
    SBX_IMAGE_DIGEST: DIGEST,
    SBX_RUN_TOKEN_SECRET: SECRET,
    SBX_DRAIN_TIMEOUT: '2s',
    VALKEY_URL: valkeyUrl(),
    ...overrides,
  };
}

async function config(
  overrides: Record<string, string | undefined> = {},
): Promise<Readonly<SandboxControllerConfig>> {
  return loadSandboxControllerConfig(rawEnv(await freePort(), overrides));
}

function fakeDriver(): FakeDriver {
  return new FakeDriver({ reachable: false });
}

function recordingAudit(): AuditEmitter & { events: ControllerAuditEvent[] } {
  const events: ControllerAuditEvent[] = [];
  return {
    events,
    emit: (event) => {
      events.push(event);
      return Promise.resolve();
    },
  };
}

/** A slow internal route, to have a request in flight during shutdown. */
function slowRoutes(delayMs: number): FastifyPluginAsync {
  return (scope) => {
    scope.post('/slow', async (_request, reply) => {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return reply.send({ done: true });
    });
    return Promise.resolve();
  };
}

const base = (c: RunningController): string => `http://${c.address.host}:${String(c.address.port)}`;
const authHeader = (): Record<string, string> => {
  const now = Math.floor(Date.now() / 1000);
  return {
    authorization: `Bearer ${signRunToken(SECRET, { tenantId: TENANT, runId: RUN, expiresAt: now + 600 })}`,
    'content-type': 'application/json',
  };
};

describe('sandbox controller (integration)', () => {
  it('boots, serves /healthz, and /readyz flips to 200 once the driver and Valkey are reachable', async () => {
    const driver = fakeDriver();
    const audit = recordingAudit();
    const controller = await startSandboxController(await config(), {
      driverFactory: () => driver,
      audit,
      readiness: { initialBackoffMs: 20, recheckMs: 50 },
    });
    try {
      expect((await fetch(`${base(controller)}/healthz`)).status).toBe(200);
      expect((await fetch(`${base(controller)}/readyz`)).status).toBe(503);
      driver.reachable = true;
      await vi.waitFor(async () => {
        expect((await fetch(`${base(controller)}/readyz`)).status).toBe(200);
      });
      const metrics = await (await fetch(`${base(controller)}/metrics`)).text();
      expect(metrics).toContain('sbx_up 1');
      expect(metrics).toContain('sbx_ready 1');
      driver.reachable = false;
      await vi.waitFor(async () => {
        expect((await fetch(`${base(controller)}/readyz`)).status).toBe(503);
      });
      expect(audit.events[0]).toMatchObject({ type: 'sandbox_controller.started' });
      expect(audit.events[0]?.configHash).toMatch(/^[a-f0-9]{64}$/);
      expect(JSON.stringify(audit.events)).not.toContain(SECRET);
    } finally {
      await controller.shutdown('test');
    }
  });

  it('edge case: an unreachable Valkey keeps /readyz 503 and is retried with backoff', async () => {
    const driver = fakeDriver();
    driver.reachable = true;
    const deadPort = await freePort();
    const controller = await startSandboxController(
      await config({ VALKEY_URL: `redis://127.0.0.1:${String(deadPort)}/0` }),
      {
        driverFactory: () => driver,
        audit: recordingAudit(),
        readiness: { initialBackoffMs: 20, recheckMs: 50 },
      },
    );
    try {
      await new Promise((resolve) => setTimeout(resolve, 300));
      const res = await fetch(`${base(controller)}/readyz`);
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({
        status: 'not_ready',
        checks: { driver: true, valkey: false },
      });
    } finally {
      await controller.shutdown('test');
    }
  });

  it('the default build driver is unavailable, so /readyz stays 503 (fail closed)', async () => {
    const controller = await startSandboxController(await config(), {
      audit: recordingAudit(),
      readiness: { initialBackoffMs: 20, recheckMs: 50 },
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 300));
      const res = await fetch(`${base(controller)}/readyz`);
      expect(await res.json()).toEqual({
        status: 'not_ready',
        checks: { driver: false, valkey: true },
      });
    } finally {
      await controller.shutdown('test');
    }
  });

  it('SIGTERM drain: an in-flight request completes and shutdown finishes within the timeout', async () => {
    const audit = recordingAudit();
    const controller = await startSandboxController(await config({ SBX_DRAIN_TIMEOUT: '3s' }), {
      driverFactory: () => fakeDriver(),
      audit,
      internalRoutes: slowRoutes(400),
    });
    const inflight = fetch(`${base(controller)}/internal/sandboxes/slow`, {
      method: 'POST',
      headers: authHeader(),
      body: '{}',
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const started = Date.now();
    const result = await controller.shutdown('SIGTERM');
    const elapsed = Date.now() - started;
    const res = await inflight;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ done: true });
    expect(result.drained).toBe(true);
    expect(elapsed).toBeLessThan(3000);
    await expect(fetch(`${base(controller)}/healthz`)).rejects.toThrow();
    expect(audit.events.at(-1)).toMatchObject({
      type: 'sandbox_controller.stopped',
      signal: 'SIGTERM',
      drained: true,
    });
  });

  it('SIGTERM drain: a request slower than SBX_DRAIN_TIMEOUT is cut at the timeout', async () => {
    const controller = await startSandboxController(await config({ SBX_DRAIN_TIMEOUT: '300ms' }), {
      driverFactory: () => fakeDriver(),
      audit: recordingAudit(),
      internalRoutes: slowRoutes(5000),
    });
    const inflight = fetch(`${base(controller)}/internal/sandboxes/slow`, {
      method: 'POST',
      headers: authHeader(),
      body: '{}',
    }).catch((error: unknown) => error);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const started = Date.now();
    const result = await controller.shutdown('SIGTERM');
    expect(result.drained).toBe(false);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(await inflight).toBeInstanceOf(Error);
  });

  it('as a process: SIGTERM drains and exits 0', async () => {
    const port = await freePort();
    const child = spawn(process.execPath, ['--import', 'tsx', mainPath], {
      cwd: appDir,
      env: { ...process.env, ...rawEnv(port) },
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
    const exited = new Promise<number | null>((resolve) => child.once('exit', resolve));
    try {
      await vi.waitFor(
        async () => {
          expect((await fetch(`http://127.0.0.1:${String(port)}/healthz`)).status).toBe(200);
        },
        { timeout: 30_000, interval: 200 },
      );
      child.kill('SIGTERM');
      expect(await exited).toBe(0);
      expect(output).toContain('sbx.shutdown.complete');
      expect(output).toContain('sandbox_controller.started');
      expect(output).toContain('sandbox_controller.stopped');
      expect(output).not.toContain(SECRET);
    } finally {
      child.kill('SIGKILL');
    }
  }, 60_000);

  it('edge case: SIGKILL ends the process with no drain and no stopped event', async () => {
    const port = await freePort();
    const child = spawn(process.execPath, ['--import', 'tsx', mainPath], {
      cwd: appDir,
      env: { ...process.env, ...rawEnv(port) },
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
    const exited = new Promise<NodeJS.Signals | null>((resolve) =>
      child.once('exit', (_code, signal) => {
        resolve(signal);
      }),
    );
    await vi.waitFor(
      async () => {
        expect((await fetch(`http://127.0.0.1:${String(port)}/healthz`)).status).toBe(200);
      },
      { timeout: 30_000, interval: 200 },
    );
    child.kill('SIGKILL');
    expect(await exited).toBe('SIGKILL');
    expect(output).toContain('sandbox_controller.started');
    expect(output).not.toContain('sbx.shutdown.begin');
    expect(output).not.toContain('sandbox_controller.stopped');
  }, 60_000);

  it('edge case: missing SBX_IMAGE_DIGEST exits non-zero with a clear message and binds nothing', async () => {
    const port = await freePort();
    const child = spawn(process.execPath, ['--import', 'tsx', mainPath], {
      cwd: appDir,
      env: { ...process.env, ...rawEnv(port), SBX_IMAGE_DIGEST: '' },
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
    const code = await new Promise<number | null>((resolve) => child.once('exit', resolve));
    expect(code).toBe(78);
    expect(output).toContain('SBX_CONFIG_INVALID');
    expect(output).toContain('SBX_IMAGE_DIGEST');
    expect(output).not.toContain(SECRET);
    await expect(fetch(`http://127.0.0.1:${String(port)}/healthz`)).rejects.toThrow();
  }, 60_000);
});
