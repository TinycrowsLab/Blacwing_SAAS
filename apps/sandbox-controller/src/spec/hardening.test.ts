import { describe, expect, it, vi } from 'vitest';

import { ValidationError } from '@blackwing/errors';

import { loadSandboxControllerConfig } from '../config.js';
import { SbxConfigInvalidError } from '../errors.js';
import {
  BUILT_IN_HARDENING_CONFIG,
  buildDockerHardening,
  buildKubernetesHardening,
  DEFAULT_PLAN_CEILING,
  type DockerHardeningOptions,
  HARDENING,
  type HardeningConfig,
  type HardeningDefaults,
  type HardeningRequest,
  hardeningConfigFrom,
  resolveHardening,
} from './hardening.js';

const config = BUILT_IN_HARDENING_CONFIG;
const BYTES_PER_MIB = 1_048_576;

function options(overrides: Partial<DockerHardeningOptions> = {}): DockerHardeningOptions {
  return { config, ...overrides };
}

function fakeLogger(): { warn: ReturnType<typeof vi.fn> } {
  return { warn: vi.fn() };
}

describe('buildKubernetesHardening', () => {
  it('sets the pod security context: non-root, read-only rootfs, no escalation, never privileged', () => {
    const k8s = buildKubernetesHardening({ persona: 'passive-recon' }, options());
    const sc = k8s.securityContext;
    expect(sc.runAsNonRoot).toBe(true);
    expect(sc.runAsUser).toBe(HARDENING.user.uid);
    expect(sc.runAsGroup).toBe(HARDENING.user.gid);
    expect(sc.runAsUser).not.toBe(0);
    expect(sc.readOnlyRootFilesystem).toBe(true);
    expect(sc.allowPrivilegeEscalation).toBe(false);
    expect(sc.privileged).toBe(false);
  });

  it('drops every capability and never adds one back', () => {
    const k8s = buildKubernetesHardening({ persona: 'passive-recon' }, options());
    expect(k8s.securityContext.capabilities).toEqual({ drop: ['ALL'] });
    expect(JSON.stringify(k8s)).not.toContain('"add"');
  });

  it('uses a Localhost seccomp profile and never unconfined', () => {
    const k8s = buildKubernetesHardening({ persona: 'passive-recon' }, options());
    expect(k8s.securityContext.seccompProfile).toEqual({
      type: 'Localhost',
      localhostProfile: 'bw-sandbox.json',
    });
    expect(JSON.stringify(k8s)).not.toContain('Unconfined');
  });

  it('sets cpu and memory requests and limits from the defaults', () => {
    const k8s = buildKubernetesHardening({ persona: 'passive-recon' }, options());
    expect(k8s.resources).toEqual({
      requests: { cpu: '1', memory: '2048Mi' },
      limits: { cpu: '1', memory: '2048Mi' },
    });
    expect(k8s.pids).toBe(512);
  });

  it('mounts /workspace and /tmp as memory-backed emptyDir volumes with a size limit', () => {
    const k8s = buildKubernetesHardening({ persona: 'passive-recon' }, options());
    expect(k8s.volumes).toContainEqual({
      name: 'workspace',
      emptyDir: { medium: 'Memory', sizeLimit: '1024Mi' },
    });
    expect(k8s.volumeMounts).toContainEqual({ name: 'workspace', mountPath: '/workspace' });
    expect(k8s.volumeMounts).toContainEqual({ name: 'tmp', mountPath: '/tmp' });
  });
});

