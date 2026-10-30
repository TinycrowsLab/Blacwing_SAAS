import { Writable } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { isMarkedSecret, unmarkSecret } from '@blackwing/config';
import { isAppError } from '@blackwing/errors';
import { createLogger, REDACTED } from '@blackwing/logger';

import {
  SecretFetchError,
  type FetchedSecret,
  type SecretFetcher,
  type SecretFetchRequest,
} from './client.js';
import {
  createSecretAccess,
  MAX_SECRET_BYTES,
  secretResolveCounterMetrics,
  type SecretResolveMetrics,
  type SecretResolveResult,
  type SecretUseEvent,
} from './resolve.js';
import { createSessionManagerMetrics } from '../metrics.js';
import { createSecretRedactionRegistry } from './redaction.js';

import type { Tracer } from '@opentelemetry/api';

const TENANT = '0195c0de-0000-7000-8000-00000000000a';
const OTHER_TENANT = '0195c0de-0000-7000-8000-0000000000bb';
const RUN = '0195c0de-0000-7000-8000-0000000000ff';
const SECRET_ID = '0195c0de-0000-7000-8000-0000000000b1';
const REF = `bw-secret://${TENANT}/${SECRET_ID}`;
const VALUE = 'S3cr3t-Pässwörd-🔐-"quoted"-\\slash';

/** Values this file registers; cleared so no test leaks a mark into another. */
const MARKED: string[] = [];
afterEach(() => {
  for (const value of MARKED.splice(0)) unmarkSecret(value);
});

function captureLogger() {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, callback) {
      chunks.push(chunk.toString('utf8'));
      callback();
    },
  });
  const logger = createLogger('session-manager', {
    destination: stream,
    level: 'debug',
    nodeEnv: 'test',
  });
  return { logger, output: () => chunks.join('') };
}

interface Harness {
  readonly fetcher: SecretFetcher & { calls: SecretFetchRequest[] };
  readonly audits: SecretUseEvent[];
  readonly metrics: SecretResolveResult[];
  readonly access: ReturnType<typeof createSecretAccess>;
  readonly output: () => string;
}

function harness(
  fetchImpl: (request: SecretFetchRequest) => Promise<FetchedSecret> = () =>
    Promise.resolve({ value: VALUE, version: 2, type: 'password' }),
  options: {
    audit?: (event: SecretUseEvent) => Promise<void>;
    timeoutMs?: number;
    tracer?: Tracer;
    metrics?: SecretResolveMetrics;
  } = {},
): Harness {
  const calls: SecretFetchRequest[] = [];
  const fetcher = {
    calls,
    fetch: (request: SecretFetchRequest) => {
      calls.push(request);
      return fetchImpl(request);
    },
  };
  const audits: SecretUseEvent[] = [];
  const metrics: SecretResolveResult[] = [];
  const { logger, output } = captureLogger();
  const access = createSecretAccess({
    fetcher,
    audit:
      options.audit ??
      ((event) => {
        audits.push(event);
        return Promise.resolve();
      }),
    redaction: createSecretRedactionRegistry(),
    logger,
    metrics: options.metrics ?? { resolved: (result) => metrics.push(result) },
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.tracer === undefined ? {} : { tracer: options.tracer }),
  });
  return { fetcher, audits, metrics, access, output };
}

const ctx = { tenantId: TENANT, runId: RUN };

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('expected a rejection');
    },
    (error: unknown) => error,
  );
}

