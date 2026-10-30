import { z } from 'zod';

import { sandboxPersonaSchema, sandboxResourcesSchema, SANDBOX_LIMITS } from '@blackwing/contracts';
import { ValidationError } from '@blackwing/errors';

import {
  DEFAULT_SANDBOX_CPU,
  DEFAULT_SANDBOX_MEMORY_MIB,
  DEFAULT_SANDBOX_PIDS,
  DEFAULT_SANDBOX_WORKSPACE_MIB,
  type SandboxControllerConfig,
} from '../config.js';

/**
 * Hardened sandbox spec builder (SANDBOX-007, CONTEXT_PACK §4.1 / §8.5). One shared config object is
 * the source of truth; `buildKubernetesHardening` and `buildDockerHardening` derive the driver fragments
 * from it, so the hardening is defined once and tested once. Applying the fragments is the drivers' job.
 *
 * Invariants encoded here:
 * - non-root, read-only rootfs, all capabilities dropped, no privilege escalation, never privileged;
 * - no swap (memory limit equals swap limit), tmpfs `/workspace` and `/tmp` only, never a host path;
 * - seccomp is always set to the bw-sandbox profile, never unconfined (fail closed on a missing profile
 *   is the driver's create failure, see the sandbox README);
 * - requested limits are clamped to the plan ceiling (never exceeded) and a zero workspace is refused.
 */

const BYTES_PER_MIB = 1_048_576;
const NANO_CPUS_PER_CORE = 1_000_000_000;
const TMP_SIZE_MIB = 256;

/** Static hardening values shared by both drivers. Changing one is a reviewed safety change. */
export const HARDENING = {
  /** The image's `bw` user (infra/docker/sandbox/Dockerfile, uid/gid 10001). Never 0. */
  user: { uid: 10_001, gid: 10_001 },
  /** Profile file name: the Kubernetes `localhostProfile` is relative to the kubelet seccomp root. */
  seccompProfileName: 'bw-sandbox.json',
  /** Absolute path of the profile on a Docker host (`seccomp=<path>`); see infra/docker/sandbox/README.md. */
  dockerSeccompPath: '/etc/bw/seccomp/bw-sandbox.json',
  workspacePath: '/workspace',
  tmpPath: '/tmp',
  tmpSizeMiB: TMP_SIZE_MIB,
} as const;

/** Resource values for one sandbox. */
export interface HardeningDefaults {
  readonly cpu: number;
  readonly memoryMiB: number;
  readonly pids: number;
  readonly workspaceMiB: number;
}

/** Plan maximum: a request above any of these values is clamped down to it, never allowed through. */
export type HardeningCeiling = HardeningDefaults;

/** Ceiling for the default plan. Per-plan ceilings are passed in by the caller when plans land. */
export const DEFAULT_PLAN_CEILING: HardeningCeiling = {
  cpu: 4,
  memoryMiB: 8192,
  pids: 4096,
  workspaceMiB: 4096,
};

/**
 * Deep-tier personas (CONTEXT_PACK §4.6) get more memory; everything else uses the default. Keyed by
 * persona key. A persona missing here simply uses the defaults.
 */
const DEEP_PERSONA_MEMORY_MIB = 4096;
const PERSONA_OVERRIDES: Readonly<Record<string, Partial<HardeningDefaults>>> = {
  orchestrator: { memoryMiB: DEEP_PERSONA_MEMORY_MIB },
  planner: { memoryMiB: DEEP_PERSONA_MEMORY_MIB },
  'source-spec-ingestion': { memoryMiB: DEEP_PERSONA_MEMORY_MIB },
  'web-api-specialist': { memoryMiB: DEEP_PERSONA_MEMORY_MIB },
  'auth-logic-specialist': { memoryMiB: DEEP_PERSONA_MEMORY_MIB },
  'code-specialist': { memoryMiB: DEEP_PERSONA_MEMORY_MIB },
  'exploit-developer': { memoryMiB: DEEP_PERSONA_MEMORY_MIB },
  'validator-assistant': { memoryMiB: DEEP_PERSONA_MEMORY_MIB },
  reporter: { memoryMiB: DEEP_PERSONA_MEMORY_MIB },
};

/** The one shared config object both builders read. */
export interface HardeningConfig {
  readonly defaults: HardeningDefaults;
  readonly personaOverrides: Readonly<Record<string, Partial<HardeningDefaults>>>;
  readonly ceiling: HardeningCeiling;
}

