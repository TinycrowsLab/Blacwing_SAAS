import { describe, expect, expectTypeOf, it } from 'vitest';

import { FakeDriver, type SandboxDriver, UnavailableDriver } from './index.js';

import type { LogLine, RunNetworkSpec, SandboxSpec } from '@blackwing/contracts';

const TENANT = '01920000-0000-7000-8000-000000000001';
const OTHER_TENANT = '01920000-0000-7000-8000-00000000000f';
const RUN = '01920000-0000-7000-8000-000000000002';
const SESSION = '01920000-0000-7000-8000-000000000003';
const SANDBOX = '01920000-0000-7000-8000-000000000004';
const SANDBOX_2 = '01920000-0000-7000-8000-000000000006';
const MISSING = '01920000-0000-7000-8000-0000000000aa';
const NOW = new Date('2026-10-20T10:00:00.000Z');

const network: RunNetworkSpec = {
  runId: RUN,
  tenantId: TENANT,
  driver: 'docker',
  allowedDestinations: [{ kind: 'egress-gateway', host: 'egress-gateway', port: 13128 }],
};

function spec(overrides: Partial<SandboxSpec> = {}): SandboxSpec {
  return {
    sandboxId: SANDBOX,
    runId: RUN,
    tenantId: TENANT,
    sessionId: SESSION,
    persona: 'active-recon',
    imageDigest: `bw-sandbox@sha256:${'c'.repeat(64)}`,
    runtimeClass: 'runc',
    network: { runId: RUN, networkId: `bw-run-${RUN}` },
    resources: { cpu: 1, memoryMiB: 512, pids: 128 },
    env: {},
    mounts: [{ kind: 'tmpfs', target: '/workspace', readOnly: false }],
    ttlSeconds: 600,
    caBundleRef: 'openbao://pki/run/ca',
    ...overrides,
  };
}

function driver(): FakeDriver {
  return new FakeDriver({ now: () => NOW });
}

async function collect(lines: AsyncIterable<LogLine>): Promise<LogLine[]> {
  const out: LogLine[] = [];
  for await (const line of lines) {
    out.push(line);
  }
  return out;
}