describe('buildDockerHardening', () => {
  it('sets read-only rootfs, drops ALL, and runs as the non-root bw user', () => {
    const docker = buildDockerHardening({ persona: 'passive-recon' }, options());
    expect(docker.ReadonlyRootfs).toBe(true);
    expect(docker.CapDrop).toEqual(['ALL']);
    expect(docker.User).toBe('10001:10001');
    expect(docker.Privileged).toBe(false);
  });

  it('sets no-new-privileges and the seccomp profile path, never unconfined', () => {
    const docker = buildDockerHardening({ persona: 'passive-recon' }, options());
    expect(docker.SecurityOpt).toEqual([
      'no-new-privileges:true',
      `seccomp=${HARDENING.dockerSeccompPath}`,
    ]);
    expect(JSON.stringify(docker)).not.toContain('unconfined');
  });

  it('disables swap (memory-swap equals memory) and sets pids and cpu limits', () => {
    const docker = buildDockerHardening({ persona: 'passive-recon' }, options());
    expect(docker.Memory).toBe(2048 * BYTES_PER_MIB);
    expect(docker.MemorySwap).toBe(docker.Memory);
    expect(docker.PidsLimit).toBe(512);
    expect(docker.NanoCpus).toBe(1_000_000_000);
  });

  it('mounts a noexec,nosuid,nodev tmpfs /workspace sized from the defaults', () => {
    const docker = buildDockerHardening({ persona: 'passive-recon' }, options());
    expect(docker.Tmpfs['/workspace']).toBe('rw,noexec,nosuid,nodev,size=1024m');
    expect(docker.Tmpfs['/tmp']).toBe('rw,noexec,nosuid,nodev,size=256m');
  });

  it('uses a caller-supplied absolute seccomp profile path', () => {
    const docker = buildDockerHardening(
      { persona: 'passive-recon' },
      options({ seccompProfilePath: '/opt/bw/seccomp/custom.json' }),
    );
    expect(docker.SecurityOpt).toContain('seccomp=/opt/bw/seccomp/custom.json');
  });

  it.each([
    ['a relative path', 'seccomp/bw-sandbox.json'],
    ['a path without .json', '/etc/bw/seccomp/bw-sandbox'],
    ['the unconfined keyword', '/etc/unconfined.json'],
    ['an empty path', ''],
    ['a path with a newline', '/etc/bw/x\n.json'],
  ])('refuses %s as the seccomp profile (fail closed)', (_label, seccompProfilePath) => {
    expect(() =>
      buildDockerHardening({ persona: 'passive-recon' }, options({ seccompProfilePath })),
    ).toThrow(ValidationError);
  });
});

describe('defaults and per-persona overrides', () => {
  it('uses the defaults for a standard persona with no request', () => {
    const r = resolveHardening({ persona: 'passive-recon' }, options());
    expect(r).toEqual({
      persona: 'passive-recon',
      cpu: 1,
      memoryMiB: 2048,
      pids: 512,
      workspaceMiB: 1024,
      clamped: [],
    });
  });

  it('gives deep personas more memory', () => {
    const r = resolveHardening({ persona: 'web-api-specialist' }, options());
    expect(r.memoryMiB).toBe(4096);
    expect(r.cpu).toBe(1);
    expect(r.pids).toBe(512);
  });

  it('lets an explicit request win over the persona override', () => {
    const r = resolveHardening(
      { persona: 'web-api-specialist', resources: { memoryMiB: 3000 } },
      options(),
    );
    expect(r.memoryMiB).toBe(3000);
  });

  it('applies a partial resource request on top of the defaults', () => {
    const r = resolveHardening({ persona: 'passive-recon', resources: { cpu: 0.5 } }, options());
    expect(r.cpu).toBe(0.5);
    expect(r.memoryMiB).toBe(2048);
  });

  it('uses a custom shared config for every builder', () => {
    const defaults: HardeningDefaults = { cpu: 2, memoryMiB: 512, pids: 64, workspaceMiB: 128 };
    const custom: HardeningConfig = { ...config, defaults };
    const k8s = buildKubernetesHardening({ persona: 'passive-recon' }, { config: custom });
    const docker = buildDockerHardening({ persona: 'passive-recon' }, { config: custom });
    expect(k8s.resources.limits).toEqual({ cpu: '2', memory: '512Mi' });
    expect(docker.PidsLimit).toBe(64);
    expect(docker.Tmpfs['/workspace']).toBe('rw,noexec,nosuid,nodev,size=128m');
  });

  it('reads the defaults from the controller environment', () => {
    const env = loadSandboxControllerConfig({
      NODE_ENV: 'test',
      SBX_IMAGE_DIGEST: `ghcr.io/tinycrows/bw-sandbox@sha256:${'a'.repeat(64)}`,
      SBX_RUN_TOKEN_SECRET: 'k'.repeat(48),
      VALKEY_URL: 'redis://127.0.0.1:16379/0',
      SBX_CPU: '2.5',
      SBX_MEM_MIB: '3072',
      SBX_PIDS: '256',
      SBX_WORKSPACE_MIB: '512',
    });
    const fromEnv = hardeningConfigFrom(env);
    expect(fromEnv.defaults).toEqual({ cpu: 2.5, memoryMiB: 3072, pids: 256, workspaceMiB: 512 });
    expect(fromEnv.ceiling).toEqual(DEFAULT_PLAN_CEILING);
  });
});

