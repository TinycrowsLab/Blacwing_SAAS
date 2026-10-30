import { AppError } from '@blackwing/errors';

import { isSecretKey } from '../redact.js';

import type { AuditExportKind } from './ports.js';
import type { AuditEvent } from '@blackwing/contracts';

/**
 * The connector seam of the SIEM export framework (AUDIT-004, CONTEXT_PACK §8.8). A connector knows one
 * destination kind (syslog over TLS, Splunk HEC, HMAC-signed webhook, S3 object drops; the concrete ones are
 * AUDIT-009..012). The dispatcher owns the cursor, the batching and the filters; a connector only parses its
 * config, proves the destination reachable and delivers a batch in order.
 */

/** The configuration a connector accepts is parsed by `validate` and is never a credential (see below). */
export interface SiemTarget<C> {
  /** The parsed, validated, non-secret configuration of the subscription. */
  readonly config: C;
  /** The credential resolved from `secret_ref` for this delivery only. Never stored or logged. */
  readonly secret: string;
}

/** What a successful `deliver` confirms: every event with `seq <= deliveredThrough` is at the destination. */
export interface SiemDeliveryResult {
  readonly deliveredThrough: number;
}

export interface SiemConnector<C = unknown> {
  readonly kind: AuditExportKind;
  /** The largest batch the destination accepts; the dispatcher chunks to this (`Infinity` is not allowed). */
  readonly maxBatchSize: number;
  /** Parses the subscription config; throws {@link SiemConfigError} for an invalid or secret-bearing config. */
  validate(config: unknown): C;
  /** Proves the destination reachable with `secret`. Throws on failure. */
  testConnection(config: C, secret: string): Promise<void>;
  /**
   * Delivers `batch` (ascending `seq`, one tenant, already filtered). At-least-once: a duplicate after a crash is
   * possible, so each event carries its stable `id` and `seq` for SIEM-side de-duplication.
   */
  deliver(batch: readonly AuditEvent[], target: SiemTarget<C>): Promise<SiemDeliveryResult>;
}

/** A subscription config failed its connector's validation (`VALIDATION_FAILED`, 422). Names keys, never values. */
export class SiemConfigError extends AppError {
  constructor(message: string) {
    super('VALIDATION_FAILED', message);
  }
}

/**
 * Keys that name a credential in a connector config. Shared secret-key rules, plus any key ending in `token`
 * (an HEC or API token is a credential even when the key is not the bare word): `tokenId` and `tokenRef` still pass.
 */
function isCredentialKey(key: string): boolean {
  return isSecretKey(key) || /token$/iu.test(key.replaceAll(/[^a-z0-9]/giu, ''));
}

/** Walks a config value and reports any key that names a credential. Keys are reported, values never echoed. */
function findSecretKeys(value: unknown, path: string, found: string[]): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      findSecretKeys(item, `${path}[${String(index)}]`, found);
    });
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  for (const [key, child] of Object.entries(value)) {
    const childPath = path === '' ? key : `${path}.${key}`;
    if (isCredentialKey(key)) found.push(childPath);
    findSecretKeys(child, childPath, found);
  }
}

/**
 * Credentials never live in `config` (SECRETS, §8.7): a config holding a secret-looking key is refused before it
 * is stored. The check is shared by every connector so none can forget it.
 */
export function assertNoSecretsInConfig(config: unknown): void {
  const found: string[] = [];
  findSecretKeys(config, '', found);
  if (found.length > 0) {
    throw new SiemConfigError(
      `config must not hold credentials; use secret_ref instead (keys: ${found.join(', ')})`,
    );
  }
}
