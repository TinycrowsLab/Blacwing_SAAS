import { SbxConfigInvalidError } from '../errors.js';

import type { SandboxSpec } from '@blackwing/contracts';

/** Labels mirroring the Kubernetes taxonomy (SANDBOX-003); `bw.sandbox-id` keys idempotent create. */
export const LABEL = {
  sandboxId: 'bw.sandbox-id',
  runId: 'bw.run-id',
  tenantId: 'bw.tenant-id',
  sessionId: 'bw.session-id',
  persona: 'bw.persona',
  managedBy: 'bw.managed-by',
  ttlExpiresAt: 'bw.ttl-expires-at',
  imageDigest: 'bw.image-digest',
  runtime: 'bw.runtime',
} as const;

const BYTES_PER_MIB = 1_048_576;
const MS_PER_SECOND = 1000;
const NANO_CPUS_PER_CORE = 1_000_000_000;

export const MANAGED_BY = 'blackwing-sandbox-controller';

/** Hardened defaults. SANDBOX-007 owns the final values; they live here so create stays one code path. */
const DOCKER_HARDENING = {
  user: '65532:65532',
  workspacePath: '/workspace',
  workspaceSizeMiB: 256,
  tmpfsOptions: 'noexec,nosuid',
} as const;

export interface DockerContainerConfig {
  Image: string;
  User: string;
  Env: string[];
  Labels: Record<string, string>;
  name: string;
  HostConfig: {
    Runtime: string;
    NetworkMode: string;
    ReadonlyRootfs: true;
    Tmpfs: Record<string, string>;
    Binds: string[];
    CapDrop: string[];
    SecurityOpt: string[];
    PidsLimit: number;
    Memory: number;
    MemorySwap: number;
    NanoCpus: number;
    Privileged: false;
    PublishAllPorts: false;
  };
}

export interface RenderOptions {
  readonly runtime: string;
  readonly seccompProfile?: string | undefined;
  readonly now: Date;
  /** Maps a mount `source` reference to an absolute host path; throws when it cannot. */
  readonly resolveMountSource: (ref: string) => string;
}

const SOCKET_RE = /(^|\/)(docker|containerd|podman|cri-dockerd)\.sock$/;
const FORBIDDEN_HOST_DIRS = new Set(['/', '/var/run', '/run', '/var/lib/docker']);

/** Default mount resolver: only `file:///abs/path` references are bindable. */
export function resolveFileMountSource(ref: string): string {
  const prefix = 'file://';
  if (!ref.startsWith(prefix)) {
    throw new SbxConfigInvalidError('mount source scheme is not bindable by the docker driver', [
      'mounts',
    ]);
  }
  return ref.slice(prefix.length);
}

/** Refuses any bind that exposes the container engine (§1.1: the Docker socket never enters a sandbox). */
export function assertNoDockerSocket(config: DockerContainerConfig): void {
  for (const bind of config.HostConfig.Binds) {
    const source = bind.split(':')[0] ?? '';
    const normalised = source.replace(/\/+$/, '') || '/';
    if (SOCKET_RE.test(normalised) || FORBIDDEN_HOST_DIRS.has(normalised)) {
      throw new SbxConfigInvalidError(
        'refusing to bind the container engine socket into a sandbox',
        ['mounts'],
      );
    }
  }
  for (const target of Object.keys(config.HostConfig.Tmpfs)) {
    if (SOCKET_RE.test(target)) {
      throw new SbxConfigInvalidError('refusing a socket path as tmpfs target', ['mounts']);
    }
  }
  if (config.Env.some((entry) => entry.startsWith('DOCKER_HOST='))) {
    throw new SbxConfigInvalidError('DOCKER_HOST must never reach a sandbox', ['env']);
  }
}

function containerName(sandboxId: string): string {
  return `bw-sbx-${sandboxId}`;
}

/** Pure `SandboxSpec` -> Docker container config. Never mounts the Docker socket; asserts it. */
export function renderContainerConfig(
  spec: SandboxSpec,
  opts: RenderOptions,
): DockerContainerConfig {
  const tmpfs: Record<string, string> = {};
  const binds: string[] = [];
  for (const mount of spec.mounts) {
    if (mount.kind === 'tmpfs') {
      const size = mount.sizeMiB ?? DOCKER_HARDENING.workspaceSizeMiB;
      tmpfs[mount.target] =
        `${mount.readOnly ? 'ro' : 'rw'},${DOCKER_HARDENING.tmpfsOptions},size=${String(size)}m`;
    } else {
      binds.push(`${opts.resolveMountSource(mount.source)}:${mount.target}:ro`);
    }
  }
  if (!(DOCKER_HARDENING.workspacePath in tmpfs)) {
    tmpfs[DOCKER_HARDENING.workspacePath] =
      `rw,${DOCKER_HARDENING.tmpfsOptions},size=${String(DOCKER_HARDENING.workspaceSizeMiB)}m`;
  }
  const memory = spec.resources.memoryMiB * BYTES_PER_MIB;
  const expires = new Date(opts.now.getTime() + spec.ttlSeconds * MS_PER_SECOND).toISOString();
  const securityOpt = ['no-new-privileges'];
  if (opts.seccompProfile !== undefined) securityOpt.push(`seccomp=${opts.seccompProfile}`);

  const config: DockerContainerConfig = {
    name: containerName(spec.sandboxId),
    Image: spec.imageDigest,
    User: DOCKER_HARDENING.user,
    Env: Object.entries(spec.env).map(([key, value]) => `${key}=${value}`),
    Labels: {
      [LABEL.sandboxId]: spec.sandboxId,
      [LABEL.runId]: spec.runId,
      [LABEL.tenantId]: spec.tenantId,
      [LABEL.sessionId]: spec.sessionId,
      [LABEL.persona]: spec.persona,
      [LABEL.managedBy]: MANAGED_BY,
      [LABEL.ttlExpiresAt]: expires,
      [LABEL.imageDigest]: spec.imageDigest,
      [LABEL.runtime]: opts.runtime,
    },
    HostConfig: {
      Runtime: opts.runtime,
      NetworkMode: spec.network.networkId,
      ReadonlyRootfs: true,
      Tmpfs: tmpfs,
      Binds: binds,
      CapDrop: ['ALL'],
      SecurityOpt: securityOpt,
      PidsLimit: spec.resources.pids,
      Memory: memory,
      MemorySwap: memory,
      NanoCpus: Math.round(spec.resources.cpu * NANO_CPUS_PER_CORE),
      Privileged: false,
      PublishAllPorts: false,
    },
  };
  assertNoDockerSocket(config);
  return config;
}
