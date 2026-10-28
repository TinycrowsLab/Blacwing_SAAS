// Secret value rotation and the tenant KEK rewrap against a real OpenBao dev server (SECRETS-012): every
// envelope moves to the newest KEK version, still decrypts after the minimum decrypt version is raised,
// and the data ciphertext is never touched. Needs Docker (Testcontainers); run with
// `pnpm --filter @blackwing/secrets test:int`.

import { readFileSync } from 'node:fs';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type OpenBaoHandle, withOpenBao } from '@blackwing/testing/containers';

import { createEnvelopeCrypto, type Envelope } from './envelope.js';
import { createTenantKekService, type TenantKekService } from './kek.js';
import { createOpenBaoClient, type OpenBaoClient } from './openbao.js';
import {
  createSecretRotation,
  type RewrapCandidate,
  type RewrapCursor,
  type RotationRecord,
  type RotationStore,
  type SecretRotationService,
} from './rotation.js';
import { createTransit } from './transit.js';

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

async function roleClient(role: string): Promise<OpenBaoClient> {
  await root('PUT', `sys/policies/acl/${role}`, { policy: policy(role) });
  await root('POST', `auth/approle/role/${role}`, { token_policies: [role] });
  const roleId = (
    (await root('GET', `auth/approle/role/${role}/role-id`)) as { data: { role_id: string } }
  ).data.role_id;
  const secretId = (
    (await root('POST', `auth/approle/role/${role}/secret-id`, {})) as {
      data: { secret_id: string };
    }
  ).data.secret_id;
  return createOpenBaoClient({ addr: handle().addr, roleId, secretId });
}

const TENANT = '2f7c9a1e-4b3d-4e8f-8a6b-1c2d3e4f5a6b';
const KEK_KEY = `tenant-${TENANT}`;

interface Stored {
  readonly id: string;
  version: number;
  envelope: Envelope;
  /** Superseded versions, still held in `secret_versions` until their grace period ends. */
  readonly history: Map<number, Envelope>;
}

/** In-memory {@link RotationStore} with the Postgres store's semantics: keyset batches and guarded writes. */
function memoryStore(secrets: Map<string, Stored>): RotationStore {
  const candidatesBelow = (before: number): RewrapCandidate[] =>
    [...secrets.values()]
      .flatMap((s): RewrapCandidate[] => [
        { source: 'current', secretId: s.id, version: s.version, envelope: s.envelope },
        ...[...s.history].map(([version, envelope]): RewrapCandidate => ({
          source: 'version',
          secretId: s.id,
          version,
          envelope,
        })),
      ])
      .filter((c) => c.envelope.kekKey === KEK_KEY && c.envelope.kekVersion < before)
      .sort(
        (a, b) =>
          a.secretId.localeCompare(b.secretId) ||
          a.version - b.version ||
          a.source.localeCompare(b.source),
      );

  return {
    loadForRotation: (tenantId, secretId): Promise<RotationRecord | null> => {
      const s = secrets.get(secretId);
      return Promise.resolve(
        s === undefined
          ? null
          : {
              id: s.id,
              tenantId,
              purpose: 'db-password',
              backend: 'openbao',
              status: 'active',
              currentVersion: s.version,
              envelope: s.envelope,
              externalLocator: null,
            },
      );
    },
    commitRotation: (_tenantId, commit) => {
      const s = secrets.get(commit.secretId);
      if (s?.version !== commit.expectedVersion) return Promise.resolve(false);
      if (commit.previous.envelope !== null)
        s.history.set(commit.previous.version, commit.previous.envelope);
      s.version = commit.next.version;
      s.envelope = commit.next.envelope;
      return Promise.resolve(true);
    },
    nextRewrapBatch: (_tenantId, _kekKey, beforeVersion, after: RewrapCursor | undefined, limit) =>
      Promise.resolve(
        candidatesBelow(beforeVersion)
          .filter(
            (c) =>
              after === undefined ||
              c.secretId > after.secretId ||
              (c.secretId === after.secretId &&
                (c.version > after.version ||
                  (c.version === after.version && c.source > after.source))),
          )
          .slice(0, limit),
      ),
    saveRewrap: (_tenantId, candidate, envelope) => {
      const s = secrets.get(candidate.secretId);
      if (s === undefined) return Promise.resolve(false);
      if (candidate.source === 'current' && s.version === candidate.version) {
        s.envelope = envelope;
        return Promise.resolve(true);
      }
      if (candidate.source === 'version' && s.history.has(candidate.version)) {
        s.history.set(candidate.version, envelope);
        return Promise.resolve(true);
      }
      return Promise.resolve(false);
    },
  };
}

