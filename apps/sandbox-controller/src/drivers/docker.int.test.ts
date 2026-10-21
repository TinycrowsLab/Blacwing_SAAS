import { execFileSync } from 'node:child_process';

import { afterAll, describe, expect, it } from 'vitest';

import { DockerDriver } from './docker.js';

import type { SandboxSpec } from '@blackwing/contracts';

/**
 * Integration against a real Docker daemon (SANDBOX-004). Gated by `SBX_IT=1`; needs the `runsc` runtime
 * (set `SBX_IT_RUNTIME=runc` on a gVisor-less dev host: the driver then asserts runc explicitly).
 * `SBX_IT_IMAGE` must name a digest-pinned image already present locally.
 */
const enabled = process.env.SBX_IT === '1';
const runtime = process.env.SBX_IT_RUNTIME ?? 'runsc';
const image = process.env.SBX_IT_IMAGE ?? '';

const TENANT = '01920000-0000-7000-8000-0000000000a1';
const RUN = '01920000-0000-7000-8000-0000000000a2';
const SANDBOX = '01920000-0000-7000-8000-0000000000a3';
const NETWORK = `bw-it-${RUN}`;

describe.skipIf(!enabled)('DockerDriver against a real daemon', () => {
  const driver = new DockerDriver({
    runtime,
    allowInsecureRuntime: runtime !== 'runsc',
  });

  afterAll(async () => {
    await driver.destroy(SANDBOX);
    await driver.close();
    try {
      execFileSync('docker', ['network', 'rm', NETWORK], { stdio: 'ignore' });
    } catch {
      // already gone
    }
  });

  it('creates a hardened container, is idempotent, and destroy removes it', async () => {
    execFileSync('docker', ['network', 'create', '--internal', NETWORK], { stdio: 'ignore' });
    const spec: SandboxSpec = {
      sandboxId: SANDBOX,
      runId: RUN,
      tenantId: TENANT,
      sessionId: '01920000-0000-7000-8000-0000000000a4',
      persona: 'active-recon',
      imageDigest: image,
      runtimeClass: 'gvisor',
      network: { runId: RUN, networkId: NETWORK },
      resources: { cpu: 0.5, memoryMiB: 128, pids: 64 },
      env: {},
      mounts: [{ kind: 'tmpfs', target: '/workspace', readOnly: false, sizeMiB: 16 }],
      ttlSeconds: 300,
      caBundleRef: 'openbao://pki/run/ca',
    };
    const handle = await driver.create(spec);
    expect((await driver.create(spec)).nativeId).toBe(handle.nativeId);

    const inspect = JSON.parse(
      execFileSync('docker', ['inspect', handle.nativeId], { encoding: 'utf8' }),
    ) as { HostConfig: { Runtime: string; ReadonlyRootfs: boolean; CapDrop: string[] } }[];
    expect(inspect[0]?.HostConfig).toMatchObject({
      Runtime: runtime,
      ReadonlyRootfs: true,
      CapDrop: ['ALL'],
    });

    await driver.destroy(SANDBOX);
    expect(await driver.list({ tenantId: TENANT, runId: RUN })).toEqual([]);
  });
});
