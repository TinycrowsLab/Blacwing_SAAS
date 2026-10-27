import { describe, expect, it } from 'vitest';

import { SECRET_VALUE_MAX_BYTES } from '@blackwing/contracts';
import { SECRET_VALUE_PURPOSE } from '@blackwing/secrets';

import {
  admin,
  adminB,
  freshKey,
  harness,
  type Harness,
  NON_ADMIN_ROLES,
  principal,
  TENANT_A,
  TENANT_B,
  VALUE,
} from './fixtures.test-helpers.js';
import { SECRET_WRITE_SPAN } from './service.js';

import type { SecretPrincipal } from './ports.js';

const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';

const body = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: 'staging-api-key',
  type: 'api_key',
  purpose: 'authenticated scans',
  value: VALUE,
  ...overrides,
});

/** The error `fn` rejects with, or `undefined` when it resolves. */
async function rejection(
  fn: () => Promise<unknown>,
): Promise<{ code?: string; detail?: string } | undefined> {
  try {
    await fn();
  } catch (err) {
    return err as { code?: string; detail?: string };
  }
  return undefined;
}

/** The stable `code` of what `fn` rejects with, or `undefined` when it resolves. */
async function codeOf(fn: () => Promise<unknown>): Promise<unknown> {
  return (await rejection(fn))?.code;
}

/** `key: null` sends no Idempotency-Key; `payload: null` sends no body. */
const create = (
  h: Harness,
  who: SecretPrincipal = admin,
  payload: unknown = body(),
  key: string | null = freshKey(),
) =>
  h.service.create({
    principal: who,
    body: payload,
    idempotencyKey: key ?? undefined,
    traceId: TRACE,
  });

const update = (
  h: Harness,
  secretId: string,
  payload: unknown = { value: 'v2-' + VALUE },
  ifMatch?: string,
  who: SecretPrincipal = admin,
) => h.service.update({ principal: who, secretId, body: payload, ifMatch, traceId: TRACE });

const remove = (h: Harness, secretId: string, force = false, who: SecretPrincipal = admin) =>
  h.service.delete({ principal: who, secretId, force, traceId: TRACE });

const get = (h: Harness, secretId: string, who: SecretPrincipal = admin) =>
  h.service.get({ principal: who, secretId, traceId: TRACE });

/** Everything a test run could have leaked into: logs, audit, spans, metrics, store views. */
async function sinks(h: Harness): Promise<string> {
  return [
    h.logs.join('\n'),
    JSON.stringify(h.audit.records),
    JSON.stringify(
      h.spans.getFinishedSpans().map((s) => ({ a: s.attributes, e: s.events, n: s.name })),
    ),
    await h.metrics.registry.metrics(),
  ].join('\n');
}

