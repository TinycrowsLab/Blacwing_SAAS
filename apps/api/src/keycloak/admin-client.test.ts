import { SpanStatusCode } from '@opentelemetry/api';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { describe, expect, it } from 'vitest';

import { AppError } from '@blackwing/errors';

import { harness, SETTINGS } from './fixtures.test-helpers.js';

const LIST = { op: 'list', method: 'GET', path: 'organizations' } as const;

/** The stable `code` of what `promise` rejects with; `undefined` when it resolves. */
async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    return error instanceof AppError ? error.code : 'UNKNOWN';
  }
  return undefined;
}

describe('createKeycloakAdminClient: token handling', () => {
  it('reuses one access token across calls until it nears expiry', async () => {
    const h = harness();
    await h.client.request(LIST.op, LIST.method, LIST.path);
    await h.client.request(LIST.op, LIST.method, LIST.path);
    expect(h.keycloak.issued).toHaveLength(1);

    // Renewal happens at 80% of the 300 s lifetime, so it is not needed at 239 s but is at 240 s.
    h.now.value += 239_000;
    await h.client.request(LIST.op, LIST.method, LIST.path);
    expect(h.keycloak.issued).toHaveLength(1);
    h.now.value += 1_000;
    await h.client.request(LIST.op, LIST.method, LIST.path);
    expect(h.keycloak.issued).toHaveLength(2);
  });

  it('re-reads the client secret and retries once when Keycloak revokes the token', async () => {
    const h = harness();
    await h.client.request(LIST.op, LIST.method, LIST.path);
    h.keycloak.revoked.add('tok-1');

    const result = await h.client.request(LIST.op, LIST.method, LIST.path);

    expect(result.kind).toBe('ok');
    expect(h.keycloak.issued).toEqual(['tok-1', 'tok-2']);
    expect(h.openBao.reads).toHaveLength(2);
  });

  it('picks up a rotated client secret from OpenBao without a restart', async () => {
    const h = harness();
    await h.client.request(LIST.op, LIST.method, LIST.path);
    h.keycloak.revoked.add('tok-1');
    h.keycloak.clientSecret = 'secret-v2';
    h.openBaoSecret.secret = 'secret-v2';

    expect((await h.client.request(LIST.op, LIST.method, LIST.path)).kind).toBe('ok');
  });

  it('refuses the call when Keycloak still rejects the token after a fresh secret (fails closed)', async () => {
    const h = harness();
    h.keycloak.clientSecret = 'secret-v2'; // OpenBao still serves the old secret
    expect(await codeOf(h.client.request(LIST.op, LIST.method, LIST.path))).toBe(
      'KEYCLOAK_REJECTED',
    );
    expect(h.keycloak.issued).toHaveLength(0);
  });

  it('fails closed with CONFIG_INVALID when the secret is missing from OpenBao', async () => {
    const h = harness();
    h.openBaoSecret.secret = undefined;
    expect(await codeOf(h.client.request(LIST.op, LIST.method, LIST.path))).toBe('CONFIG_INVALID');
    expect(h.keycloak.issued).toHaveLength(0);
  });

  it('refuses a token response without an access token', async () => {
    const h = harness();
    h.keycloak.tokenResponse = { expires_in: 300 };
    expect(await codeOf(h.client.request(LIST.op, LIST.method, LIST.path))).toBe(
      'KEYCLOAK_REJECTED',
    );
  });

  it('sends the service-account client id and secret only in the token request', async () => {
    const h = harness();
    await h.client.request(LIST.op, LIST.method, LIST.path);
    const tokenCall = h.keycloak.calls.find((c) => c.path.endsWith('/token'));
    expect(tokenCall?.path).toBe(`/realms/${SETTINGS.realm}/protocol/openid-connect/token`);
    expect(h.keycloak.calls.filter((c) => c.path.startsWith('/admin/')).length).toBe(1);
  });
});

