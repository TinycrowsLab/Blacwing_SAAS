import { SpanStatusCode, trace, type Tracer } from '@opentelemetry/api';

import { parseSecretRef } from '@blackwing/contracts';
import { AppError, isAppError } from '@blackwing/errors';

import { SecretFetchError, type FetchedSecret, type SecretFetcher } from './client.js';

import type { SecretRedactionRegistry } from './redaction.js';
import type { Logger } from '@blackwing/logger';
import type { Counter } from 'prom-client';

/**
 * `withSecret` (SESSION-002, §8.6, §8.7): the session manager's only way to use a credential. It resolves a
 * `secret_ref` to its plaintext at the moment of use, runs one operation with it, and drops it afterwards.
 *
 * - The value is passed to `fn` and nowhere else: it is never returned to an API caller, never written to
 *   a store (the store encrypts, SESSION-004) and never placed in an audit event or an error message.
 * - The value is registered with the redaction registry for the operation, so the logger replaces it with
 *   `[REDACTED]`; the registration is released when `fn` settles, success or failure.
 * - Tenant scoping: a reference of another tenant is refused before any fetch (`SM_TENANT_MISMATCH`), and
 *   the Secrets Service checks it again on its side.
 * - Fail closed: an unavailable, denied or malformed resolve is `SM_LOGIN_FAILED`, with no stale value and
 *   no cache. Nothing is cached across operations, so a rotated secret is re-fetched by the next one.
 *
 * JavaScript strings are immutable and cannot be zeroised; the guarantee is that no reference to the value
 * survives the operation in this module: the registration is removed and the local holder is cleared.
 */

/**
 * Largest accepted secret, in UTF-8 bytes. A certificate chain fits. The cap is well below 64 KiB because
 * the logger compiles every registered value into one literal regex (`@blackwing/logger`): a 64 KiB value
 * made that regex fail to compile, which would have broken redaction of every line while it was held.
 */
export const MAX_SECRET_BYTES = 16_384; // 16 KiB
/** Deadline for one resolve call; a timed-out resolve is a failure, never a retry with a stale value. */
const DEFAULT_RESOLVE_TIMEOUT_MS = 5000;

const TRACER_NAME = '@blackwing/session-manager';
const SPAN_NAME = 'secret.resolve';
const MS_PER_SECOND = 1000;

/** The caller's context for one operation. `runId` names the run the credential is injected into. */
interface SecretContext {
  readonly tenantId: string;
  readonly runId: string;
  readonly context?: Readonly<Record<string, string>>;
  readonly traceId?: string;
}

export type SecretResolveResult = 'ok' | 'denied' | 'error';

/** `sm_secret_resolve_total{result}`. */
export interface SecretResolveMetrics {
  resolved(result: SecretResolveResult): void;
}

/** Adapts `sm_secret_resolve_total{result}` (`SessionManagerMetrics.secretResolves`) to the resolver. */
export function secretResolveCounterMetrics(counter: Counter<'result'>): SecretResolveMetrics {
  return {
    resolved: (result) => {
      counter.inc({ result });
    },
  };
}

/** The audit record of a secret reference use: reference id and outcome only, never the value. */
export interface SecretUseEvent {
  readonly tenantId: string;
  readonly runId: string;
  readonly secretId: string;
  readonly outcome: 'success' | 'denied' | 'failure';
  readonly reason?: string;
  readonly version?: number;
}

export interface SecretAccessDeps {
  readonly fetcher: SecretFetcher;
  /** Audits a use. A rejected audit fails the operation closed: the value is not used. */
  readonly audit: (event: SecretUseEvent) => Promise<void>;
  readonly redaction: SecretRedactionRegistry;
  readonly logger: Logger;
  readonly metrics?: SecretResolveMetrics;
  readonly tracer?: Tracer;
  readonly timeoutMs?: number;
}

export interface SecretAccess {
  /** Resolves `secretRef` for the operation `fn`, which receives the plaintext and nothing else. */
  withSecret<T>(
    secretRef: string,
    ctx: SecretContext,
    fn: (value: string) => Promise<T>,
  ): Promise<T>;
  /** The registry of the values in use, for the gateway's redaction set (SESSION-012). */
  readonly redaction: SecretRedactionRegistry;
}

/** A failure that carries a stable code, a non-sensitive reason and nothing else. */
function resolveFailed(reason: string, cause?: unknown): AppError {
  return new AppError('SM_LOGIN_FAILED', 'credential could not be resolved', {
    detail: `reason: ${reason}`,
    ...(cause === undefined ? {} : { cause }),
  });
}