describe('create', () => {
  it('returns the reference and version 1 and never the value', async () => {
    const h = harness();
    const { response, created } = await create(h);
    expect(created).toBe(true);
    expect(Object.keys(response).sort()).toEqual(['secretId', 'secretRef', 'version']);
    expect(response.version).toBe(1);
    expect(response.secretRef).toBe(`bw-secret://${TENANT_A}/${response.secretId}`);
    expect(JSON.stringify(response)).not.toContain(VALUE);
  });

  it('stores only ciphertext; the value comes back only through the internal decrypt path', async () => {
    const h = harness();
    const { response } = await create(h);
    const envelope = h.store.envelopeOf(TENANT_A, response.secretId, 1);
    expect(envelope).toBeDefined();
    if (envelope === undefined) return;
    expect(JSON.stringify(envelope)).not.toContain(VALUE);
    // The resolver (SECRETS-006) decrypts with the same tenant, secret id and purpose.
    const plaintext = await h.crypto.decryptSecret(envelope, {
      tenantId: TENANT_A,
      context: { secretId: response.secretId, purpose: SECRET_VALUE_PURPOSE },
    });
    expect(plaintext.toString('utf8')).toBe(VALUE);
    // ...and not as another secret, another tenant or another purpose.
    expect(
      await codeOf(() =>
        h.crypto.decryptSecret(envelope, {
          tenantId: TENANT_A,
          context: {
            secretId: '0190f6a2-7b1c-7d2e-8f3a-abcdef012345',
            purpose: SECRET_VALUE_PURPOSE,
          },
        }),
      ),
    ).toBe('AAD_MISMATCH');
  });

  it('keeps the value out of logs, audit events, spans and metrics', async () => {
    const h = harness();
    await create(h);
    await create(h, admin, body({ name: 'second', value: 'second-' + VALUE }));
    await codeOf(() => create(h, admin, body())); // name conflict path
    expect(await sinks(h)).not.toContain(VALUE);
  });

  it('stores the value exactly as given: nothing is trimmed or normalised', async () => {
    const h = harness();
    const padded = ' \tpem\n-----END-----\n ';
    const { response } = await create(h, admin, body({ value: padded }));
    const envelope = h.store.envelopeOf(TENANT_A, response.secretId, 1);
    if (envelope === undefined) throw new Error('no envelope');
    const plaintext = await h.crypto.decryptSecret(envelope, {
      tenantId: TENANT_A,
      context: { secretId: response.secretId, purpose: SECRET_VALUE_PURPOSE },
    });
    expect(plaintext.toString('utf8')).toBe(padded);
  });

  it('defaults to the openbao backend with no type or purpose', async () => {
    const h = harness();
    const { response } = await create(h, admin, { name: 'bare', value: VALUE });
    expect(await get(h, response.secretId)).toMatchObject({
      backend: 'openbao',
      type: null,
      purpose: null,
      status: 'active',
      currentVersion: 1,
    });
  });

  it.each([
    ['an external backend (needs a locator flow)', body({ backend: 'aws_kms' })],
    ['an unknown field (no envelope smuggling)', body({ envelope: { v: 1 } })],
    ['a status', body({ status: 'disabled' })],
    ['an empty value', body({ value: '' })],
    ['a NUL in the value', body({ value: 'ab\u0000cd' })],
    ['a lone surrogate', body({ value: 'ab\uD800cd' })],
    ['a missing value', { name: 'x' }],
    ['a missing name', { value: VALUE }],
    ['an empty name', body({ name: '' })],
    ['a control character in the name', body({ name: 'bad\u0007name' })],
    ['a line separator in the name', body({ name: 'bad name' })],
    ['an unknown type', body({ type: 'nope' })],
    ['a control character in the purpose', body({ purpose: 'x\ny' })],
    ['a non-string value', body({ value: 42 })],
    ['a non-object body', 'text'],
    ['an array body', [body()]],
    ['no body', null],
  ])('rejects %s with VALIDATION_FAILED', async (_why, payload) => {
    const h = harness();
    expect(await codeOf(() => create(h, admin, payload))).toBe('VALIDATION_FAILED');
    expect(h.store.count(TENANT_A).secrets).toBe(0);
  });

  it('names the invalid fields but never echoes the input', async () => {
    const h = harness();
    const empty = await rejection(() => create(h, admin, body({ name: '', value: '' })));
    expect(empty?.detail).toBe('invalid fields: name, value');
    const extra = await rejection(() => create(h, admin, body({ extra: VALUE })));
    expect(extra).toBeDefined();
    expect(JSON.stringify(extra)).not.toContain(VALUE);
    expect(extra?.detail ?? '').not.toContain(VALUE);
  });

  it('accepts a value of exactly the limit and rejects one byte more with SECRET_TOO_LARGE', async () => {
    const h = harness();
    const ok = await create(
      h,
      admin,
      body({ name: 'max', value: 'a'.repeat(SECRET_VALUE_MAX_BYTES) }),
    );
    expect(ok.created).toBe(true);
    expect(
      await codeOf(() =>
        create(h, admin, body({ name: 'big', value: 'a'.repeat(SECRET_VALUE_MAX_BYTES + 1) })),
      ),
    ).toBe('SECRET_TOO_LARGE');
    // The limit is in bytes, not characters: 3-byte characters hit it sooner.
    const wide = '€'.repeat(Math.floor(SECRET_VALUE_MAX_BYTES / 3) + 1);
    expect(wide.length).toBeLessThan(SECRET_VALUE_MAX_BYTES);
    expect(await codeOf(() => create(h, admin, body({ name: 'wide', value: wide })))).toBe(
      'SECRET_TOO_LARGE',
    );
    expect(h.store.count(TENANT_A).secrets).toBe(1);
  });

  it('answers SECRET_NAME_CONFLICT for a duplicate name and keeps the first secret', async () => {
    const h = harness();
    const first = await create(h);
    expect(await codeOf(() => create(h))).toBe('SECRET_NAME_CONFLICT');
    expect(h.store.count(TENANT_A)).toEqual({ secrets: 1, versions: 1 });
    expect(await get(h, first.response.secretId)).toMatchObject({ name: 'staging-api-key' });
    // A different tenant may use the same name.
    expect((await create(h, adminB)).created).toBe(true);
  });

  it('treats canonically equal names as one (NFC)', async () => {
    const h = harness();
    await create(h, admin, body({ name: 'café' }));
    expect(await codeOf(() => create(h, admin, body({ name: 'café' })))).toBe(
      'SECRET_NAME_CONFLICT',
    );
  });

  it('fails closed when the tenant key is unavailable: nothing persisted, no success audit', async () => {
    const h = harness();
    h.transit.down = true;
    expect(await codeOf(() => create(h))).toBe('KEK_UNAVAILABLE');
    expect(h.store.count(TENANT_A)).toEqual({ secrets: 0, versions: 0 });
    expect(h.audit.records).toEqual([]);
    expect(await h.metrics.registry.metrics()).toContain(
      'secret_write_total{op="create",result="unavailable"} 1',
    );
    // Once the key is back, the same request succeeds.
    h.transit.down = false;
    expect((await create(h)).created).toBe(true);
  });
});