let provisioner: OpenBaoClient;
let kek: TenantKekService;
let rotation: SecretRotationService;
let crypto: ReturnType<typeof createEnvelopeCrypto>;
const secrets = new Map<string, Stored>();

beforeAll(async () => {
  bao = await withOpenBao();
  await root('POST', 'sys/auth/approle', { type: 'approle' });
  await root('POST', 'sys/mounts/transit', { type: 'transit' });
  const app = await roleClient('bw-kek-app');
  provisioner = await roleClient('bw-kek-provisioner');
  kek = createTenantKekService({ client: provisioner, audit: () => Promise.resolve() });
  crypto = createEnvelopeCrypto({ transit: createTransit(app) });
  rotation = createSecretRotation({
    store: memoryStore(secrets),
    crypto,
    kek,
    audit: () => Promise.resolve(),
    graceMs: 3_600_000,
  });
  await kek.ensureTenantKek(TENANT);
});
afterAll(async () => {
  await bao?.stop();
});

const context = (secretId: string) => ({ secretId, purpose: 'db-password' });

describe('secret rotation against OpenBao', () => {
  it('re-wraps every envelope to the newest KEK version and everything still decrypts', async () => {
    const first = await crypto.encryptSecret({
      tenantId: TENANT,
      plaintext: 'alpha-1',
      context: context('sec-a'),
    });
    secrets.set('sec-a', { id: 'sec-a', version: 1, envelope: first, history: new Map() });
    await rotation.rotateSecret({ tenantId: TENANT, secretId: 'sec-a', plaintext: 'alpha-2' });

    const before = secrets.get('sec-a');
    const dataCiphertextBefore = before?.history.get(1)?.ct;
    const result = await rotation.rotateTenantKek(TENANT);
    expect(result).toMatchObject({ latestVersion: 2, minDecryptionVersion: 2 });
    expect(result.rewrapped).toBe(2);

    const after = secrets.get('sec-a');
    const pinnedEnvelope = after?.history.get(1);
    if (after === undefined || pinnedEnvelope === undefined)
      throw new Error('sec-a was not stored');
    expect(after.envelope.kekVersion).toBe(2);
    expect(pinnedEnvelope.kekVersion).toBe(2);
    // Data ciphertext is untouched by a rewrap; only the wrapped DEK moves.
    expect(pinnedEnvelope.ct).toBe(dataCiphertextBefore);

    const current = await crypto.decryptSecret(after.envelope, {
      tenantId: TENANT,
      context: context('sec-a'),
    });
    const pinned = await crypto.decryptSecret(pinnedEnvelope, {
      tenantId: TENANT,
      context: context('sec-a'),
    });
    expect(current.toString('utf8')).toBe('alpha-2');
    expect(pinned.toString('utf8')).toBe('alpha-1');
  });

  it('refuses to decrypt a pre-rewrap envelope once the minimum decrypt version is raised', async () => {
    const stale = await crypto.encryptSecret({
      tenantId: TENANT,
      plaintext: 'stale',
      context: context('sec-stale'),
    });
    // Rotate the KEK without rewrapping: the envelope is now below the floor that the next pass sets.
    await provisioner.request('POST', `transit/keys/${KEK_KEY}/rotate`);
    await provisioner.request('POST', `transit/keys/${KEK_KEY}/config`, {
      min_decryption_version: 3,
    });
    await expect(
      crypto.decryptSecret(stale, { tenantId: TENANT, context: context('sec-stale') }),
    ).rejects.toThrow();
  });
});