/** Builds the shared config from the controller environment (`SBX_CPU`, `SBX_MEM_MIB`, ...). */
export function hardeningConfigFrom(
  config: Pick<
    SandboxControllerConfig,
    'SBX_CPU' | 'SBX_MEM_MIB' | 'SBX_PIDS' | 'SBX_WORKSPACE_MIB'
  >,
  ceiling: HardeningCeiling = DEFAULT_PLAN_CEILING,
): HardeningConfig {
  return {
    defaults: {
      cpu: config.SBX_CPU,
      memoryMiB: config.SBX_MEM_MIB,
      pids: config.SBX_PIDS,
      workspaceMiB: config.SBX_WORKSPACE_MIB,
    },
    personaOverrides: PERSONA_OVERRIDES,
    ceiling,
  };
}

/** Defaults used when no environment is supplied (tests, tooling). Match the config defaults. */
export const BUILT_IN_HARDENING_CONFIG: HardeningConfig = {
  defaults: {
    cpu: DEFAULT_SANDBOX_CPU,
    memoryMiB: DEFAULT_SANDBOX_MEMORY_MIB,
    pids: DEFAULT_SANDBOX_PIDS,
    workspaceMiB: DEFAULT_SANDBOX_WORKSPACE_MIB,
  },
  personaOverrides: PERSONA_OVERRIDES,
  ceiling: DEFAULT_PLAN_CEILING,
};

/**
 * What a caller asks for. `resources` is what the worker requested for the sandbox; absent fields fall
 * back to the persona override, then the default. Strict: unknown keys are refused, so `privileged`,
 * capability add-backs and similar can never be passed in.
 */
const hardeningRequestSchema = z.strictObject({
  persona: sandboxPersonaSchema,
  resources: sandboxResourcesSchema.partial().optional(),
  workspaceMiB: z
    .number()
    .int()
    .min(1, 'workspace must be at least 1 MiB')
    .max(SANDBOX_LIMITS.maxMemoryMiB)
    .optional(),
});
export type HardeningRequest = z.input<typeof hardeningRequestSchema>;

export interface ResolvedHardening {
  readonly persona: string;
  readonly cpu: number;
  readonly memoryMiB: number;
  readonly pids: number;
  readonly workspaceMiB: number;
  /** Fields that exceeded the plan ceiling and were clamped down to it. */
  readonly clamped: readonly (keyof HardeningDefaults)[];
}

export interface HardeningOptions {
  readonly config: HardeningConfig;
  /** Receives a `warn` for every clamped value. Optional so pure callers need no logger. */
  readonly logger?: { warn: (fields: Record<string, unknown>, message: string) => void };
}

function parseRequest(input: unknown): z.output<typeof hardeningRequestSchema> {
  const parsed = hardeningRequestSchema.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError('sandbox hardening request is invalid', {
      detail: parsed.error.issues.map((issue) => issue.path.join('.')).join(', '),
    });
  }
  return parsed.data;
}

/**
 * Resolves the effective limits: request, then persona override, then defaults; then clamps each to the
 * plan ceiling. Pure apart from the optional warning log.
 */
export function resolveHardening(
  input: HardeningRequest,
  options: HardeningOptions,
): ResolvedHardening {
  const request = parseRequest(input);
  const { config } = options;
  const override = config.personaOverrides[request.persona] ?? {};
  const base: HardeningDefaults = {
    cpu: override.cpu ?? config.defaults.cpu,
    memoryMiB: override.memoryMiB ?? config.defaults.memoryMiB,
    pids: override.pids ?? config.defaults.pids,
    workspaceMiB: override.workspaceMiB ?? config.defaults.workspaceMiB,
  };
  const requested = request.resources ?? {};
  const wanted: HardeningDefaults = {
    cpu: requested.cpu ?? base.cpu,
    memoryMiB: requested.memoryMiB ?? base.memoryMiB,
    pids: requested.pids ?? base.pids,
    workspaceMiB: request.workspaceMiB ?? base.workspaceMiB,
  };
  if (wanted.workspaceMiB < 1) {
    throw new ValidationError('workspace size must be at least 1 MiB', {
      detail: 'workspaceMiB',
    });
  }

  const clamped: (keyof HardeningDefaults)[] = [];
  const value = (field: keyof HardeningDefaults): number => {
    const ask = wanted[field];
    const cap = config.ceiling[field];
    if (ask <= cap) return ask;
    clamped.push(field);
    options.logger?.warn(
      { persona: request.persona, field, requested: ask, ceiling: cap },
      'sandbox hardening value clamped to plan ceiling',
    );
    return cap;
  };

  return {
    persona: request.persona,
    cpu: value('cpu'),
    memoryMiB: value('memoryMiB'),
    pids: value('pids'),
    workspaceMiB: value('workspaceMiB'),
    clamped,
  };
}

