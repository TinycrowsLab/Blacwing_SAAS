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
  zUrl,
} from '@blackwing/config';

import { SmConfigInvalidError } from './errors.js';

export const DEFAULT_MGMT_ADDR = ':7080';
const DEFAULT_MGMT_PORT = 7080;
export const DEFAULT_SESSION_TTL_SECONDS = 1800;
export const DEFAULT_OPENBAO_ADDR = 'http://openbao:8200';
/** `SM_DRAIN_TIMEOUT` default: 10s. */
export const DEFAULT_DRAIN_TIMEOUT_MS = 10_000;
export const DEFAULT_MAX_BODY_BYTES = 1_048_576;
/** HMAC key floor for both token classes: 32 characters. */
export const MIN_TOKEN_SECRET_LENGTH = 32;

const MAX_PORT = 65_535;
const MAX_SESSION_TTL_SECONDS = 86_400;
const MAX_BODY_BYTES_CEILING = 67_108_864;

/** A management listen address `host:port`; an empty host (`:7080`) means every interface of the pod. */
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

/** Environment of `apps/session-manager` (SESSION-001, #612). */
export const sessionManagerEnvShape = {
  ...baseEnvShape,
  /** Internal listener for injection (run network) and setup (control plane). Never a sandbox-facing address. */
  SM_MGMT_ADDR: listenAddress.default({ host: '0.0.0.0', port: DEFAULT_MGMT_PORT }),
  /** Validity window of a stored session, in seconds. */
  SM_SESSION_TTL_SECONDS: positiveInt(MAX_SESSION_TTL_SECONDS).default(DEFAULT_SESSION_TTL_SECONDS),
  /** Longest wait for in-flight requests on SIGTERM/SIGINT before connections are cut. */
  SM_DRAIN_TIMEOUT: zDurationMs()
    .refine((ms) => ms > 0, 'must be greater than zero')
    .default(DEFAULT_DRAIN_TIMEOUT_MS),
  /** Largest accepted JSON body; larger bodies are refused with 400 before any handler runs. */
  SM_MAX_BODY_BYTES: positiveInt(MAX_BODY_BYTES_CEILING).default(DEFAULT_MAX_BODY_BYTES),
  /** HMAC key for `bw_run_` tokens (one run, one tenant). Secret: never logged, never in the config hash. */
  SM_RUN_TOKEN_SECRET: z
    .string()
    .min(MIN_TOKEN_SECRET_LENGTH, `must be at least ${MIN_TOKEN_SECRET_LENGTH} characters`)
    .pipe(zSecret()),
  /** HMAC key for `bw_ctl_` control-plane tokens (setup and preflight, tenant-scoped). Secret. */
  SM_CONTROL_TOKEN_SECRET: z
    .string()
    .min(MIN_TOKEN_SECRET_LENGTH, `must be at least ${MIN_TOKEN_SECRET_LENGTH} characters`)
    .pipe(zSecret()),
  /** PostgreSQL (session store, SESSION-004). Secret: the URL carries the password. */
  DATABASE_URL: zSecretUrl({ protocols: ['postgres:', 'postgresql:'] }),
  /** Valkey (keep-alive scheduling, lockout counters). Secret: can carry a password. */
  VALKEY_URL: zSecretUrl({ protocols: ['redis:', 'rediss:'] }),
  /** OpenBao: credentials are resolved by reference through `@blackwing/secrets` (S8.7). */
  OPENBAO_ADDR: zUrl({ protocols: ['http:', 'https:'] }).default(DEFAULT_OPENBAO_ADDR),
  /** Commit reported by `sm_build_info`; set by the image build. */
  SM_BUILD_COMMIT: z
    .string()
    .regex(/^[A-Za-z0-9._-]{1,64}$/)
    .default('unknown'),
} as const;

export const sessionManagerEnvSchema = z.object(sessionManagerEnvShape);
export type SessionManagerConfig = z.output<typeof sessionManagerEnvSchema>;

/** Keys whose values never leave the process, not even hashed. */
const SECRET_KEYS: ReadonlySet<string> = new Set([
  'SM_RUN_TOKEN_SECRET',
  'SM_CONTROL_TOKEN_SECRET',
  'DATABASE_URL',
  'VALKEY_URL',
]);

/**
 * Parses and freezes the configuration. Throws {@link SmConfigInvalidError} (key names and reasons only,
 * never values) on bad input.
 */
export function loadSessionManagerConfig(source?: EnvSource): Readonly<SessionManagerConfig> {
  try {
    return loadConfig(sessionManagerEnvSchema, source);
  } catch (error) {
    if (isConfigValidationError(error)) {
      throw new SmConfigInvalidError(error.message, [...error.missingKeys, ...error.invalidKeys], {
        cause: error,
      });
    }
    throw error;
  }
}

/**
 * SHA-256 over the non-secret configuration (sorted keys), for the started/stopped audit events. Secret keys
 * contribute only the fact that they are set, so the hash reveals no value.
 */
export function configHash(config: Readonly<SessionManagerConfig>): string {
  const entries = Object.entries(config)
    .map(([key, value]): [string, unknown] => [
      key,
      SECRET_KEYS.has(key) ? value !== undefined : value,
    ])
    .sort(([a], [b]) => (a < b ? -1 : 1));
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex');
}
