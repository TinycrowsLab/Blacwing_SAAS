// Container lifecycle edge cases: slow boot (wait-for-ready timeout with logs), teardown leaves no
// container behind, and reuse is honoured in dev but forced off in CI.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { getContainerRuntimeClient, Wait } from 'testcontainers';
import { afterAll, describe, expect, it, vi } from 'vitest';

import { readTestEnv } from './env.js';
import { TEST_IMAGES } from './images.js';
import { ContainerStartError, ensureDockerAvailable, startContainer } from './runtime.js';
import { withValkey } from './valkey.js';

async function containerExists(id: string): Promise<boolean> {
  const client = await getContainerRuntimeClient();
  const listed = await client.container.list();
  return listed.some((c) => c.Id === id);
}

async function removeContainer(id: string): Promise<void> {
  const client = await getContainerRuntimeClient();
  const container = client.container.getById(id);
  await client.container.stop(container, { timeout: 0 }).catch(() => undefined);
  await client.container.remove(container, { removeVolumes: true }).catch(() => undefined);
}

describe('container runtime', () => {
  it('finds the Docker daemon', async () => {
    await expect(ensureDockerAvailable()).resolves.toBeUndefined();
  });

  it('times out a container that never becomes ready, with its logs in the error', async () => {
    const attempt = startContainer({
      service: 'valkey',
      image: TEST_IMAGES.valkey,
      ports: [6379],
      wait: Wait.forLogMessage(/this line is never printed/),
      reuse: false,
      startupTimeoutMs: 3_000,
    });
    const error: unknown = await attempt.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ContainerStartError);
    const startError = error as ContainerStartError;
    expect(startError.service).toBe('valkey');
    expect(startError.message).toMatch(/failed to start/);
    // The server did boot; only the readiness condition was impossible. Its output is surfaced.
    expect(startError.logs).toMatch(/Ready to accept connections/);
  });

  it('removes the container on stop (no leaked containers)', async () => {
    const valkey = await withValkey({ reuse: false });
    expect(await containerExists(valkey.containerId)).toBe(true);
    await valkey.stop();
    await valkey.stop(); // idempotent
    expect(await containerExists(valkey.containerId)).toBe(false);
  });

  describe('reuse', () => {
    // A private cache dir gives this test its own derived credentials, so its reusable container
    // has a unique configuration hash and never collides with another run on the same host.
    const cache = mkdtempSync(path.join(tmpdir(), 'bw-reuse-'));
    const started: string[] = [];
    afterAll(async () => {
      await Promise.all(started.map((id) => removeContainer(id)));
      rmSync(cache, { recursive: true, force: true });
    });

    it('reuses one container across calls in dev and never in CI', async () => {
      vi.stubEnv('XDG_CACHE_HOME', cache);
      // In CI reuse is forced off even when requested.
      const reuseExpected = !readTestEnv().CI;
      const first = await withValkey({ reuse: true });
      started.push(first.containerId);
      await first.client.set('k', 'first');
      await first.stop();
      const second = await withValkey({ reuse: true });
      started.push(second.containerId);
      try {
        expect({
          reused: [first.reused, second.reused],
          sameContainer: second.containerId === first.containerId,
        }).toEqual({ reused: [reuseExpected, reuseExpected], sameContainer: reuseExpected });
        // Isolation on a shared server: the first call's keys were removed and the prefix differs.
        expect(second.keyPrefix).not.toBe(first.keyPrefix);
        const raw = second.createClient();
        expect(await raw.get(`${first.keyPrefix}k`)).toBeNull();
      } finally {
        await second.stop();
      }
    });
  });
});
