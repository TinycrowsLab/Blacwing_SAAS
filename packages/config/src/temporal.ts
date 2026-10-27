import { z } from 'zod';

import { AppError } from '@blackwing/errors';

import { zBool } from './coerce.js';

import type { EnvSource } from './env.js';

/** Development default for `TEMPORAL_ADDRESS` (the compose service name). Never applied in staging/prod. */
export const DEFAULT_TEMPORAL_ADDRESS = 'temporal:7233';
/** Default Temporal namespace for Blackwing workflows. */
export const DEFAULT_TEMPORAL_NAMESPACE = 'blackwing';

const MAX_PORT = 65_535;
/** `host:port`, `[ipv6]:port`; no scheme, no credentials, no path. */
const HOST_PORT = /^(?:[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?|\[[0-9A-Fa-f:.]+\]):(\d{1,5})$/;
/** Temporal namespace names: letters, digits, `-`, `_`, `.`; at most 255 characters. */
const NAMESPACE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/;

const address = z
  .string()
  .regex(HOST_PORT, 'must be host:port')
  .refine((value) => {
    const port = Number(HOST_PORT.exec(value)?.[1]);
    return port >= 1 && port <= MAX_PORT;
  }, 'port must be 1..65535');

/** An optional file path: unset or blank means "not provided". */
const optionalPath = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z.string().min(1).optional(),
);

/**
 * Temporal connection keys (WORKFLOW-001), with the development defaults the issue specifies.
 * Parse with {@link parseTemporalConfig}, which also refuses those defaults outside development/test.
 */
export const temporalEnvShape = {
  TEMPORAL_ADDRESS: address.default(DEFAULT_TEMPORAL_ADDRESS),
  TEMPORAL_NAMESPACE: z
    .string()
    .regex(NAMESPACE, 'must be a valid Temporal namespace name')
    .default(DEFAULT_TEMPORAL_NAMESPACE),
  TEMPORAL_TLS_ENABLED: zBool().default(false),
  /** Client certificate (PEM) path for mTLS. The file content is never read into config or logs. */
  TEMPORAL_CLIENT_CERT_PATH: optionalPath,
  /** Client private key (PEM) path for mTLS. */
  TEMPORAL_CLIENT_KEY_PATH: optionalPath,
} as const;

export const temporalConfigSchema = z.object(temporalEnvShape);
export type TemporalEnv = z.output<typeof temporalConfigSchema>;

/** Validated Temporal connection settings. */
export interface TemporalConfig {
  /** `host:port` of the Temporal frontend. */
  readonly address: string;
  readonly namespace: string;
  readonly tls: {
    readonly enabled: boolean;
    readonly clientCertPath?: string;
    readonly clientKeyPath?: string;
  };
}

const DEFAULTS_ALLOWED_IN = new Set(['development', 'test']);

function invalid(keys: readonly string[], why: string): AppError {
  // Key names only: never echo values (paths and addresses can embed deployment detail).
  return new AppError('TEMPORAL_CONFIG_INVALID', `Invalid Temporal configuration: ${why}`, {
    detail: `Invalid Temporal configuration for ${keys.join(', ')}`,
  });
}

/**
 * Parses and validates the Temporal environment. Fails closed:
 * - an invalid or blank `TEMPORAL_ADDRESS` or `TEMPORAL_NAMESPACE` throws `TEMPORAL_CONFIG_INVALID`;
 * - outside `NODE_ENV` development/test (including an unset `NODE_ENV`) the address and namespace
 *   must be set explicitly: a silent default must never point staging/production at a guess;
 * - `TEMPORAL_TLS_ENABLED=true` without both certificate paths throws `TEMPORAL_TLS_MISCONFIGURED`.
 */
export function parseTemporalConfig(source: EnvSource = process.env): TemporalConfig {
  const explicit = DEFAULTS_ALLOWED_IN.has(source.NODE_ENV ?? '');
  if (!explicit) {
    const missing = (['TEMPORAL_ADDRESS', 'TEMPORAL_NAMESPACE'] as const).filter(
      (key) => source[key] === undefined,
    );
    if (missing.length > 0) {
      throw invalid(
        missing,
        `${missing.join(', ')} must be set explicitly outside development/test`,
      );
    }
  }
  const parsed = temporalConfigSchema.safeParse(source);
  if (!parsed.success) {
    const keys = [
      ...new Set(parsed.error.issues.map((issue) => String(issue.path[0] ?? '(root)'))),
    ];
    throw invalid(keys, `${keys.join(', ')} failed validation`);
  }
  const env = parsed.data;
  if (env.TEMPORAL_TLS_ENABLED) {
    const absent = [
      ['TEMPORAL_CLIENT_CERT_PATH', env.TEMPORAL_CLIENT_CERT_PATH],
      ['TEMPORAL_CLIENT_KEY_PATH', env.TEMPORAL_CLIENT_KEY_PATH],
    ].filter(([, value]) => value === undefined);
    if (absent.length > 0) {
      const keys = absent.map(([key]) => String(key));
      throw new AppError(
        'TEMPORAL_TLS_MISCONFIGURED',
        `TEMPORAL_TLS_ENABLED=true requires ${keys.join(' and ')}`,
        { detail: `Temporal TLS is enabled but ${keys.join(', ')} is not set` },
      );
    }
  }
  return {
    address: env.TEMPORAL_ADDRESS,
    namespace: env.TEMPORAL_NAMESPACE,
    tls: {
      enabled: env.TEMPORAL_TLS_ENABLED,
      ...(env.TEMPORAL_CLIENT_CERT_PATH === undefined
        ? {}
        : { clientCertPath: env.TEMPORAL_CLIENT_CERT_PATH }),
      ...(env.TEMPORAL_CLIENT_KEY_PATH === undefined
        ? {}
        : { clientKeyPath: env.TEMPORAL_CLIENT_KEY_PATH }),
    },
  };
}