describe('FakeDriver conforms to SandboxDriver', () => {
  it('is assignable to the interface', () => {
    expectTypeOf<FakeDriver>().toExtend<SandboxDriver>();
    expectTypeOf<UnavailableDriver>().toExtend<SandboxDriver>();
  });

  it('runs the full lifecycle and emits every lifecycle event', async () => {
    const d = driver();
    const net = await d.ensureNetwork(network);
    expect(net).toMatchObject({ runId: RUN, tenantId: TENANT, driver: 'docker' });
    expect(await d.ensureNetwork(network)).toEqual(net);

    const handle = await d.create(spec());
    expect(handle).toMatchObject({ sandboxId: SANDBOX, status: 'created', driver: 'docker' });
    expect(handle.createdAt).toBe(NOW.toISOString());
    expect(await d.create(spec())).toEqual(handle);

    await d.start(SANDBOX);
    expect(await d.health(SANDBOX)).toEqual({ state: 'healthy', checkedAt: NOW.toISOString() });

    d.appendLog(SANDBOX, { stream: 'stdout', line: 'one', at: '2026-10-20T09:00:00.000Z' });
    d.appendLog(SANDBOX, { stream: 'stderr', line: 'two' });
    d.appendLog(SANDBOX, { stream: 'stdout', line: 'three' });
    expect((await collect(d.logs(SANDBOX, {}))).map((l) => l.line)).toEqual([
      'one',
      'two',
      'three',
    ]);
    expect((await collect(d.logs(SANDBOX, { tailLines: 1 }))).map((l) => l.line)).toEqual([
      'three',
    ]);
    expect(
      (await collect(d.logs(SANDBOX, { since: NOW.toISOString() }))).map((l) => l.line),
    ).toEqual(['two', 'three']);

    expect(await d.list({ tenantId: TENANT, status: ['running'] })).toHaveLength(1);
    await d.stop(SANDBOX, { graceSeconds: 0, reason: 'kill switch' });
    await d.stop(SANDBOX, {});
    expect((await d.health(SANDBOX)).state).toBe('unhealthy');
    await d.destroy(SANDBOX);
    await d.destroy(SANDBOX);
    await d.removeNetwork(RUN);
    await d.removeNetwork(RUN);

    expect(d.events.map((e) => e.type)).toEqual([
      'created',
      'started',
      'healthy',
      'stopped',
      'destroyed',
    ]);
    expect(d.events.find((e) => e.type === 'stopped')?.reason).toBe('kill switch');
    await expect(d.start(SANDBOX)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('emits failed with a reason', async () => {
    const d = driver();
    await d.ensureNetwork(network);
    await d.create(spec());
    d.fail(SANDBOX, 'oom-killed');
    expect(d.events.at(-1)).toMatchObject({ type: 'failed', reason: 'oom-killed' });
    await expect(d.start(SANDBOX)).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});

describe('FakeDriver fails closed', () => {
  it('rejects an invalid spec without creating anything', async () => {
    const d = driver();
    await d.ensureNetwork(network);
    const bad = spec({
      mounts: [
        { kind: 'tmpfs', target: '/w', readOnly: false },
        { kind: 'tmpfs', target: '/w', readOnly: false },
      ],
    });
    await expect(d.create(bad)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(d.ensureNetwork({ ...network, allowedDestinations: [] })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    expect(await d.list({ tenantId: TENANT })).toEqual([]);
    expect(d.events).toEqual([]);
  });

  it('never echoes spec values in validation errors', async () => {
    const d = driver();
    await d.ensureNetwork(network);
    const secretish = '-----BEGIN PRIVATE KEY----- abc';
    const error: unknown = await d.create(spec({ env: { K: secretish } })).catch((e: unknown) => e);
    expect((error as Error).message).not.toContain('abc');
  });

  it('requires the run network to exist and belong to the same tenant (§8.6)', async () => {
    const d = driver();
    await expect(d.create(spec())).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await d.ensureNetwork(network);
    await expect(d.create(spec({ tenantId: OTHER_TENANT }))).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    await expect(d.ensureNetwork({ ...network, tenantId: OTHER_TENANT })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });

  it('list never crosses tenants', async () => {
    const d = driver();
    await d.ensureNetwork(network);
    await d.create(spec());
    await d.create(spec({ sandboxId: SANDBOX_2 }));
    expect(await d.list({ tenantId: TENANT, runId: RUN })).toHaveLength(2);
    expect(await d.list({ tenantId: OTHER_TENANT })).toEqual([]);
  });

  it('refuses to remove a network that still has live sandboxes', async () => {
    const d = driver();
    await d.ensureNetwork(network);
    await d.create(spec());
    await expect(d.removeNetwork(RUN)).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('rejects unknown ids and a driver-kind mismatch', async () => {
    const d = driver();
    await expect(d.health(MISSING)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(d.ensureNetwork({ ...network, driver: 'kubernetes' })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });

  it('rejects every operation while unreachable', async () => {
    const d = new FakeDriver({ reachable: false });
    await expect(d.ping()).rejects.toMatchObject({ code: 'SBX_DRIVER_UNAVAILABLE' });
    await expect(d.ensureNetwork(network)).rejects.toMatchObject({
      code: 'SBX_DRIVER_UNAVAILABLE',
    });
    await expect(d.create(spec())).rejects.toMatchObject({ code: 'SBX_DRIVER_UNAVAILABLE' });
    d.reachable = true;
    await expect(d.ping()).resolves.toBeUndefined();
  });
});

describe('UnavailableDriver', () => {
  it('rejects every operation with SBX_DRIVER_UNAVAILABLE', async () => {
    const d: SandboxDriver = new UnavailableDriver('kubernetes');
    const unavailable = { code: 'SBX_DRIVER_UNAVAILABLE' };
    await expect(d.ping()).rejects.toMatchObject(unavailable);
    await expect(d.ensureNetwork(network)).rejects.toMatchObject(unavailable);
    await expect(d.removeNetwork(RUN)).rejects.toMatchObject(unavailable);
    await expect(d.create(spec())).rejects.toMatchObject(unavailable);
    await expect(d.start(SANDBOX)).rejects.toMatchObject(unavailable);
    await expect(d.health(SANDBOX)).rejects.toMatchObject(unavailable);
    await expect(collect(d.logs(SANDBOX, {}))).rejects.toMatchObject(unavailable);
    await expect(d.stop(SANDBOX, {})).rejects.toMatchObject(unavailable);
    await expect(d.destroy(SANDBOX)).rejects.toMatchObject(unavailable);
    await expect(d.list({ tenantId: TENANT })).rejects.toMatchObject(unavailable);
    await expect(d.close()).resolves.toBeUndefined();
  });
});
