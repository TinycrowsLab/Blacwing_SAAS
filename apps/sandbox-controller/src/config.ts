import { createHash } from 'node:crypto';

import { z } from 'zod';

import {
  baseEnvShape,
  type EnvSource,
  isConfigValidationError,
  loadConfig,
  zDurationMs,
  zSecret,
  zSecretUrl,
} from '@blackwing/config';
import { SANDBOX_DRIVER_KINDS, SANDBOX_LIMITS } from '@blackwing/contracts';

import { SbxConfigInvalidError } from './errors.js';

/** Same list as the shared contract, so config and driver kinds can never drift. */
export const SANDBOX_DRIVERS = SANDBOX_DRIVER_KINDS;
export type SandboxDriverKind = (typeof SANDBOX_DRIVERS)[number];

export const DEFAULT_MGMT_ADDR = ':7070';
const DEFAULT_MGMT_PORT = 7070;
export const DEFAULT_TTL_SECONDS = 3600;
/** Per-sandbox sizing defaults (SANDBOX-007). Persona overrides and plan ceilings live in `spec/hardening.ts`. */
export const DEFAULT_SANDBOX_CPU = 1;
export const DEFAULT_SANDBOX_MEMORY_MIB = 2048;
export const DEFAULT_SANDBOX_PIDS = 512;
export const DEFAULT_SANDBOX_WORKSPACE_MIB = 1024;
/** `SBX_DRAIN_TIMEOUT` default: 10s. */
export const DEFAULT_DRAIN_TIMEOUT_MS = 10_000;
export const DEFAULT_MAX_BODY_BYTES = 1_048_576;
/** HMAC key floor: 32 characters (the dev bootstrap generates 48 hex characters). */
export const MIN_RUN_TOKEN_SECRET_LENGTH = 32;

/**
 * CNIs that enforce NetworkPolicy on the cluster (SANDBOX-005). Calico on EC2 nodes; kube-router is the
 * controller embedded in k3s on the dev host (flannel + `disable-network-policy` unset).
 */
export const NETPOL_ENFORCERS = ['calico', 'cilium', 'kube-router'] as const;
export type NetpolEnforcer = (typeof NETPOL_ENFORCERS)[number];

const MAX_PORT = 65_535;
const MAX_TTL_SECONDS = 86_400;
const MAX_BODY_BYTES_CEILING = 67_108_864;
const MAX_SOCKET_PATH = 256;
const DNS_LABEL_MAX = 63;

/** A management listen address `host:port`; an empty host (`:7070`) means every interface of the controller pod. */
export interface ListenAddress {
  readonly host: string;
  readonly port: number;
}

const listenAddress = z
  .string()
  .regex(/^(?:\[[0-9a-fA-F:.]+\]|[A-Za-z0-9.-]*):[0-9]{1,5}$/, 'must be host:port or :port')
  .transform((value, ctx): ListenAddress => {
    const split = value.lastIndexOf(':');
    const rawHost = value.slice(0, split);
    const port = Number(value.slice(split + 1));
    if (!Number.isInteger(port) || port < 1 || port > MAX_PORT) {
      ctx.addIssue({ code: 'custom', message: 'port must be 1-65535' });
      return z.NEVER;
    }
    const host = rawHost === '' ? '0.0.0.0' : rawHost.replace(/^\[(.*)\]$/, '$1');
    return { host, port };
  });

const positiveInt = (max: number): z.ZodType<number, string> =>
  z
    .string()
    .regex(/^[1-9][0-9]{0,9}$/, 'must be a positive integer')
    .transform(Number)
    .refine((n) => n <= max, `must be at most ${max}`);

const dnsLabel = z
  .string()
  .max(DNS_LABEL_MAX)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, 'must be a lowercase RFC 1123 label');

/**
 * Sandbox image, pinned by digest (§8.9: runs never float). A tag-only reference is refused.
 * Example: `ghcr.io/tinycrows/bw-sandbox@sha256:<64 hex>`.
 */
const imageDigest = z
  .string()
  .regex(
    /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\.[a-z0-9-]+)*(?::[0-9]{1,5})?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+@sha256:[a-f0-9]{64}$/,
    'must be an image reference pinned by @sha256 digest',
  );