describe('Idempotency-Key on create', () => {
  it('dedupes a retry: one secret, the first answer, created=false', async () => {
    const h = harness();
    const key = freshKey();
    const first = await create(h, admin, body(), key);
    const second = await create(h, admin, body(), key);
    expect(second.created).toBe(false);
    expect(second.response).toEqual(first.response);
    expect(h.store.count(TENANT_A)).toEqual({ secrets: 1, versions: 1 });
    expect(h.audit.records.filter((r) => r.action === 'secret.created')).toHaveLength(1);
  });

  it('replays version 1 even after the secret moved on', async () => {
    const h = harness();
    const key = freshKey();
    const first = await create(h, admin, body(), key);
    await update(h, first.response.secretId);
    expect((await create(h, admin, body(), key)).response.version).toBe(1);
  });

  it('refuses the same key with a different request, including a different value', async () => {
    const h = harness();
    const key = freshKey();
    await create(h, admin, body(), key);
    for (const changed of [
      body({ value: 'other-' + VALUE }),
      body({ name: 'other-name' }),
      body({ purpose: 'other' }),
      body({ type: 'token' }),
    ]) {
      expect(await codeOf(() => create(h, admin, changed, key))).toBe('IDEMPOTENCY_KEY_MISMATCH');
    }
    expect(h.store.count(TENANT_A).secrets).toBe(1);
  });

  it('scopes keys to the tenant', async () => {
    const h = harness();
    const key = freshKey();
    await create(h, admin, body(), key);
    const other = await create(h, adminB, body(), key);
    expect(other.created).toBe(true);
    expect(h.store.count(TENANT_B).secrets).toBe(1);
  });

  it('requires a well-formed key', async () => {
    const h = harness();
    for (const key of [null, '', 'short', 'has space in it', 'x'.repeat(256)]) {
      expect(await codeOf(() => create(h, admin, body(), key))).toBe('IDEMPOTENCY_KEY_REQUIRED');
    }
    expect(h.store.count(TENANT_A).secrets).toBe(0);
  });

  it('stores a fingerprint that is keyed by the Idempotency-Key, not a bare hash of the value', async () => {
    const h = harness();
    const { createHash } = await import('node:crypto');
    const fingerprintFor = async (key: string, name: string): Promise<string> => {
      await create(h, admin, body({ name }), key);
      const found = await h.store.findByIdempotencyKey(
        TENANT_A,
        createHash('sha256').update(key, 'utf8').digest('hex'),
      );
      if (found === null) throw new Error('key not bound');
      return found.fingerprint;
    };
    const a = await fingerprintFor('first-key-0001', 'same-1');
    const b = await fingerprintFor('second-key-0002', 'same-2');
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
    expect(a).not.toBe(createHash('sha256').update(VALUE).digest('hex'));
  });
});

