import { Readable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import {
  SbxDriverUnavailableError,
  SbxImageMissingError,
  SbxRuntimeMissingError,
} from '../errors.js';
import { createDockerodeApi, type DockerApi, type DockerInspect } from './docker-api.js';
import {
  assertNoDockerSocket,
  type DockerContainerConfig,
  LABEL,
  renderContainerConfig,
  resolveFileMountSource,
} from './docker-config.js';
import { DockerDriver, demuxLogs } from './docker.js';
import { createDriver } from './index.js';

import type { SandboxDriver } from './driver.js';
import type { SandboxLifecycleEvent, SandboxSpec } from '@blackwing/contracts';

const TENANT = '01920000-0000-7000-8000-000000000001';
const OTHER_TENANT = '01920000-0000-7000-8000-00000000000f';
const RUN = '01920000-0000-7000-8000-000000000002';
const SESSION = '01920000-0000-7000-8000-000000000003';
const SANDBOX = '01920000-0000-7000-8000-000000000004';
const NOW = new Date('2026-10-20T10:00:00.000Z');
const DIGEST = `bw-sandbox@sha256:${'c'.repeat(64)}`;

function spec(overrides: Partial<SandboxSpec> = {}): SandboxSpec {
  return {
    sandboxId: SANDBOX,
    runId: RUN,
    tenantId: TENANT,
    sessionId: SESSION,
    persona: 'active-recon',
    imageDigest: DIGEST,
    runtimeClass: 'gvisor',
    network: { runId: RUN, networkId: `bw-run-${RUN}` },
    resources: { cpu: 0.5, memoryMiB: 512, pids: 128 },
    env: { FOO: 'bar' },
    mounts: [
      { kind: 'tmpfs', target: '/workspace', readOnly: false, sizeMiB: 64 },
      { kind: 'inputs', source: 'file:///srv/inputs', target: '/inputs', readOnly: true },
    ],
    ttlSeconds: 600,
    caBundleRef: 'openbao://pki/run/ca',
    ...overrides,
  };
}

class FakeEngine implements DockerApi {
  runtimeNames: string[] = ['runc', 'runsc'];
  images = new Set<string>([DIGEST]);
  pulled: string[] = [];
  down = false;
  created: DockerContainerConfig[] = [];
  removed: string[] = [];
  stopped: { id: string; grace: number }[] = [];
  killed: string[] = [];
  state: DockerInspect['State'] = { Status: 'created', Running: false };
  logBytes: Uint8Array[] = [];
  private readonly containers = new Map<string, DockerContainerConfig>();
  private seq = 0;

  private check(): void {
    if (this.down) throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
  }
  ping(): Promise<void> {
    this.check();
    return Promise.resolve();
  }
  runtimes(): Promise<readonly string[]> {
    this.check();
    return Promise.resolve(this.runtimeNames);
  }
  findByLabels(labels: readonly string[]): Promise<readonly string[]> {
    this.check();
    return Promise.resolve(
      [...this.containers]
        .filter(([, c]) =>
          labels.every((l) => {
            const [k = '', v = ''] = l.split('=');
            return c.Labels[k] === v;
          }),
        )
        .map(([id]) => id),
    );
  }
  createContainer(config: DockerContainerConfig): Promise<string> {
    this.check();
    this.seq += 1;
    const id = `c${String(this.seq)}`;
    this.containers.set(id, config);
    this.created.push(config);
    return Promise.resolve(id);
  }
  inspect(id: string): Promise<DockerInspect> {
    this.check();
    const c = this.containers.get(id);
    if (c === undefined)
      return Promise.reject(Object.assign(new Error('gone'), { statusCode: 404 }));
    return Promise.resolve({
      Id: id,
      Created: NOW.toISOString(),
      Config: { Labels: c.Labels },
      State: this.state,
      NetworkSettings: { Networks: { n: { IPAddress: '10.0.0.2' } } },
    });
  }
  start(): Promise<void> {
    this.check();
    return Promise.resolve();
  }
  stop(id: string, grace: number): Promise<void> {
    this.stopped.push({ id, grace });
    return Promise.resolve();
  }
  kill(id: string): Promise<void> {
    this.killed.push(id);
    return Promise.resolve();
  }
  remove(id: string): Promise<void> {
    this.check();
    this.removed.push(id);
    this.containers.delete(id);
    return Promise.resolve();
  }
  logs(): Promise<AsyncIterable<Uint8Array>> {
    const bytes = this.logBytes;
    return Promise.resolve(Readable.from(bytes));
  }
  imageExists(ref: string): Promise<boolean> {
    return Promise.resolve(this.images.has(ref));
  }
  pullImage(ref: string): Promise<void> {
    this.pulled.push(ref);
    this.images.add(ref);
    return Promise.resolve();
  }
  close(): void {
    // nothing to release
  }
}

function frame(stream: 1 | 2, text: string): Uint8Array {
  const body = Buffer.from(text);
  const head = Buffer.alloc(8);
  head[0] = stream;
  head.writeUInt32BE(body.length, 4);
  return Buffer.concat([head, body]);
}

function setup(extra: ConstructorParameters<typeof DockerDriver>[0] = {}) {
  const engine = new FakeEngine();
  const events: SandboxLifecycleEvent[] = [];
  const results: string[] = [];
  const driver = new DockerDriver({
    api: engine,
    now: () => NOW,
    onEvent: (e) => events.push(e),
    onCreate: (r) => results.push(r),
    ...extra,
  });
  return { engine, events, results, driver };
}

describe('renderContainerConfig', () => {
  it('maps the spec to a hardened runsc container config with the k8s label taxonomy', () => {
    const config = renderContainerConfig(spec(), {
      runtime: 'runsc',
      seccompProfile: '{"defaultAction":"SCMP_ACT_ERRNO"}',
      now: NOW,
      resolveMountSource: resolveFileMountSource,
    });
    expect(config.Image).toBe(DIGEST);
    expect(config.User).not.toMatch(/^(0|root)(:|$)/);
    expect(config.HostConfig).toMatchObject({
      Runtime: 'runsc',
      NetworkMode: `bw-run-${RUN}`,
      ReadonlyRootfs: true,
      CapDrop: ['ALL'],
      PidsLimit: 128,
      Memory: 512 * 1024 * 1024,
      NanoCpus: 500_000_000,
      Privileged: false,
      Binds: ['/srv/inputs:/inputs:ro'],
    });
    expect(config.HostConfig.SecurityOpt).toEqual([
      'no-new-privileges',
      'seccomp={"defaultAction":"SCMP_ACT_ERRNO"}',
    ]);
    expect(config.HostConfig.Tmpfs['/workspace']).toBe('rw,noexec,nosuid,size=64m');
    expect(config.Labels).toMatchObject({
      'bw.run-id': RUN,
      'bw.tenant-id': TENANT,
      'bw.session-id': SESSION,
      'bw.persona': 'active-recon',
      'bw.managed-by': 'blackwing-sandbox-controller',
      'bw.sandbox-id': SANDBOX,
      'bw.ttl-expires-at': '2026-10-20T10:10:00.000Z',
    });
    expect(config.Env).toEqual(['FOO=bar']);
  });

  it('adds a default tmpfs workspace when the spec has none', () => {
    const config = renderContainerConfig(spec({ mounts: [] }), {
      runtime: 'runsc',
      now: NOW,
      resolveMountSource: resolveFileMountSource,
    });
    expect(config.HostConfig.Tmpfs['/workspace']).toContain('noexec');
    expect(config.HostConfig.SecurityOpt).toEqual(['no-new-privileges']);
  });

  it.each([
    'file:///var/run/docker.sock',
    'file:///run/docker.sock',
    'file:///var/run',
    'file:///',
  ])('never binds the Docker socket or its directories (%s)', (source) => {
    const bad = spec({
      mounts: [
        {
          kind: 'source',
          source: source,
          target: '/src',
          readOnly: true,
        },
      ],
    });
    expect(() =>
      renderContainerConfig(bad, {
        runtime: 'runsc',
        now: NOW,
        resolveMountSource: resolveFileMountSource,
      }),
    ).toThrow(/refusing/);
  });

  it('rejects non-file mount sources and DOCKER_HOST in env', () => {
    const opts = { runtime: 'runsc', now: NOW, resolveMountSource: resolveFileMountSource };
    expect(() =>
      renderContainerConfig(
        spec({ mounts: [{ kind: 'ca', source: 'openbao://x/y', target: '/ca', readOnly: true }] }),
        opts,
      ),
    ).toThrow(/not bindable/);
    expect(() => renderContainerConfig(spec({ env: { DOCKER_HOST: 'unix:///x' } }), opts)).toThrow(
      /DOCKER_HOST/,
    );
  });

  it('a rendered config never contains a docker.sock string', () => {
    const config = renderContainerConfig(spec(), {
      runtime: 'runsc',
      now: NOW,
      resolveMountSource: resolveFileMountSource,
    });
    expect(JSON.stringify(config)).not.toContain('docker.sock');
    expect(() => {
      assertNoDockerSocket(config);
    }).not.toThrow();
  });
});

describe('DockerDriver.create', () => {
  it('creates a runsc container and records the event and metric', async () => {
    const { driver, engine, events, results } = setup();
    const handle = await driver.create(spec());
    expect(handle).toMatchObject({
      sandboxId: SANDBOX,
      tenantId: TENANT,
      driver: 'docker',
      status: 'created',
      ips: ['10.0.0.2'],
    });
    expect(engine.created[0]?.HostConfig.Runtime).toBe('runsc');
    expect(results).toEqual(['created']);
    expect(events.map((e) => e.type)).toEqual(['created']);
  });

  it('is idempotent by the bw.sandbox-id label', async () => {
    const { driver, engine, results } = setup();
    const a = await driver.create(spec());
    const b = await driver.create(spec());
    expect(b.nativeId).toBe(a.nativeId);
    expect(engine.created).toHaveLength(1);
    expect(results).toEqual(['created', 'existing']);
  });

  it('refuses a sandbox id owned by another tenant', async () => {
    const { driver } = setup();
    await driver.create(spec());
    await expect(driver.create(spec({ tenantId: OTHER_TENANT }))).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });

  it('fails fast with SBX_RUNTIME_MISSING and never falls back to runc', async () => {
    const { driver, engine, events } = setup();
    engine.runtimeNames = ['runc'];
    await expect(driver.create(spec())).rejects.toBeInstanceOf(SbxRuntimeMissingError);
    expect(engine.created).toHaveLength(0);
    expect(events[0]).toMatchObject({ type: 'failed' });
  });

  it('caches a successful runtime check', async () => {
    const { driver, engine } = setup();
    await driver.create(spec());
    engine.runtimeNames = [];
    await expect(
      driver.create(spec({ sandboxId: '01920000-0000-7000-8000-000000000005' })),
    ).resolves.toBeDefined();
  });

  it('refuses a non-runsc runtime unless explicitly allowed for dev/test', async () => {
    expect(() => new DockerDriver({ runtime: 'runc' })).toThrow(SbxRuntimeMissingError);
    const { driver, engine } = setup({ runtime: 'runc', allowInsecureRuntime: true });
    await driver.create(spec());
    expect(engine.created[0]?.HostConfig.Runtime).toBe('runc');
  });

  it('createDriver wires runc only outside production', () => {
    expect(
      createDriver('docker', { NODE_ENV: 'development', SBX_DOCKER_RUNTIME: 'runc' }).kind,
    ).toBe('docker');
    expect(() =>
      createDriver('docker', { NODE_ENV: 'production', SBX_DOCKER_RUNTIME: 'runc' }),
    ).toThrow(SbxRuntimeMissingError);
  });

  it('reports a missing image as a failed event when pulling is disabled', async () => {
    const { driver, engine, events } = setup();
    engine.images.clear();
    await expect(driver.create(spec())).rejects.toBeInstanceOf(SbxImageMissingError);
    expect(events[0]).toMatchObject({ type: 'failed' });
    expect(events[0]?.reason).toContain('pulling is disabled');
  });

  it('pulls a missing image when pulling is enabled', async () => {
    const { driver, engine } = setup({ pullMissingImages: true });
    engine.images.clear();
    await driver.create(spec());
    expect(engine.pulled).toEqual([DIGEST]);
  });

  it('fails closed with SBX_DRIVER_UNAVAILABLE when the daemon is unreachable', async () => {
    const { driver, engine, results } = setup();
    engine.down = true;
    await expect(driver.ping()).rejects.toBeInstanceOf(SbxDriverUnavailableError);
    await expect(driver.create(spec())).rejects.toBeInstanceOf(SbxDriverUnavailableError);
    expect(results).toEqual(['failed']);
  });

  it('rejects an invalid spec before touching the daemon', async () => {
    const { driver, engine } = setup();
    engine.down = true;
    await expect(driver.create({ ...spec(), persona: 'Bad Persona' })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });
});

describe('DockerDriver lifecycle', () => {
  it('health reports container state, HEALTHCHECK and OOM kills', async () => {
    const { driver, engine } = setup();
    await driver.create(spec());
    expect((await driver.health(SANDBOX)).state).toBe('unknown');
    engine.state = { Status: 'running', Running: true, Health: { Status: 'healthy' } };
    expect((await driver.health(SANDBOX)).state).toBe('healthy');
    engine.state = { Status: 'running', Running: true, Health: { Status: 'unhealthy' } };
    expect((await driver.health(SANDBOX)).state).toBe('unhealthy');
    engine.state = { Status: 'running', Running: true, Health: { Status: 'starting' } };
    expect((await driver.health(SANDBOX)).state).toBe('unknown');
    engine.state = { Status: 'exited', Running: false, OOMKilled: true, ExitCode: 137 };
    const oom = await driver.health(SANDBOX);
    expect(oom).toMatchObject({ state: 'unhealthy' });
    expect(oom.reason).toContain('137');
    const [handle] = await driver.list({ tenantId: TENANT });
    expect(handle?.status).toBe('failed');
  });

  it('start emits an event; unknown sandbox is not found', async () => {
    const { driver, events } = setup();
    await driver.create(spec());
    await driver.start(SANDBOX);
    expect(events.map((e) => e.type)).toEqual(['created', 'started']);
    await expect(driver.start('01920000-0000-7000-8000-0000000000aa')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('stop honours the grace period and kills at zero; stop of unknown resolves', async () => {
    const { driver, engine } = setup();
    await driver.create(spec());
    await driver.stop(SANDBOX, { graceSeconds: 5 });
    await driver.stop(SANDBOX, { graceSeconds: 0 });
    await driver.stop(SANDBOX, {});
    expect(engine.stopped.map((s) => s.grace)).toEqual([5, 10]);
    expect(engine.killed).toHaveLength(1);
    await expect(driver.stop('01920000-0000-7000-8000-0000000000aa', {})).resolves.toBeUndefined();
  });

  it('destroy force-removes, emits destroyed, and is idempotent', async () => {
    const { driver, engine, events } = setup();
    await driver.create(spec());
    await driver.destroy(SANDBOX);
    expect(engine.removed).toHaveLength(1);
    expect(events.at(-1)?.type).toBe('destroyed');
    await expect(driver.destroy(SANDBOX)).resolves.toBeUndefined();
    expect(engine.removed).toHaveLength(1);
  });

  it('list is tenant scoped and filters by status', async () => {
    const { driver } = setup();
    await driver.create(spec());
    expect(await driver.list({ tenantId: OTHER_TENANT })).toEqual([]);
    expect(await driver.list({ tenantId: TENANT, runId: RUN })).toHaveLength(1);
    expect(await driver.list({ tenantId: TENANT, status: ['running'] })).toEqual([]);
  });

  it('network provisioning is left to SANDBOX-006 and fails closed', async () => {
    const { driver } = setup();
    const asDriver: SandboxDriver = driver;
    await expect(asDriver.removeNetwork(RUN)).rejects.toBeInstanceOf(SbxDriverUnavailableError);
  });

  it('close is safe and the label constants stay stable', async () => {
    const { driver } = setup();
    await expect(driver.close()).resolves.toBeUndefined();
    expect(LABEL.sandboxId).toBe('bw.sandbox-id');
  });
});

describe('logs', () => {
  it('streams demultiplexed, timestamped lines from stdout and stderr', async () => {
    const { driver, engine } = setup();
    await driver.create(spec());
    engine.logBytes = [
      frame(1, '2026-10-20T10:00:01.000000000Z hello\n2026-10-20T10:00:02.000000000Z wor'),
      frame(2, '2026-10-20T10:00:03.000000000Z oops\n'),
      frame(1, 'ld\n'),
    ];
    const lines: { stream: string; line: string; at: string }[] = [];
    for await (const l of driver.logs(SANDBOX, { follow: false })) lines.push(l);
    expect(lines.map((l) => [l.stream, l.line])).toEqual([
      ['stdout', 'hello'],
      ['stderr', 'oops'],
      ['stdout', 'world'],
    ]);
    expect(lines[0]?.at).toBe('2026-10-20T10:00:01.000Z');
  });

  it('demuxLogs falls back to the clock for lines without a timestamp', async () => {
    const out: string[] = [];
    for await (const l of demuxLogs(Readable.from([frame(1, 'plain line\n')]), () =>
      NOW.toISOString(),
    )) {
      out.push(`${l.at}|${l.line}`);
    }
    expect(out).toEqual([`${NOW.toISOString()}|plain line`]);
  });

  it('rejects for an unreachable daemon', async () => {
    const { driver, engine } = setup();
    engine.down = true;
    engine.findByLabels = () =>
      Promise.reject(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }));
    await expect(async () => {
      const seen: unknown[] = [];
      for await (const l of driver.logs(SANDBOX, {})) seen.push(l);
    }).rejects.toBeInstanceOf(SbxDriverUnavailableError);
  });
});

describe('dockerode adapter', () => {
  it('is built lazily and never contacts the daemon until used', () => {
    expect(() => createDockerodeApi('/nonexistent/docker.sock')).not.toThrow();
    expect(new DockerDriver().kind).toBe('docker');
  });
});
