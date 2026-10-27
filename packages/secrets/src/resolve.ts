import {
  parseSecretRef,
  type AuditMetadata,
  type SecretBackend,
  type SecretRef,
  type SecretStatus,
  type SecretType,
} from '@blackwing/contracts';
import { AppError, isAppError, RateLimitedError } from '@blackwing/errors';

import type { Envelope, EnvelopeCrypto } from './envelope.js';
import type { SecretService, ServiceIdentity } from './service-auth.js';
import type { AuditEventInput } from '@blackwing/audit';

/**
 * The single sanctioned read path for secret values (SECRETS-006, F35, §8.7): turns a `secret_ref` into
 * its plaintext at the moment of use, for an authenticated platform service, and audits every call.
 *
 * Order of checks, each failing closed: rate limit, tenant match, per-service purpose matrix (code),
 * the run (known, active, not killed), the record (tenant-scoped read), the record's purpose and type
 * against the matrix, the optional Cedar decision, record status, then decrypt. The audit event is
 * written BEFORE the value is returned: a resolve whose audit cannot be written returns nothing.
 * A refusal is audited too (best effort: it already returns nothing), except an unauthenticated one,
 * which has no trustworthy tenant to attribute it to (see `resolve-endpoint.ts`).
 *
 * Plaintext is never written to disk or logged. With `cacheTtlMs > 0` it is held in process memory only,
 * after every check above has passed on the call, for at most that long.
 */

/** What a service is allowed to resolve. */
export interface ServiceGrant {
  /** Secret `purpose` values (the resolve request's `callerPurpose` must be one, and equal the record's). */
  readonly purposes: readonly string[];
  /** When set, the record's `type` must be one of these. */
  readonly types?: readonly SecretType[];
  /** The service injects secrets into a run: the request must name an active, same-tenant run. */
  readonly runBound: boolean;
}

/** Purposes a secret can be stored for (`secrets.purpose`). */
export const SECRET_PURPOSES = {
  assetLogin: 'asset_login',
  providerKey: 'provider_key',
  connectorCredential: 'connector_credential',
  notifyChannel: 'notify_channel',
} as const;

const SECRET_TYPES_FOR_LOGIN = ['password', 'api_key', 'token', 'certificate', 'ssh_key'] as const;

/**
 * The deterministic authorisation matrix (§8.11). mTLS or a token only says who calls; this says what that
 * caller may read. Deployments may pass a narrower matrix, never rely on a wider default.
 */
export const DEFAULT_SERVICE_MATRIX: Readonly<Record<SecretService, ServiceGrant>> = Object.freeze({
  'session-manager': {
    purposes: [SECRET_PURPOSES.assetLogin],
    types: SECRET_TYPES_FOR_LOGIN,
    runBound: true,
  },
  'egress-gateway': {
    purposes: [SECRET_PURPOSES.assetLogin],
    types: SECRET_TYPES_FOR_LOGIN,
    runBound: true,
  },
  'model-gateway': {
    purposes: [SECRET_PURPOSES.providerKey],
    types: ['api_key', 'token'],
    runBound: true,
  },
  'worker:connectors': {
    purposes: [SECRET_PURPOSES.connectorCredential],
    types: ['api_key', 'token', 'password', 'webhook_secret'],
    runBound: false,
  },
  'worker:notify': {
    purposes: [SECRET_PURPOSES.notifyChannel],
    types: ['api_key', 'token', 'password', 'webhook_secret'],
    runBound: false,
  },
});

/** A secret record at the version a reference names, as the resolver needs it. */
export interface SecretRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly type: SecretType | null;
  readonly purpose: string | null;
  readonly backend: SecretBackend;
  readonly status: SecretStatus;
  /** The version whose value `envelope`/`externalLocator` hold. */
  readonly version: number;
  readonly envelope: Envelope | null;
  readonly externalLocator: Readonly<Record<string, unknown>> | null;
}

/** Tenant-scoped read of one secret record. */
export interface SecretStore {
  /** `null` for an unknown secret, an unknown version, and a secret of another tenant (indistinguishable). */
  load(tenantId: string, secretId: string, version?: number): Promise<SecretRecord | null>;
}

/**
 * The state of a run as the resolver sees it. The adapter (RUNTIME/KILL) answers `unknown` for a run that
 * does not exist in the tenant, and for one of another tenant, so the two cannot be told apart.
 */
export type RunStanding = 'active' | 'inactive' | 'killed' | 'unknown';

export interface RunStandingReader {
  standing(tenantId: string, runId: string): Promise<RunStanding>;
}