describe('authorization', () => {
  it.each(NON_ADMIN_ROLES)(
    'denies %s on every operation with FORBIDDEN and an audit event',
    async (role) => {
      const h = harness();
      const { response } = await create(h);
      const who = principal([role]);
      const before = h.audit.records.length;
      const calls: (() => Promise<unknown>)[] = [
        () => create(h, who, body({ name: 'denied' })),
        () => update(h, response.secretId, undefined, undefined, who),
        () => remove(h, response.secretId, false, who),
        () => get(h, response.secretId, who),
        () => h.service.list({ principal: who, query: {}, traceId: TRACE }),
      ];
      for (const call of calls) expect(await codeOf(call)).toBe('FORBIDDEN');
      const denied = h.audit.records.slice(before);
      expect(denied).toHaveLength(calls.length);
      for (const record of denied) {
        expect(record).toMatchObject({
          action: 'authz.denied',
          outcome: 'denied',
          severity: 'warning',
          tenantId: TENANT_A,
          actor: { type: 'user' },
        });
      }
      // Nothing changed.
      expect(h.store.count(TENANT_A)).toEqual({ secrets: 1, versions: 1 });
      expect(await get(h, response.secretId)).toMatchObject({
        status: 'active',
        currentVersion: 1,
      });
    },
  );

  it('denies before validating or encrypting (a non-admin learns nothing from a bad body)', async () => {
    const h = harness();
    h.transit.down = true;
    expect(await codeOf(() => create(h, principal(['developer']), 'garbage', null))).toBe(
      'FORBIDDEN',
    );
  });

  it('denies an unknown role and an empty role list', async () => {
    const h = harness();
    expect(await codeOf(() => create(h, principal(['superuser'])))).toBe('FORBIDDEN');
    expect(await codeOf(() => create(h, principal([])))).toBe('FORBIDDEN');
  });

  it('refuses a principal without a tenant as UNAUTHENTICATED', async () => {
    const h = harness();
    const noTenant = principal(['org_admin'], { tenantId: null });
    expect(await codeOf(() => create(h, noTenant))).toBe('UNAUTHENTICATED');
    expect(await codeOf(() => get(h, TENANT_A, noTenant))).toBe('UNAUTHENTICATED');
    expect(
      await codeOf(() => h.service.list({ principal: noTenant, query: {}, traceId: null })),
    ).toBe('UNAUTHENTICATED');
  });

  it('isolates tenants: another tenant gets NOT_FOUND on read, update and delete, and sees nothing in a list', async () => {
    const h = harness();
    const { response } = await create(h);
    expect(await codeOf(() => get(h, response.secretId, adminB))).toBe('NOT_FOUND');
    expect(await codeOf(() => update(h, response.secretId, undefined, undefined, adminB))).toBe(
      'NOT_FOUND',
    );
    expect(await codeOf(() => remove(h, response.secretId, true, adminB))).toBe('NOT_FOUND');
    expect((await h.service.list({ principal: adminB, query: {}, traceId: null })).items).toEqual(
      [],
    );
    expect(await get(h, response.secretId)).toMatchObject({ status: 'active', currentVersion: 1 });
  });

  it('answers NOT_FOUND for a malformed id', async () => {
    const h = harness();
    expect(await codeOf(() => get(h, 'not-a-uuid'))).toBe('NOT_FOUND');
    expect(await codeOf(() => remove(h, '../../etc'))).toBe('NOT_FOUND');
  });
});