function withDeadline<T>(ms: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error('secret resolve timed out'));
    }, ms);
  });
  return Promise.race([run(controller.signal), timeout]).finally(() => {
    clearTimeout(timer);
  });
}

export function createSecretAccess(deps: SecretAccessDeps): SecretAccess {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_RESOLVE_TIMEOUT_MS;
  const tracer = deps.tracer ?? trace.getTracer(TRACER_NAME);
  const log = deps.logger.child({ component: 'secrets' });
  const metrics = deps.metrics;

  async function fetchValue(secretRef: string, ctx: SecretContext): Promise<FetchedSecret> {
    try {
      return await withDeadline(timeoutMs, (signal) =>
        deps.fetcher.fetch(
          {
            tenantId: ctx.tenantId,
            secretRef,
            callerPurpose: 'asset_login',
            runId: ctx.runId,
            ...(ctx.context === undefined ? {} : { context: ctx.context }),
            ...(ctx.traceId === undefined ? {} : { traceId: ctx.traceId }),
          },
          { signal },
        ),
      );
    } catch (cause) {
      if (cause instanceof SecretFetchError && cause.code === 'TENANT_MISMATCH') {
        throw new AppError('SM_TENANT_MISMATCH', 'secret reference belongs to another tenant');
      }
      throw resolveFailed(cause instanceof SecretFetchError ? cause.code : 'UNAVAILABLE', cause);
    }
  }

  async function resolveAndRun<T>(
    secretRef: string,
    ctx: SecretContext,
    fn: (value: string) => Promise<T>,
  ): Promise<T> {
    let ref;
    try {
      ref = parseSecretRef(secretRef);
    } catch (cause) {
      throw new AppError('INVALID_SECRET_REF', 'malformed secret reference', { cause });
    }
    const secretId = ref.secretId;
    const audit = async (
      event: Omit<SecretUseEvent, 'tenantId' | 'runId' | 'secretId'>,
    ): Promise<void> => {
      await deps.audit({ tenantId: ctx.tenantId, runId: ctx.runId, secretId, ...event });
    };

    if (ref.tenantId.toLowerCase() !== ctx.tenantId.toLowerCase()) {
      metrics?.resolved('denied');
      log.warn({ secretId, code: 'SM_TENANT_MISMATCH' }, 'secret reference refused');
      await audit({ outcome: 'denied', reason: 'SM_TENANT_MISMATCH' }).catch(() => undefined);
      throw new AppError('SM_TENANT_MISMATCH', 'secret reference belongs to another tenant');
    }

    let fetched: FetchedSecret | undefined;
    try {
      fetched = await fetchValue(secretRef, ctx);
    } catch (error) {
      const code = isAppError(error) ? error.code : 'INTERNAL';
      metrics?.resolved(code === 'SM_TENANT_MISMATCH' ? 'denied' : 'error');
      log.warn({ secretId, code }, 'secret resolve failed');
      await audit({ outcome: 'failure', reason: code }).catch(() => undefined);
      throw error;
    }

    const size = Buffer.byteLength(fetched.value, 'utf8');
    if (size === 0 || size > MAX_SECRET_BYTES) {
      fetched = undefined;
      metrics?.resolved('error');
      await audit({ outcome: 'failure', reason: 'size_refused' }).catch(() => undefined);
      throw resolveFailed(size === 0 ? 'empty' : 'too_large');
    }

    const { value, version } = fetched;
    fetched = undefined;
    const release = deps.redaction.acquire(value);
    try {
      // The use is audited before the value is handed over. A ledger that cannot take the record means
      // the value is not used at all (fail closed).
      try {
        await audit({ outcome: 'success', version });
      } catch (cause) {
        metrics?.resolved('error');
        throw resolveFailed('audit_unavailable', cause);
      }
      metrics?.resolved('ok');
      log.info({ secretId, version }, 'secret reference used');
      return await fn(value);
    } finally {
      release();
    }
  }

  return {
    redaction: deps.redaction,
    withSecret(secretRef, ctx, fn) {
      return tracer.startActiveSpan(SPAN_NAME, async (span) => {
        const started = Date.now();
        try {
          return await resolveAndRun(secretRef, ctx, fn);
        } catch (error) {
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: isAppError(error) ? error.code : 'INTERNAL',
          });
          throw error;
        } finally {
          span.setAttribute('secret.resolve_seconds', (Date.now() - started) / MS_PER_SECOND);
          span.end();
        }
      });
    },
  };
}