describe('plan ceiling clamp', () => {
  it('clamps a memory request above the plan maximum and logs a warning', () => {
    const logger = fakeLogger();
    const r = resolveHardening(
      { persona: 'passive-recon', resources: { memoryMiB: 16_000 } },
      options({ logger }),
    );
    expect(r.memoryMiB).toBe(DEFAULT_PLAN_CEILING.memoryMiB);
    expect(r.clamped).toEqual(['memoryMiB']);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ field: 'memoryMiB', requested: 16_000, ceiling: 8192 }),
      expect.any(String),
    );
  });

  it('clamps cpu, pids and workspace independently', () => {
    const r = resolveHardening(
      {
        persona: 'passive-recon',
        resources: { cpu: 8, pids: 9999 },
        workspaceMiB: 5000,
      },
      options(),
    );
    expect(r.cpu).toBe(DEFAULT_PLAN_CEILING.cpu);
    expect(r.pids).toBe(DEFAULT_PLAN_CEILING.pids);
    expect(r.workspaceMiB).toBe(DEFAULT_PLAN_CEILING.workspaceMiB);
    expect(r.clamped).toEqual(['cpu', 'pids', 'workspaceMiB']);
  });

  it('never exceeds the ceiling in the emitted fragments', () => {
    const k8s = buildKubernetesHardening(
      { persona: 'passive-recon', resources: { memoryMiB: 65_536 } },
      options(),
    );
    expect(k8s.resources.limits.memory).toBe(`${String(DEFAULT_PLAN_CEILING.memoryMiB)}Mi`);
    const docker = buildDockerHardening(
      { persona: 'passive-recon', resources: { memoryMiB: 65_536 } },
      options(),
    );
    expect(docker.Memory).toBe(DEFAULT_PLAN_CEILING.memoryMiB * BYTES_PER_MIB);
  });

  it('refuses a request beyond the contract hard bound instead of clamping it', () => {
    expect(() =>
      resolveHardening({ persona: 'passive-recon', workspaceMiB: 99_999 }, options()),
    ).toThrow(ValidationError);
  });

  it('does not warn when every value is within the ceiling', () => {
    const logger = fakeLogger();
    const r = resolveHardening({ persona: 'passive-recon' }, options({ logger }));
    expect(r.clamped).toEqual([]);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

describe('edge cases and refusals', () => {
  it('refuses a zero workspace (the agent needs room to work)', () => {
    expect(() =>
      buildDockerHardening({ persona: 'passive-recon', workspaceMiB: 0 }, options()),
    ).toThrow(ValidationError);
    expect(() =>
      buildKubernetesHardening({ persona: 'passive-recon', workspaceMiB: 0 }, options()),
    ).toThrow(ValidationError);
  });

  it('refuses a zero or negative resource request', () => {
    expect(() =>
      resolveHardening({ persona: 'passive-recon', resources: { memoryMiB: 0 } }, options()),
    ).toThrow(ValidationError);
    expect(() =>
      resolveHardening({ persona: 'passive-recon', resources: { pids: -1 } }, options()),
    ).toThrow(ValidationError);
  });

  it('refuses a malformed persona key', () => {
    expect(() => resolveHardening({ persona: 'Bad Persona' }, options())).toThrow(ValidationError);
  });

  it('refuses a privileged request at compile time and at runtime', () => {
    // @ts-expect-error privileged is not a hardening input; the type rejects it
    const literal: HardeningRequest = { persona: 'passive-recon', privileged: true };
    expect(() => resolveHardening(literal, options())).toThrow(ValidationError);
    const smuggled = { persona: 'passive-recon', privileged: true } as unknown as HardeningRequest;
    expect(() => buildDockerHardening(smuggled, options())).toThrow(ValidationError);
  });

  it('refuses capability add-backs passed in the request', () => {
    const smuggled = {
      persona: 'passive-recon',
      capabilities: { add: ['SYS_ADMIN'] },
    } as unknown as HardeningRequest;
    expect(() => buildKubernetesHardening(smuggled, options())).toThrow(ValidationError);
  });

  it('is never privileged or capability-adding in any output', () => {
    const docker = buildDockerHardening({ persona: 'exploit-developer' }, options());
    const k8s = buildKubernetesHardening({ persona: 'exploit-developer' }, options());
    expect(docker.Privileged).toBe(false);
    expect(k8s.securityContext.privileged).toBe(false);
    expect(docker.CapDrop).toEqual(['ALL']);
    expect(k8s.securityContext.capabilities.drop).toEqual(['ALL']);
  });

  it('keeps an invalid environment out of the builders (config refuses it first)', () => {
    expect(() =>
      loadSandboxControllerConfig({
        NODE_ENV: 'test',
        SBX_IMAGE_DIGEST: `ghcr.io/tinycrows/bw-sandbox@sha256:${'a'.repeat(64)}`,
        SBX_RUN_TOKEN_SECRET: 'k'.repeat(48),
        VALKEY_URL: 'redis://127.0.0.1:16379/0',
        SBX_WORKSPACE_MIB: '0',
      }),
    ).toThrow(SbxConfigInvalidError);
  });
});