describe('metadata reads', () => {
  it('returns metadata only: no value, no envelope, nothing but the documented fields', async () => {
    const h = harness();
    const { response } = await create(h);
    const view = await get(h, response.secretId);
    expect(Object.keys(view).sort()).toEqual(
      [
        'backend',
        'createdAt',
        'currentVersion',
        'name',
        'purpose',
        'secretId',
        'secretRef',
        'status',
        'type',
        'updatedAt',
      ].sort(),
    );
    const page = await h.service.list({ principal: admin, query: {}, traceId: null });
    for (const text of [JSON.stringify(view), JSON.stringify(page)]) {
      expect(text).not.toContain(VALUE);
      expect(text).not.toMatch(/envelope|wrappedDek|"value"|ciphertext|"ct"/);
    }
  });

  it('pages a list by cursor in creation order and clamps the limit', async () => {
    const h = harness();
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      ids.push((await create(h, admin, body({ name: `s-${String(i)}` }))).response.secretId);
    }
    const first = await h.service.list({ principal: admin, query: { limit: '2' }, traceId: null });
    expect(first.items.map((s) => s.secretId)).toEqual(ids.slice(0, 2));
    expect(first.hasMore).toBe(true);
    const second = await h.service.list({
      principal: admin,
      query: { limit: '2', cursor: first.nextCursor },
      traceId: null,
    });
    expect(second.items.map((s) => s.secretId)).toEqual(ids.slice(2, 4));
    const last = await h.service.list({
      principal: admin,
      query: { cursor: second.nextCursor },
      traceId: null,
    });
    expect(last.items.map((s) => s.secretId)).toEqual(ids.slice(4));
    expect(last).toMatchObject({ hasMore: false, nextCursor: null });
    const huge = await h.service.list({
      principal: admin,
      query: { limit: '999999' },
      traceId: null,
    });
    expect(huge.items).toHaveLength(5);
  });

  it.each([
    { limit: '0' },
    { limit: '-1' },
    { limit: 'many' },
    { cursor: 'nope' },
    { limit: ['1', '2'] },
  ])('rejects the page query %j', async (query) => {
    const h = harness();
    expect(await codeOf(() => h.service.list({ principal: admin, query, traceId: null }))).toBe(
      'VALIDATION_FAILED',
    );
  });
});