describe('withSecret', () => {
  it('fetches the value, exposes it to fn and returns fn result', async () => {
    const h = harness();
    const result = await h.access.withSecret(REF, ctx, (value) => {
      MARKED.push(value);
      expect(value).toBe(VALUE);
      return Promise.resolve(`used ${String(value.length)}`);
    });
    expect(result).toBe(`used ${String(VALUE.length)}`);
    expect(h.fetcher.calls).toEqual([
      { tenantId: TENANT, secretRef: REF, callerPurpose: 'asset_login', runId: RUN },
    ]);
  });

  it('clears the reference afterwards: the value is no longer redacted or held', async () => {
    const h = harness();
    let captured = '';
    await h.access.withSecret(REF, ctx, (value) => {
      captured = value;
      MARKED.push(value);
      expect(h.access.redaction.has(value)).toBe(true);
      return Promise.resolve();
    });
    expect(captured).toBe(VALUE);
    expect(h.access.redaction.size).toBe(0);
    expect(h.access.redaction.has(VALUE)).toBe(false);
    expect(isMarkedSecret(VALUE)).toBe(false);
  });

  it('releases the registration even when fn throws, and propagates the error', async () => {
    const h = harness();
    const boom = new Error('operation failed');
    const error = await rejectionOf(
      h.access.withSecret(REF, ctx, (value) => {
        MARKED.push(value);
        return Promise.reject(boom);
      }),
    );
    expect(error).toBe(boom);
    expect(isMarkedSecret(VALUE)).toBe(false);
    expect(h.access.redaction.size).toBe(0);
  });

  it('replaces the value with [REDACTED] in a log line that carries it', async () => {
    const { logger, output } = captureLogger();
    const access = createSecretAccess({
      fetcher: { fetch: () => Promise.resolve({ value: VALUE, version: 1, type: 'password' }) },
      audit: () => Promise.resolve(),
      redaction: createSecretRedactionRegistry(),
      logger,
    });
    await access.withSecret(REF, ctx, (value) => {
      logger.info({ detail: value }, `login with ${value}`);
      return Promise.resolve();
    });
    const logged = output();
    expect(logged).toContain(REDACTED);
    expect(logged).not.toContain(VALUE);
    expect(logged).not.toContain(JSON.stringify(VALUE).slice(1, -1));
  });

  it('refuses a cross-tenant reference before any fetch with SM_TENANT_MISMATCH', async () => {
    const h = harness();
    const crossRef = `bw-secret://${OTHER_TENANT}/${SECRET_ID}`;
    const fn = vi.fn(() => Promise.resolve());
    const error = await rejectionOf(h.access.withSecret(crossRef, ctx, fn));
    expect(isAppError(error) && error.code).toBe('SM_TENANT_MISMATCH');
    expect(h.fetcher.calls).toHaveLength(0);
    expect(fn).not.toHaveBeenCalled();
    expect(h.audits).toEqual([
      expect.objectContaining({
        outcome: 'denied',
        reason: 'SM_TENANT_MISMATCH',
        secretId: SECRET_ID,
      }),
    ]);
    expect(h.metrics).toEqual(['denied']);
  });

  it('maps a server-side TENANT_MISMATCH to SM_TENANT_MISMATCH', async () => {
    const h = harness(() => Promise.reject(new SecretFetchError('TENANT_MISMATCH')));
    const error = await rejectionOf(h.access.withSecret(REF, ctx, () => Promise.resolve()));
    expect(isAppError(error) && error.code).toBe('SM_TENANT_MISMATCH');
    expect(h.metrics).toEqual(['denied']);
  });

  it('compares tenants case-insensitively', async () => {
    const h = harness();
    const upper = `bw-secret://${TENANT.toUpperCase()}/${SECRET_ID}`;
    await h.access.withSecret(upper, ctx, () => Promise.resolve());
    expect(h.fetcher.calls).toHaveLength(1);
  });

  it('rejects a malformed reference with INVALID_SECRET_REF and never fetches', async () => {
    const h = harness();
    const error = await rejectionOf(h.access.withSecret('not-a-ref', ctx, () => Promise.resolve()));
    expect(isAppError(error) && error.code).toBe('INVALID_SECRET_REF');
    expect(h.fetcher.calls).toHaveLength(0);
  });

  it.each([
    ['a missing or denied secret', () => Promise.reject(new SecretFetchError('SECRET_NOT_FOUND'))],
    ['an unavailable key service', () => Promise.reject(new SecretFetchError('HTTP_503'))],
    ['a network failure', () => Promise.reject(new Error(`ECONNRESET with ${VALUE}`))],
    ['a malformed response', () => Promise.reject(new SecretFetchError('MALFORMED_RESPONSE'))],
  ])(
    'fails closed with SM_LOGIN_FAILED on %s, without the value or the reference',
    async (_label, impl) => {
      const h = harness(impl);
      const fn = vi.fn(() => Promise.resolve());
      const error = await rejectionOf(h.access.withSecret(REF, ctx, fn));
      expect(isAppError(error) && error.code).toBe('SM_LOGIN_FAILED');
      expect(fn).not.toHaveBeenCalled();
      expect(String(error)).not.toContain(REF);
      expect(String(error)).not.toContain(VALUE);
      expect(h.metrics).toEqual(['error']);
      expect(h.audits).toEqual([expect.objectContaining({ outcome: 'failure' })]);
    },
  );

  it('times out a resolve that never answers and does not use a value', async () => {
    const h = harness(() => new Promise<FetchedSecret>(() => undefined), { timeoutMs: 10 });
    const fn = vi.fn(() => Promise.resolve());
    const error = await rejectionOf(h.access.withSecret(REF, ctx, fn));
    expect(isAppError(error) && error.code).toBe('SM_LOGIN_FAILED');
    expect(fn).not.toHaveBeenCalled();
  });

  it('re-fetches on every operation, so a rotated secret is picked up by the next one', async () => {
    const versions = [
      { value: 'first-rotation-value-1', version: 1, type: 'password' },
      { value: 'second-rotation-value-2', version: 2, type: 'password' },
    ];
    MARKED.push(...versions.map((v) => v.value));
    const h = harness(() =>
      Promise.resolve(
        versions.shift() ?? versions[0] ?? { value: '', version: 0, type: 'password' },
      ),
    );
    const seenFirst = await h.access.withSecret(REF, ctx, (value) => {
      // The value rotates while the first operation runs: it keeps the value it fetched.
      return Promise.resolve(value);
    });
    const seenSecond = await h.access.withSecret(REF, ctx, (value) => Promise.resolve(value));
    expect(seenFirst).toBe('first-rotation-value-1');
    expect(seenSecond).toBe('second-rotation-value-2');
    expect(h.fetcher.calls).toHaveLength(2);
  });

  it('isolates concurrent operations: each sees its own value and a finished one does not unmark another', async () => {
    const other = 'another-tenant-secret-value';
    MARKED.push(other);
    const values: Record<string, FetchedSecret> = {
      [REF]: { value: VALUE, version: 1, type: 'password' },
      [`${REF}x`]: { value: other, version: 1, type: 'password' },
    };
    const h = harness((request) =>
      Promise.resolve(
        values[request.secretRef] ?? values[REF] ?? { value: '', version: 0, type: 'password' },
      ),
    );
    let releaseSecond: (() => void) | undefined;
    const second = h.access.withSecret(`${REF}x`, ctx, (value) => {
      expect(value).toBe(other);
      return new Promise<string>((resolve) => {
        releaseSecond = () => {
          resolve(value);
        };
      });
    });
    const first = await h.access.withSecret(REF, ctx, (value) => Promise.resolve(value));
    expect(first).toBe(VALUE);
    expect(h.access.redaction.has(other)).toBe(true);
    expect(h.access.redaction.has(VALUE)).toBe(false);
    releaseSecond?.();
    expect(await second).toBe(other);
    expect(h.access.redaction.size).toBe(0);
  });

  it('refuses an empty or oversized value and never holds it', async () => {
    const empty = harness(() => Promise.resolve({ value: '', version: 1, type: 'password' }));
    const emptyError = await rejectionOf(
      empty.access.withSecret(REF, ctx, () => Promise.resolve()),
    );
    expect(isAppError(emptyError) && emptyError.code).toBe('SM_LOGIN_FAILED');

    const big = 'x'.repeat(MAX_SECRET_BYTES + 1);
    const huge = harness(() => Promise.resolve({ value: big, version: 1, type: 'certificate' }));
    const fn = vi.fn(() => Promise.resolve());
    const hugeError = await rejectionOf(huge.access.withSecret(REF, ctx, fn));
    expect(isAppError(hugeError) && hugeError.code).toBe('SM_LOGIN_FAILED');
    expect(fn).not.toHaveBeenCalled();
    expect(huge.access.redaction.size).toBe(0);
  });

  it('accepts a value at the size cap', async () => {
    const atCap = 'y'.repeat(MAX_SECRET_BYTES);
    const h = harness(() => Promise.resolve({ value: atCap, version: 1, type: 'certificate' }));
    const length = await h.access.withSecret(REF, ctx, (value) => {
      MARKED.push(value);
      return Promise.resolve(value.length);
    });
    expect(length).toBe(MAX_SECRET_BYTES);
  });

  it('redacts a unicode value with characters that need escaping in JSON', async () => {
    const h = harness();
    await h.access.withSecret(REF, ctx, (value) => {
      MARKED.push(value);
      const { logger, output } = captureLogger();
      logger.warn({ value }, 'probe');
      expect(output()).not.toContain(VALUE);
      return Promise.resolve();
    });
  });

  it('fails closed when the audit ledger cannot take the use record', async () => {
    const h = harness(undefined, {
      audit: (event) =>
        event.outcome === 'success' ? Promise.reject(new Error('ledger down')) : Promise.resolve(),
    });
    const fn = vi.fn(() => Promise.resolve());
    const error = await rejectionOf(h.access.withSecret(REF, ctx, fn));
    expect(isAppError(error) && error.code).toBe('SM_LOGIN_FAILED');
    expect(fn).not.toHaveBeenCalled();
    expect(isMarkedSecret(VALUE)).toBe(false);
    expect(h.metrics).toEqual(['error']);
  });

  it('audits a use with the reference id and version, never the value', async () => {
    const h = harness();
    await h.access.withSecret(REF, ctx, () => Promise.resolve());
    expect(h.audits).toEqual([
      { tenantId: TENANT, runId: RUN, secretId: SECRET_ID, outcome: 'success', version: 2 },
    ]);
    expect(JSON.stringify(h.audits)).not.toContain(VALUE);
    expect(h.metrics).toEqual(['ok']);
  });

  it('opens a secret.resolve span around the resolution', async () => {
    const spans: string[] = [];
    const tracer = {
      startActiveSpan: (name: string, fn: (span: unknown) => unknown) => {
        spans.push(name);
        return fn({
          setStatus: () => undefined,
          setAttribute: () => undefined,
          end: () => undefined,
        });
      },
    } as unknown as Tracer;
    const h = harness(undefined, { tracer });
    await h.access.withSecret(REF, ctx, () => Promise.resolve());
    expect(spans).toEqual(['secret.resolve']);
  });

  it('exports sm_secret_resolve_total{result} through the session manager registry', async () => {
    const metrics = createSessionManagerMetrics('0.0.0', 'abc123');
    const h = harness(undefined, { metrics: secretResolveCounterMetrics(metrics.secretResolves) });
    await h.access.withSecret(REF, ctx, () => Promise.resolve());
    await expect(
      h.access.withSecret(`bw-secret://${OTHER_TENANT}/${SECRET_ID}`, ctx, () => Promise.resolve()),
    ).rejects.toThrow();
    const text = await metrics.registry.metrics();
    expect(text).toContain('sm_secret_resolve_total{result="ok"} 1');
    expect(text).toContain('sm_secret_resolve_total{result="denied"} 1');
  });
});