/** Fetches the value of a customer-owned (BYOK) record (SECRETS-007+). */
export interface ExternalSecretFetcher {
  fetch(
    record: SecretRecord,
    options: { readonly signal: AbortSignal },
  ): Promise<Uint8Array | string>;
}

/** What the optional Cedar PDP is asked. It can only narrow the matrix, never widen it. */
export interface ResolveAuthorizationQuery {
  readonly service: SecretService;
  readonly tenantId: string;
  readonly secretId: string;
  readonly purpose: string;
  readonly type: SecretType | null;
  readonly runId?: string;
}

export interface ResolveMetrics {
  /** `secret_resolve_total{service,result}` */
  resolved(service: string, result: 'ok' | 'denied' | 'error'): void;
  /** `secret_resolve_latency_seconds` */
  latency(seconds: number): void;
  /** `secret_resolve_denied_total{reason}`: `reason` is an error code. */
  denied(reason: string): void;
}

/** Log line for a resolve. Never carries the value. */
export interface ResolveLogEntry {
  readonly tenantId: string;
  readonly secretId: string;
  readonly callerService: string;
  readonly runId?: string;
  readonly outcome: string;
}

export interface SecretResolverDeps {
  readonly store: SecretStore;
  readonly crypto: Pick<EnvelopeCrypto, 'decryptSecret'>;
  /** Required: a resolve that cannot be audited does not return a value. Wire `emitAudit`. */
  readonly audit: (event: AuditEventInput) => Promise<void>;
  /** Required whenever a service in the matrix is `runBound` (all defaults but the workers are). */
  readonly runs: RunStandingReader;
  readonly matrix?: Readonly<Record<SecretService, ServiceGrant>>;
  readonly external?: ExternalSecretFetcher;
  /** Cedar adapter (POLICY). Throwing or answering `false` denies. */
  readonly authorize?: (query: ResolveAuthorizationQuery) => Promise<boolean>;
  readonly metrics?: ResolveMetrics;
  readonly log?: (entry: ResolveLogEntry) => void;
  /** Wraps a resolve in the `secret.resolve` span. */
  readonly span?: <T>(name: string, fn: () => Promise<T>) => Promise<T>;
  /** `SECRET_RESOLVE_CACHE_TTL_MS`; `0` (default) disables the cache. */
  readonly cacheTtlMs?: number;
  /** Per-service resolves per window (default 1200 per minute). */
  readonly rateLimit?: { readonly limit: number; readonly windowMs: number };
  /** Deadline for an external backend fetch (default 5 s). */
  readonly externalTimeoutMs?: number;
  readonly now?: () => number;
}

export interface ResolveInput {
  readonly secretRef: string;
  readonly callerPurpose: string;
  readonly runId?: string;
  readonly context?: Readonly<Record<string, string>>;
}

export interface ResolveCaller extends ServiceIdentity {
  /** The tenant the caller acts for (header of the HTTP request); must equal the reference's tenant. */
  readonly tenantId: string;
  readonly traceId?: string;
}

export interface ResolvedSecret {
  readonly value: string;
  readonly version: number;
  readonly type: SecretType;
}

export interface SecretResolver {
  resolve(caller: ResolveCaller, input: ResolveInput): Promise<ResolvedSecret>;
}

const DEFAULT_RATE_LIMIT = { limit: 1200, windowMs: 60_000 } as const;
const DEFAULT_EXTERNAL_TIMEOUT_MS = 5000;
const MAX_CACHE_ENTRIES = 1000;
const MS_PER_SECOND = 1000;
const UNPARSED = 'unparsed';

const noopMetrics: ResolveMetrics = {
  resolved: () => undefined,
  latency: () => undefined,
  denied: () => undefined,
};
const defaultSpan = <T>(_name: string, fn: () => Promise<T>): Promise<T> => fn();

/** Codes that are a refusal of the caller (audit outcome `denied`); the rest are failures. */
const DENIAL_CODES: ReadonlySet<string> = new Set([
  'SERVICE_AUTH_FAILED',
  'TENANT_MISMATCH',
  'SECRET_PURPOSE_DENIED',
  'SECRET_DISABLED',
  'SECRET_SHREDDED',
  'RUN_KILLED',
  'RUN_NOT_ACTIVE',
  'RATE_LIMITED',
  'VALIDATION_FAILED',
  'INVALID_SECRET_REF',
]);

interface CacheEntry {
  readonly value: Buffer;
  readonly version: number;
  readonly type: SecretType;
  readonly expiresAt: number;
}

function parseRef(value: string): SecretRef {
  try {
    return parseSecretRef(value);
  } catch (cause) {
    throw new AppError('INVALID_SECRET_REF', 'malformed secret reference', { cause });
  }
}