/** Environment of `apps/sandbox-controller` (SANDBOX-001, #448). */
export const sandboxControllerEnvShape = {
  ...baseEnvShape,
  /** Management (internal control-plane) listener. Never the sandbox-facing interface. */
  SBX_MGMT_ADDR: listenAddress.default({ host: '0.0.0.0', port: DEFAULT_MGMT_PORT }),
  SBX_DRIVER: z.enum(SANDBOX_DRIVERS).default('kubernetes'),
  SBX_NAMESPACE: dnsLabel.default('bw-runs'),
  SBX_RUNTIME_CLASS: dnsLabel.default('gvisor'),
  /**
   * The CNI that enforces NetworkPolicy on the kubernetes driver's cluster (SANDBOX-005). Unset means no
   * enforcement is declared, so the driver refuses to provision run networks (SBX_NETPOL_UNSUPPORTED).
   * OFFLINE-STUB(online-porting #909): the declared enforcer is trusted, not probed on the live cluster yet.
   */
  SBX_NETPOL_ENFORCER: z.enum(NETPOL_ENFORCERS).optional(),
  SBX_IMAGE_DIGEST: imageDigest,
  /** DockerDriver OCI runtime. `runsc` (gVisor) always; `runc` is refused when NODE_ENV=production. */
  SBX_DOCKER_RUNTIME: z.enum(['runsc', 'runc']).default('runsc'),
  /** Docker Engine socket the controller (and only the controller) talks to. */
  SBX_DOCKER_SOCKET: z
    .string()
    .startsWith('/')
    .max(MAX_SOCKET_PATH)
    .default('/var/run/docker.sock'),
  /** Pull a digest-pinned sandbox image that is absent locally (off: fail the create). */
  SBX_DOCKER_PULL: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  SBX_TTL_SECONDS: positiveInt(MAX_TTL_SECONDS).default(DEFAULT_TTL_SECONDS),
  /** Default CPU cores per sandbox (fractional allowed); per-request and per-persona values override it. */
  SBX_CPU: z
    .string()
    .regex(/^(?:0?\.[0-9]+|[1-9][0-9]*(?:\.[0-9]+)?)$/, 'must be a positive number of cores')
    .transform(Number)
    .refine(
      (cpu) => cpu <= SANDBOX_LIMITS.maxCpu,
      `must be at most ${String(SANDBOX_LIMITS.maxCpu)}`,
    )
    .default(DEFAULT_SANDBOX_CPU),
  /** Default memory per sandbox in MiB. */
  SBX_MEM_MIB: positiveInt(SANDBOX_LIMITS.maxMemoryMiB).default(DEFAULT_SANDBOX_MEMORY_MIB),
  /** Default process (pids) limit per sandbox. */
  SBX_PIDS: positiveInt(SANDBOX_LIMITS.maxPids).default(DEFAULT_SANDBOX_PIDS),
  /** Size of the /workspace tmpfs in MiB; zero is refused because the agent needs room to work. */
  SBX_WORKSPACE_MIB: positiveInt(SANDBOX_LIMITS.maxMemoryMiB).default(
    DEFAULT_SANDBOX_WORKSPACE_MIB,
  ),
  /** Longest wait for in-flight requests on SIGTERM/SIGINT before connections are cut. */
  SBX_DRAIN_TIMEOUT: zDurationMs()
    .refine((ms) => ms > 0, 'must be greater than zero')
    .default(DEFAULT_DRAIN_TIMEOUT_MS),
  /** Largest accepted JSON body; larger bodies are refused with 400 before any handler runs. */
  SBX_MAX_BODY_BYTES: positiveInt(MAX_BODY_BYTES_CEILING).default(DEFAULT_MAX_BODY_BYTES),
  /** HMAC key that verifies `bw_run_` run-scoped tokens. Secret: never logged, never in the config hash. */
  SBX_RUN_TOKEN_SECRET: z
    .string()
    .min(MIN_RUN_TOKEN_SECRET_LENGTH, `must be at least ${MIN_RUN_TOKEN_SECRET_LENGTH} characters`)
    .pipe(zSecret()),
  /** Valkey (Redis protocol) URL; secret because it can carry a password. */
  VALKEY_URL: zSecretUrl({ protocols: ['redis:', 'rediss:'] }),
  /** Commit reported by `sbx_build_info`; set by the image build. */
  SBX_BUILD_COMMIT: z
    .string()
    .regex(/^[A-Za-z0-9._-]{1,64}$/)
    .default('unknown'),
} as const;

export const sandboxControllerEnvSchema = z.object(sandboxControllerEnvShape);
export type SandboxControllerConfig = z.output<typeof sandboxControllerEnvSchema>;

/** Keys whose values never leave the process, not even hashed. */
const SECRET_KEYS: ReadonlySet<string> = new Set(['SBX_RUN_TOKEN_SECRET', 'VALKEY_URL']);

/**
 * Parses and freezes the controller configuration. Throws {@link SbxConfigInvalidError} (key names and
 * reasons only, never values) on bad input.
 */
export function loadSandboxControllerConfig(source?: EnvSource): Readonly<SandboxControllerConfig> {
  try {
    return loadConfig(sandboxControllerEnvSchema, source);
  } catch (error) {
    if (isConfigValidationError(error)) {
      throw new SbxConfigInvalidError(error.message, [...error.missingKeys, ...error.invalidKeys], {
        cause: error,
      });
    }
    throw error;
  }
}

/**
 * SHA-256 over the non-secret configuration (sorted keys), for the started/stopped audit events.
 * Secret keys contribute only the fact that they are set, so the hash reveals no value.
 */
export function configHash(config: Readonly<SandboxControllerConfig>): string {
  const entries = Object.entries(config)
    .map(([key, value]): [string, unknown] => [
      key,
      SECRET_KEYS.has(key) ? value !== undefined : value,
    ])
    .sort(([a], [b]) => (a < b ? -1 : 1));
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex');
}
