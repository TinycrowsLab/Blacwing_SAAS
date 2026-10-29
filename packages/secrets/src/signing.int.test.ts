// Standing-authorisation JWS signing against a real OpenBao dev server (AUTHZ-004, #376): sign then
// verify with the exported JWK, rotation keeps old signatures verifiable, and an OpenBao failure fails
// closed with no audit trail. Needs Docker (Testcontainers); run with
// `pnpm --filter @blackwing/secrets test:int`.

import { createPublicKey, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type OpenBaoHandle, withOpenBao } from '@blackwing/testing/containers';

import { createOpenBaoClient, type OpenBaoClient } from './openbao.js';
import {
  createSigningKeyService,
  type SigningAuditEvent,
  type SigningKeyService,
} from './signing.js';

let bao: OpenBaoHandle | undefined;
const handle = (): OpenBaoHandle => {
  if (bao === undefined) throw new Error('withOpenBao did not start');
  return bao;
};

async function root(method: string, path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${handle().addr}/v1/${path}`, {
    method,
    headers: { 'x-vault-token': handle().rootToken, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}`);
  const text = await res.text();
  return text ? JSON.parse(text) : undefined;
}

const policy = (name: string): string =>
  readFileSync(
    new URL(`../../../infra/compose/openbao/policies/${name}.hcl`, import.meta.url),
    'utf8',
  );

async function roleClient(role: string, secretIdOverride?: string): Promise<OpenBaoClient> {
  await root('PUT', `sys/policies/acl/${role}`, { policy: policy(role) });
  await root('POST', `auth/approle/role/${role}`, { token_policies: [role] });
  const roleId = (
    (await root('GET', `auth/approle/role/${role}/role-id`)) as { data: { role_id: string } }
  ).data.role_id;
  const secretId =
    secretIdOverride ??
    (
      (await root('POST', `auth/approle/role/${role}/secret-id`, {})) as {
        data: { secret_id: string };
      }
    ).data.secret_id;
  return createOpenBaoClient({ addr: handle().addr, roleId, secretId });
}

const TENANT = '0190a3c0-0000-7000-8000-0000000000aa';
const SA_ID = '0190a3c0-0000-7000-8000-000000000001';
const KEY = 'bw-sa-signing';
const body = new TextEncoder().encode('{"id":"sa-1","maxIntrusiveness":"safe"}');

let service: SigningKeyService;
const events: SigningAuditEvent[] = [];

/** Verifies a compact detached JWS against the body, using only the JWK Set the verifier would load. */
function verifyWithJwks(
  compact: string,
  canonical: Uint8Array,
  jwks: readonly { kid: string; x: string; kty: string; crv: string }[],
): boolean {
  const [header = '', , signature = ''] = compact.split('.');
  const { kid } = JSON.parse(Buffer.from(header, 'base64url').toString('utf8')) as { kid: string };
  const jwk = jwks.find((k) => k.kid === kid);
  if (jwk === undefined) return false;
  const signingInput = new TextEncoder().encode(
    `${header}.${Buffer.from(canonical).toString('base64url')}`,
  );
  const publicKey = createPublicKey({
    key: { kty: jwk.kty, crv: jwk.crv, x: jwk.x },
    format: 'jwk',
  });
  return verify(null, signingInput, publicKey, Buffer.from(signature, 'base64url'));
}

beforeAll(async () => {
  bao = await withOpenBao();
  await root('POST', 'sys/auth/approle', { type: 'approle' });
  await root('POST', 'sys/mounts/transit', { type: 'transit' });
  // Created like the bootstrap does: Ed25519, non-exportable, no plaintext backup.
  await root('POST', `transit/keys/${KEY}`, {
    type: 'ed25519',
    exportable: false,
    allow_plaintext_backup: false,
  });
  const signer = await roleClient('bw-sa-signing');
  service = createSigningKeyService({
    client: signer,
    audit: (e) => {
      events.push(e);
      return Promise.resolve();
    },
  });
});

afterAll(async () => {
  await bao?.stop();
});

describe('SA envelope signing against OpenBao', () => {
  it('signs the canonical envelope and the signature verifies with the exported JWK for its kid', async () => {
    const signed = await service.signEnvelope({
      tenantId: TENANT,
      saId: SA_ID,
      canonicalBytes: body,
    });
    expect(signed.signingKeyId).toBe(`${KEY}:v1`);
    const { keys } = await service.getPublicJwks();
    expect(verifyWithJwks(signed.signature, body, keys)).toBe(true);
    // The verifier re-derives the payload: a re-serialised body must not verify.
    const reserialised = new TextEncoder().encode('{"id":"sa-1","maxIntrusiveness":"destructive"}');
    expect(verifyWithJwks(signed.signature, reserialised, keys)).toBe(false);
  });

  it('audits the signing with the key id and the envelope hash, never the signature', async () => {
    const signed = await service.signEnvelope({
      tenantId: TENANT,
      saId: SA_ID,
      canonicalBytes: body,
    });
    const last = events.at(-1);
    expect(last).toMatchObject({
      tenantId: TENANT,
      action: 'authz.sa.signed',
      metadata: {
        sa_id: SA_ID,
        signing_key_id: signed.signingKeyId,
        envelope_hash: signed.envelopeHash,
      },
    });
    expect(JSON.stringify(last)).not.toContain(signed.signature);
  });

  it('rotation makes new SAs use v2 while an SA signed with v1 still verifies', async () => {
    const before = await service.signEnvelope({
      tenantId: TENANT,
      saId: SA_ID,
      canonicalBytes: body,
    });
    const rotated = await service.rotateSigningKey(TENANT);
    expect(rotated).toEqual({ keyName: KEY, latestVersion: 2 });
    const after = await service.signEnvelope({
      tenantId: TENANT,
      saId: SA_ID,
      canonicalBytes: body,
    });
    expect(after.signingKeyId).toBe(`${KEY}:v2`);
    const { keys } = await service.getPublicJwks();
    expect(keys.map((k) => k.kid)).toEqual([`${KEY}:v1`, `${KEY}:v2`]);
    expect(verifyWithJwks(before.signature, body, keys)).toBe(true);
    expect(verifyWithJwks(after.signature, body, keys)).toBe(true);
    expect(events.some((e) => e.action === 'authz.signing_key.rotated')).toBe(true);
  });

  it('fails closed when OpenBao refuses the signer: AUTHZ_SIGNER_UNAVAILABLE, nothing audited', async () => {
    const countBefore = events.length;
    const denied = createSigningKeyService({
      client: await roleClient('bw-sa-signing', 'not-a-valid-secret-id'),
      audit: (e) => {
        events.push(e);
        return Promise.resolve();
      },
    });
    await expect(
      denied.signEnvelope({ tenantId: TENANT, saId: SA_ID, canonicalBytes: body }),
    ).rejects.toMatchObject({ code: 'AUTHZ_SIGNER_UNAVAILABLE' });
    expect(events).toHaveLength(countBefore);
  });

  it('the signing role cannot export the private key; the non-exportable key refuses export even to root', async () => {
    const signer = await roleClient('bw-sa-signing');
    await expect(signer.request('GET', `transit/export/signing-key/${KEY}`)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(root('GET', `transit/export/signing-key/${KEY}`)).rejects.toThrow();
  });
});