describe('createKeycloakAdminClient: results and errors', () => {
  it('returns not_found and conflict as results so the caller can make them idempotent', async () => {
    const h = harness();
    const missing = await h.client.request(
      'get',
      'GET',
      'organizations/00000000-0000-4000-8000-000000000000',
    );
    expect(missing).toEqual({ kind: 'not_found' });

    await h.client.request('create', 'POST', 'organizations', { name: 'acme' });
    const duplicate = await h.client.request('create', 'POST', 'organizations', { name: 'acme' });
    expect(duplicate).toEqual({ kind: 'conflict' });
  });

  it('retries a transient 503 with backoff and then succeeds', async () => {
    const h = harness();
    await h.client.request(LIST.op, LIST.method, LIST.path); // warm the token, so only the admin call is queued
    h.keycloak.queuedStatuses.push(503);

    const result = await h.client.request(LIST.op, LIST.method, LIST.path);

    expect(result.kind).toBe('ok');
    expect(h.sleeps).toEqual([200]);
  });

  it('gives up after the last attempt with a retryable KEYCLOAK_UNAVAILABLE (503)', async () => {
    const h = harness({ attempts: 3 });
    await h.client.request(LIST.op, LIST.method, LIST.path);
    h.keycloak.queuedStatuses.push(503, 503, 503);

    const error = await h.client.request(LIST.op, LIST.method, LIST.path).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('KEYCLOAK_UNAVAILABLE');
    expect((error as AppError).httpStatus).toBe(503);
    expect((error as AppError).retryable).toBe(true);
    expect(h.sleeps).toEqual([200, 400]);
  });

  it('treats an unreachable Keycloak as KEYCLOAK_UNAVAILABLE after bounded retries', async () => {
    const h = harness({ attempts: 3 });
    h.keycloak.queuedNetworkFailures = 3; // the token request fails on every attempt
    expect(await codeOf(h.client.request(LIST.op, LIST.method, LIST.path))).toBe(
      'KEYCLOAK_UNAVAILABLE',
    );
    expect(h.keycloak.calls).toHaveLength(3);
  });

  it('maps other 4xx answers to KEYCLOAK_REJECTED and never copies the Keycloak body', async () => {
    const h = harness();
    await h.client.request(LIST.op, LIST.method, LIST.path);
    h.keycloak.queuedStatuses.push(403);

    const error = await h.client.request(LIST.op, LIST.method, LIST.path).catch((e: unknown) => e);

    expect((error as AppError).code).toBe('KEYCLOAK_REJECTED');
    expect((error as AppError).httpStatus).toBe(500);
    expect((error as AppError).retryable).toBe(false);
    expect((error as AppError).message).not.toContain('queued');
  });

  it('does not treat a 500 as a success and retries it before reporting unavailable', async () => {
    const h = harness({ attempts: 2 });
    await h.client.request(LIST.op, LIST.method, LIST.path);
    h.keycloak.queuedStatuses.push(500, 500);
    expect(await codeOf(h.client.request(LIST.op, LIST.method, LIST.path))).toBe(
      'KEYCLOAK_UNAVAILABLE',
    );
  });
});

describe('createKeycloakAdminClient: observability and secret hygiene', () => {
  it('counts each logical call by operation and result', async () => {
    const h = harness();
    await h.client.request('list', 'GET', 'organizations');
    await h.client.request('get', 'GET', 'organizations/00000000-0000-4000-8000-000000000000');
    h.keycloak.queuedStatuses.push(403);
    await h.client.request('delete', 'DELETE', 'organizations/x').catch(() => undefined);

    const values = (await h.metrics.calls.get()).values;
    const count = (op: string, result: string): number | undefined =>
      values.find((v) => v.labels.op === op && v.labels.result === result)?.value;
    expect(count('list', 'ok')).toBe(1);
    expect(count('get', 'not_found')).toBe(1);
    expect(count('delete', 'error')).toBe(1);
  });

  it('never writes the access token or the client secret to the logs', async () => {
    const h = harness();
    await h.client.request('create', 'POST', 'organizations', { name: 'acme' });
    h.keycloak.revoked.add('tok-1');
    await h.client.request(LIST.op, LIST.method, LIST.path);
    h.keycloak.queuedStatuses.push(403);
    await h.client.request(LIST.op, LIST.method, LIST.path).catch(() => undefined);

    const logs = h.logs();
    expect(logs).toContain('keycloak admin call');
    expect(logs).not.toContain('tok-');
    expect(logs).not.toContain('secret-v1');
  });
});

describe('createKeycloakAdminClient: tracing', () => {
  it('opens one span per logical call with the op and result, and flags a failed call', async () => {
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    const h = harness({ tracer: provider.getTracer('test') });
    await h.client.request('list', 'GET', 'organizations');
    h.keycloak.queuedStatuses.push(403);
    await h.client.request('delete', 'DELETE', 'organizations/x').catch(() => undefined);

    const spans = exporter.getFinishedSpans();
    expect(spans.map((span) => span.name)).toEqual([
      'keycloak.admin.list',
      'keycloak.admin.delete',
    ]);
    expect(spans[0]?.attributes).toMatchObject({
      'bw.keycloak.op': 'list',
      'bw.keycloak.result': 'ok',
    });
    expect(spans[1]?.attributes).toMatchObject({ 'bw.keycloak.result': 'error' });
    expect(spans[1]?.status.code).toBe(SpanStatusCode.ERROR);
    expect(spans[0]?.status.code).not.toBe(SpanStatusCode.ERROR);
  });
});