/** Kubernetes pod fragment: `SecurityContext`, resource requests/limits and the tmpfs-backed volumes. */
export interface KubernetesHardening {
  readonly securityContext: {
    readonly runAsNonRoot: true;
    readonly runAsUser: number;
    readonly runAsGroup: number;
    readonly readOnlyRootFilesystem: true;
    readonly allowPrivilegeEscalation: false;
    readonly privileged: false;
    readonly capabilities: { readonly drop: readonly ['ALL'] };
    readonly seccompProfile: { readonly type: 'Localhost'; readonly localhostProfile: string };
  };
  readonly resources: {
    readonly requests: { readonly cpu: string; readonly memory: string };
    readonly limits: { readonly cpu: string; readonly memory: string };
  };
  readonly volumes: readonly {
    readonly name: string;
    readonly emptyDir: { readonly medium: 'Memory'; readonly sizeLimit: string };
  }[];
  readonly volumeMounts: readonly { readonly name: string; readonly mountPath: string }[];
  /** pids are enforced by the node's kubelet `podPidsLimit`, not a pod field; the value is carried here. */
  readonly pids: number;
}

export function buildKubernetesHardening(
  input: HardeningRequest,
  options: HardeningOptions,
): KubernetesHardening {
  const r = resolveHardening(input, options);
  const memory = `${String(r.memoryMiB)}Mi`;
  return {
    securityContext: {
      runAsNonRoot: true,
      runAsUser: HARDENING.user.uid,
      runAsGroup: HARDENING.user.gid,
      readOnlyRootFilesystem: true,
      allowPrivilegeEscalation: false,
      privileged: false,
      capabilities: { drop: ['ALL'] },
      seccompProfile: { type: 'Localhost', localhostProfile: HARDENING.seccompProfileName },
    },
    resources: {
      requests: { cpu: String(r.cpu), memory },
      limits: { cpu: String(r.cpu), memory },
    },
    volumes: [
      {
        name: 'workspace',
        emptyDir: { medium: 'Memory', sizeLimit: `${String(r.workspaceMiB)}Mi` },
      },
      { name: 'tmp', emptyDir: { medium: 'Memory', sizeLimit: `${String(TMP_SIZE_MIB)}Mi` } },
    ],
    volumeMounts: [
      { name: 'workspace', mountPath: HARDENING.workspacePath },
      { name: 'tmp', mountPath: HARDENING.tmpPath },
    ],
    pids: r.pids,
  };
}

/** Docker `HostConfig` fragment: the fields the Docker driver merges into its container config. */
export interface DockerHardening {
  readonly User: string;
  readonly ReadonlyRootfs: true;
  readonly CapDrop: readonly ['ALL'];
  readonly SecurityOpt: readonly ['no-new-privileges:true', string];
  readonly Privileged: false;
  readonly PidsLimit: number;
  readonly Memory: number;
  readonly MemorySwap: number;
  readonly NanoCpus: number;
  readonly Tmpfs: Readonly<Record<string, string>>;
}

export interface DockerHardeningOptions extends HardeningOptions {
  /** Absolute host path of the seccomp profile. Defaults to {@link HARDENING.dockerSeccompPath}. */
  readonly seccompProfilePath?: string;
}

const SECCOMP_PATH_RE = /^\/[^\0\n\r]*\.json$/;

export function buildDockerHardening(
  input: HardeningRequest,
  options: DockerHardeningOptions,
): DockerHardening {
  const seccompPath = options.seccompProfilePath ?? HARDENING.dockerSeccompPath;
  if (!SECCOMP_PATH_RE.test(seccompPath) || seccompPath.includes('unconfined')) {
    throw new ValidationError('seccomp profile path must be an absolute .json path', {
      detail: 'seccompProfilePath',
    });
  }
  const r = resolveHardening(input, options);
  const memory = r.memoryMiB * BYTES_PER_MIB;
  return {
    User: `${String(HARDENING.user.uid)}:${String(HARDENING.user.gid)}`,
    ReadonlyRootfs: true,
    CapDrop: ['ALL'],
    SecurityOpt: ['no-new-privileges:true', `seccomp=${seccompPath}`],
    Privileged: false,
    PidsLimit: r.pids,
    Memory: memory,
    MemorySwap: memory,
    NanoCpus: Math.round(r.cpu * NANO_CPUS_PER_CORE),
    Tmpfs: {
      [HARDENING.workspacePath]: `rw,noexec,nosuid,nodev,size=${String(r.workspaceMiB)}m`,
      [HARDENING.tmpPath]: `rw,noexec,nosuid,nodev,size=${String(TMP_SIZE_MIB)}m`,
    },
  };
}