describe('update', () => {
  it('stores a new version, increments currentVersion and keeps the old version', async () => {
    const h = harness();
    const { response } = await create(h);
    const { response: updated } = await update(h, response.secretId, { value: 'second-' + VALUE });
    expect(updated).toEqual({
      secretId: response.secretId,
      secretRef: response.secretRef,
      version: 2,
    });
    expect(await get(h, response.secretId)).toMatchObject({ currentVersion: 2 });
    expect(h.store.count(TENANT_A)).toEqual({ secrets: 1, versions: 2 });
    const v1 = h.store.envelopeOf(TENANT_A, response.secretId, 1);
    const v2 = h.store.envelopeOf(TENANT_A, response.secretId, 2);
    expect(v1?.ct).not.toBe(v2?.ct);
    expect(JSON.stringify(updated)).not.toContain('second-');
    expect(await sinks(h)).not.toContain('second-' + VALUE);
  });

  it('honours a matching If-Match and answers 412 for a stale one', async () => {
    const h = harness();
    const { response } = await create(h);
    await update(h, response.secretId, undefined, '"v1"');
    expect(await codeOf(() => update(h, response.secretId, undefined, '"v1"'))).toBe(
      'PRECONDITION_FAILED',
    );
    expect(await get(h, response.secretId)).toMatchObject({ currentVersion: 2 });
    expect(h.store.count(TENANT_A).versions).toBe(2);
    // `*` means "any existing version".
    await update(h, response.secretId, undefined, '*');
    expect(await get(h, response.secretId)).toMatchObject({ currentVersion: 3 });
  });

  it('answers 428 for a weak or malformed If-Match and updates without one', async () => {
    const h = harness();
    const { response } = await create(h);
    for (const header of ['W/"v1"', 'v1', '"v1", garbage', '']) {
      expect(await codeOf(() => update(h, response.secretId, undefined, header))).toBe(
        'PRECONDITION_REQUIRED',
      );
    }
    expect(await get(h, response.secretId)).toMatchObject({ currentVersion: 1 });
    await update(h, response.secretId);
    expect(await get(h, response.secretId)).toMatchObject({ currentVersion: 2 });
  });

  it('lets exactly one of two concurrent updates with the same If-Match win', async () => {
    const h = harness();
    const { response } = await create(h);
    const results = await Promise.allSettled([
      update(h, response.secretId, { value: 'a-' + VALUE }, '"v1"'),
      update(h, response.secretId, { value: 'b-' + VALUE }, '"v1"'),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({
      reason: { code: 'PRECONDITION_FAILED' },
    });
    expect(h.store.count(TENANT_A).versions).toBe(2);
  });

  it('refuses to change a disabled secret and an unknown one', async () => {
    const h = harness();
    const { response } = await create(h);
    await remove(h, response.secretId);
    expect(await codeOf(() => update(h, response.secretId))).toBe('CONFLICT');
    expect(await codeOf(() => update(h, '0190f6a2-7b1c-7d2e-8f3a-abcdef012345'))).toBe('NOT_FOUND');
    expect(h.store.count(TENANT_A).versions).toBe(1);
  });

  it('validates the new value like a create (empty, oversized, extra fields) and fails closed on KEK loss', async () => {
    const h = harness();
    const { response } = await create(h);
    expect(await codeOf(() => update(h, response.secretId, { value: '' }))).toBe(
      'VALIDATION_FAILED',
    );
    expect(await codeOf(() => update(h, response.secretId, { value: VALUE, name: 'x' }))).toBe(
      'VALIDATION_FAILED',
    );
    expect(
      await codeOf(() =>
        update(h, response.secretId, { value: 'a'.repeat(SECRET_VALUE_MAX_BYTES + 1) }),
      ),
    ).toBe('SECRET_TOO_LARGE');
    h.transit.down = true;
    expect(await codeOf(() => update(h, response.secretId))).toBe('KEK_UNAVAILABLE');
    expect(h.store.count(TENANT_A).versions).toBe(1);
  });
});

describe('delete', () => {
  it('disables the secret (soft delete) and keeps its metadata and versions', async () => {
    const h = harness();
    const { response } = await create(h);
    await remove(h, response.secretId);
    expect(await get(h, response.secretId)).toMatchObject({ status: 'disabled' });
    expect(h.store.count(TENANT_A)).toEqual({ secrets: 1, versions: 1 });
    expect(h.store.envelopeOf(TENANT_A, response.secretId, 1)).toBeDefined();
  });

  it('is idempotent: a second delete changes and audits nothing', async () => {
    const h = harness();
    const { response } = await create(h);
    await remove(h, response.secretId);
    await remove(h, response.secretId);
    expect(h.audit.records.filter((r) => r.action === 'secret.deleted')).toHaveLength(1);
  });

  it('blocks a secret still in use, naming the resource types, until force is given', async () => {
    const h = harness();
    const { response } = await create(h);
    h.references.push(
      { tenantId: TENANT_A, secretId: response.secretId, resourceType: 'asset_credential' },
      { tenantId: TENANT_A, secretId: response.secretId, resourceType: 'connector' },
      { tenantId: TENANT_A, secretId: response.secretId, resourceType: 'connector' },
      { tenantId: TENANT_B, secretId: response.secretId, resourceType: 'other_tenant_thing' },
    );
    const blocked = await rejection(() => remove(h, response.secretId));
    expect(blocked?.code).toBe('SECRET_IN_USE');
    expect(blocked?.detail).toContain('asset_credential, connector');
    expect(blocked?.detail).not.toContain('other_tenant_thing');
    expect(await get(h, response.secretId)).toMatchObject({ status: 'active' });
    await remove(h, response.secretId, true);
    expect(await get(h, response.secretId)).toMatchObject({ status: 'disabled' });
    expect(h.audit.records.find((r) => r.action === 'secret.deleted')?.metadata).toMatchObject({
      forced: true,
      referencedBy: 'asset_credential,connector',
    });
  });

  it('answers NOT_FOUND for an unknown secret', async () => {
    const h = harness();
    expect(await codeOf(() => remove(h, '0190f6a2-7b1c-7d2e-8f3a-abcdef012345'))).toBe('NOT_FOUND');
  });
});

describe('audit, metrics and tracing', () => {
  it('emits secret.created, secret.updated and secret.deleted with the secret id and never the value', async () => {
    const h = harness();
    const { response } = await create(h);
    await update(h, response.secretId);
    await remove(h, response.secretId);
    expect(h.audit.records.map((r) => r.action)).toEqual([
      'secret.created',
      'secret.updated',
      'secret.deleted',
    ]);
    for (const record of h.audit.records) {
      expect(record).toMatchObject({
        severity: 'notice',
        outcome: 'success',
        tenantId: TENANT_A,
        actor: { type: 'user', id: admin.id },
        target: { type: 'secret_ref', id: response.secretId },
        traceId: TRACE,
        occurredAt: '2026-10-22T10:00:00.000Z',
        metadata: { secretId: response.secretId },
      });
    }
    expect(h.audit.records[1]?.metadata).toMatchObject({ version: 2 });
    expect(JSON.stringify(h.audit.records)).not.toContain(VALUE);
  });

  it('records a token id on the audit actor', async () => {
    const h = harness();
    await create(h, principal(['org_admin'], { type: 'service', tokenId: 'tok_123' }));
    expect(h.audit.records[0]?.actor).toEqual({
      type: 'service',
      id: admin.id,
      tokenId: 'tok_123',
    });
  });

  it('counts writes as secret_write_total{op,result}', async () => {
    const h = harness();
    const { response } = await create(h);
    await codeOf(() => create(h)); // conflict
    await codeOf(() => create(h, principal(['developer'])));
    await update(h, response.secretId);
    await remove(h, response.secretId);
    await codeOf(() => remove(h, '0190f6a2-7b1c-7d2e-8f3a-abcdef012345'));
    const text = await h.metrics.registry.metrics();
    for (const line of [
      'secret_write_total{op="create",result="success"} 1',
      'secret_write_total{op="create",result="conflict"} 1',
      'secret_write_total{op="create",result="denied"} 1',
      'secret_write_total{op="update",result="success"} 1',
      'secret_write_total{op="delete",result="success"} 1',
      'secret_write_total{op="delete",result="not_found"} 1',
    ]) {
      expect(text).toContain(line);
    }
  });

  it('opens a secret.write span per write with the op and tenant, and marks failures', async () => {
    const h = harness();
    await create(h);
    await codeOf(() => create(h));
    const spans = h.spans.getFinishedSpans().filter((s) => s.name === SECRET_WRITE_SPAN);
    expect(spans).toHaveLength(2);
    expect(spans[0]?.attributes).toMatchObject({
      'bw.secret.op': 'create',
      'bw.tenant_id': TENANT_A,
    });
    expect(spans[0]?.status.code).toBe(0);
    expect(spans[1]?.status.code).toBe(2);
  });

  it('logs only tenantId, secretId and op for a write', async () => {
    const h = harness();
    const { response } = await create(h);
    const line = h.logs
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .find((l) => l.op === 'create');
    expect(line).toMatchObject({ tenantId: TENANT_A, secretId: response.secretId, op: 'create' });
    expect(Object.keys(line ?? {})).not.toContain('value');
  });

  it('survives a failing audit sink on a denial (the refusal still stands)', async () => {
    const h = harness();
    const failing = { append: () => Promise.reject(new Error('ledger down')) };
    const { SecretService } = await import('./service.js');
    const { createCedarSecretPolicy } = await import('./policy.js');
    const service = new SecretService({
      store: h.store,
      usage: { referencingTypes: () => Promise.resolve([]) },
      crypto: h.crypto,
      audit: failing,
      policy: createCedarSecretPolicy(),
      logger: (await import('@blackwing/logger')).createLogger('t', { level: 'silent' }),
      metrics: h.metrics,
    });
    const err = await service
      .create({
        principal: principal(['developer']),
        body: body(),
        idempotencyKey: freshKey(),
        traceId: null,
      })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'FORBIDDEN' });
    expect(await h.metrics.registry.metrics()).toContain(
      'secret_audit_failures_total{action="authz.denied"} 1',
    );
  });
});