const canonicalContext = (context: Readonly<Record<string, string>> | undefined): string =>
  JSON.stringify(Object.entries(context ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

function deadline<T>(
  ms: number,
  run: (signal: AbortSignal) => Promise<T>,
  onTimeout: () => Error,
): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(onTimeout());
    }, ms);
  });
  return Promise.race([run(controller.signal), timeout]).finally(() => {
    clearTimeout(timer);
  });
}

export function createSecretResolver(deps: SecretResolverDeps): SecretResolver {
  const { store, crypto, audit, runs } = deps;
  const matrix = deps.matrix ?? DEFAULT_SERVICE_MATRIX;
  const metrics = deps.metrics ?? noopMetrics;
  const span = deps.span ?? defaultSpan;
  const now = deps.now ?? Date.now;
  const cacheTtlMs = deps.cacheTtlMs ?? 0;
  const rate = deps.rateLimit ?? DEFAULT_RATE_LIMIT;
  const externalTimeoutMs = deps.externalTimeoutMs ?? DEFAULT_EXTERNAL_TIMEOUT_MS;
  const cache = new Map<string, CacheEntry>();
  const windows = new Map<string, { start: number; count: number }>();

  function checkRate(service: string): void {
    const t = now();
    const w = windows.get(service);
    if (w === undefined || t - w.start >= rate.windowMs) {
      windows.set(service, { start: t, count: 1 });
      return;
    }
    w.count += 1;
    if (w.count > rate.limit) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((w.start + rate.windowMs - t) / MS_PER_SECOND),
      );
      throw new RateLimitedError('secret resolve rate limit exceeded', { retryAfterSeconds });
    }
  }

  function cacheGet(key: string): CacheEntry | undefined {
    const entry = cache.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAt <= now()) {
      entry.value.fill(0);
      cache.delete(key);
      return undefined;
    }
    return entry;
  }

  function cachePut(key: string, entry: CacheEntry): void {
    if (cache.size >= MAX_CACHE_ENTRIES) {
      const oldest = cache.keys().next();
      if (!oldest.done) {
        cache.get(oldest.value)?.value.fill(0);
        cache.delete(oldest.value);
      }
    }
    cache.set(key, entry);
  }

  async function plaintext(record: SecretRecord, purpose: string): Promise<Buffer> {
    if (record.backend !== 'openbao') {
      const { external } = deps;
      if (external === undefined) {
        throw new AppError('EXTERNAL_BACKEND_UNAVAILABLE', 'no adapter for the secret backend');
      }
      try {
        const raw = await deadline(
          externalTimeoutMs,
          (signal) => external.fetch(record, { signal }),
          () => new Error('external backend timed out'),
        );
        return typeof raw === 'string' ? Buffer.from(raw, 'utf8') : Buffer.from(raw);
      } catch (cause) {
        throw new AppError('EXTERNAL_BACKEND_UNAVAILABLE', 'external backend fetch failed', {
          cause,
        });
      }
    }
    if (record.envelope === null) {
      throw new AppError('ENVELOPE_INVALID', 'secret has no envelope');
    }
    try {
      return await crypto.decryptSecret(record.envelope, {
        tenantId: record.tenantId,
        context: { secretId: record.id, purpose },
      });
    } catch (cause) {
      // The KEK service or OpenBao failing, in any shape, is "key unavailable": nothing is served.
      if (isAppError(cause)) throw cause;
      throw new AppError('KEK_UNAVAILABLE', 'tenant key unavailable', { cause });
    }
  }

  async function authorizeAndRead(
    caller: ResolveCaller,
    input: ResolveInput,
    ref: SecretRef,
    key: string,
  ): Promise<ResolvedSecret & { readonly secretId: string }> {
    const { service, tenantId } = caller;
    if (ref.tenantId.toLowerCase() !== tenantId.toLowerCase()) {
      throw new AppError('TENANT_MISMATCH', 'secret reference belongs to another tenant');
    }
    const grant = matrix[service];
    if (!grant.purposes.includes(input.callerPurpose)) {
      throw new AppError('SECRET_PURPOSE_DENIED', 'purpose not permitted for this service');
    }
    if (grant.runBound) {
      if (input.runId === undefined) {
        throw new AppError('VALIDATION_FAILED', 'runId is required for this service');
      }
      const standing = await runs.standing(tenantId, input.runId);
      if (standing === 'unknown') {
        throw new AppError('TENANT_MISMATCH', 'run does not belong to this tenant');
      }
      if (standing === 'killed') throw new AppError('RUN_KILLED', 'run was killed');
      if (standing === 'inactive') throw new AppError('RUN_NOT_ACTIVE', 'run is not active');
    }
    const record = await store.load(tenantId, ref.secretId, ref.version);
    if (record === null) throw new AppError('SECRET_NOT_FOUND', 'secret not found');
    if (
      record.purpose !== input.callerPurpose ||
      (grant.types !== undefined && (record.type === null || !grant.types.includes(record.type)))
    ) {
      throw new AppError('SECRET_PURPOSE_DENIED', 'secret is not usable for this purpose');
    }
    if (deps.authorize !== undefined) {
      let allowed = false;
      try {
        allowed = await deps.authorize({
          service,
          tenantId,
          secretId: record.id,
          purpose: input.callerPurpose,
          type: record.type,
          ...(input.runId === undefined ? {} : { runId: input.runId }),
        });
      } catch {
        allowed = false;
      }
      if (!allowed) throw new AppError('SECRET_PURPOSE_DENIED', 'policy denied the resolve');
    }
    if (record.status === 'shredded') throw new AppError('SECRET_SHREDDED', 'secret was shredded');
    if (record.status === 'disabled') throw new AppError('SECRET_DISABLED', 'secret is disabled');

    const type = record.type ?? 'generic';
    const cached = cacheTtlMs > 0 ? cacheGet(key) : undefined;
    if (cached !== undefined) {
      return {
        value: cached.value.toString('utf8'),
        version: cached.version,
        type: cached.type,
        secretId: record.id,
      };
    }
    const bytes = await plaintext(record, input.callerPurpose);
    try {
      const value = bytes.toString('utf8');
      if (cacheTtlMs > 0) {
        cachePut(key, {
          value: Buffer.from(bytes),
          version: record.version,
          type,
          expiresAt: now() + cacheTtlMs,
        });
      }
      return { value, version: record.version, type, secretId: record.id };
    } finally {
      bytes.fill(0);
    }
  }

  function auditInput(
    caller: ResolveCaller,
    input: ResolveInput,
    fields: {
      readonly secretId: string;
      readonly outcome: 'success' | 'denied' | 'failure';
      readonly code?: string;
      readonly version?: number;
    },
  ): AuditEventInput {
    const metadata: AuditMetadata = {
      callerService: caller.service,
      callerPurpose: input.callerPurpose,
      secretId: fields.secretId,
      contextKeys: Object.keys(input.context ?? {}).sort(),
      ...(fields.version === undefined ? {} : { version: fields.version }),
      ...(fields.code === undefined ? {} : { code: fields.code }),
    };
    return {
      tenantId: caller.tenantId,
      action: 'secret.resolved',
      actor: { type: 'service', id: caller.service, tokenId: caller.tokenId },
      target: { type: 'secret_ref', id: fields.secretId },
      outcome: fields.outcome,
      metadata,
      ...(fields.code === undefined ? {} : { reason: fields.code }),
      ...(input.runId === undefined ? {} : { runId: input.runId }),
      ...(caller.traceId === undefined ? {} : { traceId: caller.traceId }),
    };
  }

  return {
    resolve: (caller, input) =>
      span('secret.resolve', async () => {
        const started = now();
        let secretId = UNPARSED;
        const log = (outcome: string): void => {
          deps.log?.({
            tenantId: caller.tenantId,
            secretId,
            callerService: caller.service,
            outcome,
            ...(input.runId === undefined ? {} : { runId: input.runId }),
          });
        };
        try {
          const ref = parseRef(input.secretRef);
          secretId = ref.secretId;
          checkRate(caller.service);
          const key = `${caller.service}\0${input.callerPurpose}\0${input.secretRef}\0${canonicalContext(input.context)}`;
          const result = await authorizeAndRead(caller, input, ref, key);
          // Audit before the value leaves: if the ledger write fails, the caller gets an error instead.
          await audit(
            auditInput(caller, input, {
              secretId,
              outcome: 'success',
              version: result.version,
            }),
          );
          metrics.resolved(caller.service, 'ok');
          log('success');
          return { value: result.value, version: result.version, type: result.type };
        } catch (cause) {
          const error = isAppError(cause)
            ? cause
            : new AppError('INTERNAL', 'secret resolve failed', { cause });
          const { code } = error;
          const denied = DENIAL_CODES.has(code);
          metrics.resolved(caller.service, denied ? 'denied' : 'error');
          if (denied) metrics.denied(code);
          log(code);
          try {
            await audit(
              auditInput(caller, input, {
                secretId,
                outcome: denied ? 'denied' : 'failure',
                code,
              }),
            );
          } catch {
            // The refusal stands whether or not the ledger took it; the failure is the caller's to see.
          }
          throw error;
        } finally {
          metrics.latency((now() - started) / MS_PER_SECOND);
        }
      }),
  };
}
