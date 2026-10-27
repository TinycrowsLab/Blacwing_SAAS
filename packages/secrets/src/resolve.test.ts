import { describe, expect, it, vi } from 'vitest';

import { createSecretResolver, SECRET_PURPOSES, type ResolveCaller } from './resolve.js';
import {
  envelopeFor,
  PLAINTEXT,
  REF,
  RUN_ID,
  SECRET_ID,
  setup,
  TENANT_A,
  TENANT_B,
} from './resolve.test-helpers.js';

const caller = (over: Partial<ResolveCaller> = {}): ResolveCaller => ({
  service: 'egress-gateway',
  tokenId: 'tok-1',
  tenantId: TENANT_A,
  ...over,
});
const login = { secretRef: REF, callerPurpose: SECRET_PURPOSES.assetLogin, runId: RUN_ID };

const code = async (p: Promise<unknown>): Promise<string> =>
  p.then(
    () => 'resolved',
    (e: unknown) => (e as { code: string }).code,
  );

describe('secret resolver', () => {
  it('resolves for an authorised service and audits the call through the real emitter', async () => {
    const { resolver, audited, outbox } = await setup();
    const result = await resolver.resolve(caller({ traceId: 'a'.repeat(32) }), login);
    expect(result).toEqual({ value: PLAINTEXT, version: 1, type: 'password' });
    expect(audited).toHaveLength(1);
    expect(audited[0]).toMatchObject({
      tenantId: TENANT_A,
      action: 'secret.resolved',
      actor: { type: 'service', id: 'egress-gateway', tokenId: 'tok-1' },
      target: { type: 'secret_ref', id: SECRET_ID },
      outcome: 'success',
      runId: RUN_ID,
      metadata: { callerService: 'egress-gateway', callerPurpose: 'asset_login', version: 1 },
    });
    // The event passed AuditEventSchema in the emitter and reached the outbox, without any value.
    expect(outbox).toHaveLength(1);
    expect(outbox[0]?.tenantId).toBe(TENANT_A);
    expect(JSON.stringify([audited, outbox])).not.toContain(PLAINTEXT);
  });

  it('writes the audit event before the value is returned and returns nothing if that fails', async () => {
    const order: string[] = [];
    const { resolver } = await setup({
      audit: () => {
        order.push('audit');
        return Promise.resolve();
      },
    });
    await resolver.resolve(caller(), login).then(() => order.push('returned'));
    expect(order).toEqual(['audit', 'returned']);

    const failing = await setup({ audit: () => Promise.reject(new Error('ledger down')) });
    const outcome = await failing.resolver.resolve(caller(), login).then(
      (v) => JSON.stringify(v),
      (e: unknown) => (e as { code: string }).code,
    );
    expect(outcome).toBe('INTERNAL');
  });

  it('denies a cross-tenant reference with TENANT_MISMATCH, before touching the store or the KEK', async () => {
    const { resolver, store, transit, audited } = await setup();
    const foreign = `bw-secret://${TENANT_B}/${SECRET_ID}`;
    expect(await code(resolver.resolve(caller(), { ...login, secretRef: foreign }))).toBe(
      'TENANT_MISMATCH',
    );
    expect(store.loads).toEqual([]);
    expect(transit.calls).toBe(1); // only the fixture's encrypt
    expect(audited[0]).toMatchObject({ outcome: 'denied', reason: 'TENANT_MISMATCH' });
  });

  it('does not find another tenant secret when the reference is forged to the caller tenant', async () => {
    const { resolver } = await setup();
    const other = '01900000-0000-7000-8000-0000000000c9';
    expect(
      await code(
        resolver.resolve(caller(), { ...login, secretRef: `bw-secret://${TENANT_A}/${other}` }),
      ),
    ).toBe('SECRET_NOT_FOUND');
  });

  describe('authorisation matrix', () => {
    it.each([
      ['egress-gateway', 'provider_key'],
      ['model-gateway', 'asset_login'],
      ['worker:connectors', 'asset_login'],
      ['worker:notify', 'provider_key'],
      ['session-manager', 'notify_channel'],
    ] as const)('denies %s asking for %s', async (service, purpose) => {
      const { resolver, transit } = await setup();
      const before = transit.calls;
      expect(
        await code(resolver.resolve(caller({ service }), { ...login, callerPurpose: purpose })),
      ).toBe('SECRET_PURPOSE_DENIED');
      expect(transit.calls).toBe(before);
    });

    it('denies when the stored purpose or type is not what the service may use', async () => {
      const { resolver, store, transit } = await setup();
      store.put({
        id: SECRET_ID,
        tenantId: TENANT_A,
        type: 'webhook_secret',
        purpose: SECRET_PURPOSES.assetLogin,
        backend: 'openbao',
        status: 'active',
        version: 1,
        envelope: await envelopeFor(transit, TENANT_A, SECRET_PURPOSES.assetLogin),
        externalLocator: null,
      });
      // webhook_secret is not a login credential type
      expect(await code(resolver.resolve(caller(), login))).toBe('SECRET_PURPOSE_DENIED');
      store.put({
        id: SECRET_ID,
        tenantId: TENANT_A,
        type: 'password',
        purpose: SECRET_PURPOSES.providerKey,
        backend: 'openbao',
        status: 'active',
        version: 1,
        envelope: await envelopeFor(transit, TENANT_A, SECRET_PURPOSES.providerKey),
        externalLocator: null,
      });
      expect(await code(resolver.resolve(caller(), login))).toBe('SECRET_PURPOSE_DENIED');
    });

    it('denies a secret with no stored purpose', async () => {
      const { resolver, store } = await setup();
      const record = [...store.records.values()][0];
      if (record === undefined) throw new Error('fixture');
      store.put({ ...record, purpose: null });
      expect(await code(resolver.resolve(caller(), login))).toBe('SECRET_PURPOSE_DENIED');
    });

    it('lets a Cedar decision narrow but never widen the matrix', async () => {
      const deny = await setup({ authorize: () => Promise.resolve(false) });
      expect(await code(deny.resolver.resolve(caller(), login))).toBe('SECRET_PURPOSE_DENIED');
      const boom = await setup({ authorize: () => Promise.reject(new Error('pdp down')) });
      expect(await code(boom.resolver.resolve(caller(), login))).toBe('SECRET_PURPOSE_DENIED');
      const query = vi.fn(() => Promise.resolve(true));
      const allow = await setup({ authorize: query });
      expect(await code(allow.resolver.resolve(caller(), login))).toBe('resolved');
      expect(query).toHaveBeenCalledWith({
        service: 'egress-gateway',
        tenantId: TENANT_A,
        secretId: SECRET_ID,
        purpose: 'asset_login',
        type: 'password',
        runId: RUN_ID,
      });
      // allowed by Cedar does not rescue a purpose outside the matrix
      expect(
        await code(
          allow.resolver.resolve(caller({ service: 'model-gateway' }), {
            ...login,
            callerPurpose: 'asset_login',
          }),
        ),
      ).toBe('SECRET_PURPOSE_DENIED');
    });
  });

  describe('runs and the kill switch', () => {
    it('requires a run for the services that inject into one', async () => {
      const { resolver } = await setup();
      const noRun = { secretRef: login.secretRef, callerPurpose: login.callerPurpose };
      expect(await code(resolver.resolve(caller(), noRun))).toBe('VALIDATION_FAILED');
    });

    it('denies a killed run before any decrypt, even with a warm cache', async () => {
      const { resolver, runs, transit } = await setup({ cacheTtlMs: 60_000 });
      await resolver.resolve(caller(), login);
      const decrypts = transit.calls;
      runs.standing = 'killed';
      expect(await code(resolver.resolve(caller(), login))).toBe('RUN_KILLED');
      expect(transit.calls).toBe(decrypts);
    });

    it('treats an unknown run or a run of another tenant as a tenant mismatch', async () => {
      const { resolver, runs } = await setup();
      runs.standing = 'unknown';
      expect(await code(resolver.resolve(caller(), login))).toBe('TENANT_MISMATCH');
      expect(runs.asked).toEqual([`${TENANT_A}/${RUN_ID}`]);
    });

    it('denies a run that is no longer active', async () => {
      const { resolver, runs } = await setup();
      runs.standing = 'inactive';
      expect(await code(resolver.resolve(caller(), login))).toBe('RUN_NOT_ACTIVE');
    });

    it('does not need a run for a worker service', async () => {
      const { resolver, store, transit } = await setup();
      store.put({
        id: SECRET_ID,
        tenantId: TENANT_A,
        type: 'api_key',
        purpose: SECRET_PURPOSES.connectorCredential,
        backend: 'openbao',
        status: 'active',
        version: 1,
        envelope: await envelopeFor(transit, TENANT_A, SECRET_PURPOSES.connectorCredential),
        externalLocator: null,
      });
      const result = await resolver.resolve(caller({ service: 'worker:connectors' }), {
        secretRef: REF,
        callerPurpose: SECRET_PURPOSES.connectorCredential,
      });
      expect(result).toEqual({ value: PLAINTEXT, version: 1, type: 'api_key' });
    });
  });

  describe('record state', () => {
    it.each([
      ['shredded', 'SECRET_SHREDDED'],
      ['disabled', 'SECRET_DISABLED'],
    ] as const)('refuses a %s secret with %s', async (status, expected) => {
      const { resolver, store, audited } = await setup();
      const record = [...store.records.values()][0];
      if (record === undefined) throw new Error('fixture');
      store.put({ ...record, status, envelope: status === 'shredded' ? null : record.envelope });
      expect(await code(resolver.resolve(caller(), login))).toBe(expected);
      expect(audited[0]).toMatchObject({ outcome: 'denied', reason: expected });
    });

    it('still resolves a secret being rotated', async () => {
      const { resolver, store } = await setup();
      const record = [...store.records.values()][0];
      if (record === undefined) throw new Error('fixture');
      store.put({ ...record, status: 'rotating' });
      expect(await code(resolver.resolve(caller(), login))).toBe('resolved');
    });

    it('passes a pinned version to the store and rejects an unknown one', async () => {
      const { resolver, store } = await setup();
      expect(await code(resolver.resolve(caller(), { ...login, secretRef: `${REF}?v=7` }))).toBe(
        'SECRET_NOT_FOUND',
      );
      expect(store.loads).toEqual([7]);
    });

    it('rejects a malformed reference and audits it without a secret id', async () => {
      const { resolver, audited } = await setup();
      expect(await code(resolver.resolve(caller(), { ...login, secretRef: 'nope' }))).toBe(
        'INVALID_SECRET_REF',
      );
      expect(audited[0]).toMatchObject({ target: { id: 'unparsed' }, outcome: 'denied' });
    });
  });

  describe('key and backend failures', () => {
    it('fails closed with KEK_UNAVAILABLE when the KEK is down', async () => {
      const { resolver, transit, audited } = await setup();
      transit.down = true;
      expect(await code(resolver.resolve(caller(), login))).toBe('KEK_UNAVAILABLE');
      expect(audited[0]).toMatchObject({ outcome: 'failure', reason: 'KEK_UNAVAILABLE' });
    });

    it('maps a raw crypto failure to KEK_UNAVAILABLE', async () => {
      const { resolver } = await setup({
        crypto: { decryptSecret: () => Promise.reject(new Error('connect ECONNREFUSED')) },
      });
      expect(await code(resolver.resolve(caller(), login))).toBe('KEK_UNAVAILABLE');
    });

    it('never serves the cache past its TTL when the KEK is down', async () => {
      let now = 1_000;
      const { resolver, transit } = await setup({ cacheTtlMs: 1000, now: () => now });
      await resolver.resolve(caller(), login);
      transit.down = true;
      now += 999;
      expect(await code(resolver.resolve(caller(), login))).toBe('resolved');
      now += 2;
      expect(await code(resolver.resolve(caller(), login))).toBe('KEK_UNAVAILABLE');
    });

    it('does not cache by default and keys the cache by reference and context', async () => {
      const off = await setup();
      await off.resolver.resolve(caller(), login);
      const before = off.transit.calls;
      await off.resolver.resolve(caller(), login);
      expect(off.transit.calls).toBe(before + 1);

      const on = await setup({ cacheTtlMs: 60_000 });
      await on.resolver.resolve(caller(), { ...login, context: { host: 'a' } });
      const warm = on.transit.calls;
      await on.resolver.resolve(caller(), { ...login, context: { host: 'a' } });
      expect(on.transit.calls).toBe(warm);
      await on.resolver.resolve(caller(), { ...login, context: { host: 'b' } });
      expect(on.transit.calls).toBe(warm + 1);
    });

    it('does not share a cached value with a service that is not allowed it', async () => {
      const { resolver } = await setup({ cacheTtlMs: 60_000 });
      await resolver.resolve(caller(), login);
      expect(await code(resolver.resolve(caller({ service: 'model-gateway' }), login))).toBe(
        'SECRET_PURPOSE_DENIED',
      );
    });

    it('answers EXTERNAL_BACKEND_UNAVAILABLE without an adapter, on a timeout and on an error', async () => {
      const external = {
        backend: 'aws_secrets_manager' as const,
        envelope: null,
        externalLocator: { arn: 'arn:aws:secretsmanager:eu-west-1:1:secret:x' },
      };
      const none = await setup();
      const record = [...none.store.records.values()][0];
      if (record === undefined) throw new Error('fixture');
      none.store.put({ ...record, ...external });
      expect(await code(none.resolver.resolve(caller(), login))).toBe(
        'EXTERNAL_BACKEND_UNAVAILABLE',
      );

      const slow = await setup({
        external: { fetch: () => new Promise(() => undefined) },
        externalTimeoutMs: 20,
      });
      slow.store.put({ ...record, ...external });
      expect(await code(slow.resolver.resolve(caller(), login))).toBe(
        'EXTERNAL_BACKEND_UNAVAILABLE',
      );

      const broken = await setup({ external: { fetch: () => Promise.reject(new Error('403')) } });
      broken.store.put({ ...record, ...external });
      expect(await code(broken.resolver.resolve(caller(), login))).toBe(
        'EXTERNAL_BACKEND_UNAVAILABLE',
      );

      const ok = await setup({ external: { fetch: () => Promise.resolve('byok-value') } });
      ok.store.put({ ...record, ...external });
      expect(await ok.resolver.resolve(caller(), login)).toEqual({
        value: 'byok-value',
        version: 1,
        type: 'password',
      });
    });

    it('rejects an openbao record that has no envelope', async () => {
      const { resolver, store } = await setup();
      const record = [...store.records.values()][0];
      if (record === undefined) throw new Error('fixture');
      store.put({ ...record, envelope: null });
      expect(await code(resolver.resolve(caller(), login))).toBe('ENVELOPE_INVALID');
    });

    it('rejects an envelope bound to another purpose (AAD)', async () => {
      const { resolver, store, transit } = await setup();
      const record = [...store.records.values()][0];
      if (record === undefined) throw new Error('fixture');
      store.put({ ...record, envelope: await envelopeFor(transit, TENANT_A, 'something_else') });
      expect(await code(resolver.resolve(caller(), login))).toBe('AAD_MISMATCH');
    });
  });

  describe('rate limit, metrics and logs', () => {
    it('limits each service separately and still audits the refusal', async () => {
      let now = 0;
      const { resolver, audited } = await setup({
        rateLimit: { limit: 2, windowMs: 60_000 },
        now: () => now,
      });
      await resolver.resolve(caller(), login);
      await resolver.resolve(caller(), login);
      const limited = await resolver.resolve(caller(), login).catch((e: unknown) => e);
      expect(limited).toMatchObject({ code: 'RATE_LIMITED', retryAfterSeconds: 60 });
      expect(audited.at(-1)).toMatchObject({ outcome: 'denied', reason: 'RATE_LIMITED' });
      // another service has its own budget
      expect(await code(resolver.resolve(caller({ service: 'session-manager' }), login))).toBe(
        'resolved',
      );
      now += 60_000;
      expect(await code(resolver.resolve(caller(), login))).toBe('resolved');
    });

    it('counts results, denials and latency, and logs without the value', async () => {
      const metrics = { resolved: vi.fn(), latency: vi.fn(), denied: vi.fn() };
      const log = vi.fn();
      const { resolver, runs } = await setup({ metrics, log });
      await resolver.resolve(caller(), login);
      runs.standing = 'killed';
      await code(resolver.resolve(caller(), login));
      expect(metrics.resolved).toHaveBeenNthCalledWith(1, 'egress-gateway', 'ok');
      expect(metrics.resolved).toHaveBeenNthCalledWith(2, 'egress-gateway', 'denied');
      expect(metrics.denied).toHaveBeenCalledWith('RUN_KILLED');
      expect(metrics.latency).toHaveBeenCalledTimes(2);
      expect(log).toHaveBeenCalledWith({
        tenantId: TENANT_A,
        secretId: SECRET_ID,
        callerService: 'egress-gateway',
        runId: RUN_ID,
        outcome: 'success',
      });
      expect(JSON.stringify(log.mock.calls)).not.toContain(PLAINTEXT);
    });

    it('keeps the plaintext out of every error and audit event', async () => {
      const { resolver, transit, audited } = await setup();
      transit.down = true;
      const error = await resolver.resolve(caller(), login).catch((e: unknown) => e);
      expect(JSON.stringify([error, audited, String(error)])).not.toContain(PLAINTEXT);
    });
  });

  it('is constructible with only the required ports', async () => {
    const { deps } = await setup();
    expect(() => createSecretResolver(deps)).not.toThrow();
  });
});
