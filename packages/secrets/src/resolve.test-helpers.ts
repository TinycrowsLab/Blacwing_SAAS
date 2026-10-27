import {
  createAuditEmitter,
  type AuditEventInput,
  type AuditOutboxMessage,
} from '@blackwing/audit';

import { createEnvelopeCrypto, type Envelope, EnvelopeError } from './envelope.js';
import {
  createSecretResolver,
  SECRET_PURPOSES,
  type RunStanding,
  type SecretRecord,
  type SecretResolverDeps,
  type SecretStore,
} from './resolve.js';

import type { TransitClient } from './transit.js';

export const TENANT_A = '01900000-0000-7000-8000-000000000001';
export const TENANT_B = '01900000-0000-7000-8000-000000000002';
export const RUN_ID = '01900000-0000-7000-8000-0000000000b1';
export const SECRET_ID = '01900000-0000-7000-8000-0000000000c1';
export const PLAINTEXT = 'Zx9!qLm2#Rt7vWp4-login-password';
export const KEY = 'service-token-key-0123456789abcdef-xyz';

/** In-memory Transit: wraps a DEK per key; `down` makes every call fail like a sealed OpenBao. */
class FakeTransit implements TransitClient {
  down = false;
  calls = 0;
  private guard(): void {
    this.calls += 1;
    if (this.down) throw new EnvelopeError('KEK_UNAVAILABLE', 'sealed');
  }
  encrypt(key: string, plaintextB64: string): Promise<string> {
    this.guard();
    return Promise.resolve(`vault:v1:${Buffer.from(`${key}|${plaintextB64}`).toString('base64')}`);
  }
  decrypt(key: string, ciphertext: string): Promise<string> {
    this.guard();
    const body = /^vault:v1:(.+)$/.exec(ciphertext)?.[1] ?? '';
    const [k, b64] = Buffer.from(body, 'base64').toString().split('|');
    if (k !== key) throw new EnvelopeError('KEK_UNAVAILABLE', 'wrong key');
    return Promise.resolve(b64 ?? '');
  }
  rewrap(_key: string, ciphertext: string): Promise<string> {
    return Promise.resolve(ciphertext);
  }
}

/** Store keyed by `(tenant, secretId)`; another tenant's secret is absent, like RLS. */
class MemoryStore implements SecretStore {
  readonly records = new Map<string, SecretRecord>();
  readonly loads: (number | undefined)[] = [];
  put(record: SecretRecord): void {
    this.records.set(`${record.tenantId}/${record.id}/${String(record.version)}`, record);
  }
  load(tenantId: string, secretId: string, version?: number): Promise<SecretRecord | null> {
    this.loads.push(version);
    const found = [...this.records.values()].find(
      (r) =>
        r.tenantId === tenantId &&
        r.id === secretId &&
        (version === undefined || r.version === version),
    );
    return Promise.resolve(found ?? null);
  }
}

class MemoryRuns {
  standing: RunStanding = 'active';
  readonly asked: string[] = [];
  standingOf(tenantId: string, runId: string): Promise<RunStanding> {
    this.asked.push(`${tenantId}/${runId}`);
    return Promise.resolve(this.standing);
  }
}

export async function envelopeFor(
  transit: TransitClient,
  tenantId: string,
  purpose: string,
  plaintext = PLAINTEXT,
): Promise<Envelope> {
  return createEnvelopeCrypto({ transit }).encryptSecret({
    tenantId,
    plaintext,
    context: { secretId: SECRET_ID, purpose },
  });
}

/** A resolver wired like production, over fakes; audit goes through the REAL emitter into an outbox. */
export async function setup(overrides: Partial<SecretResolverDeps> = {}) {
  const transit = new FakeTransit();
  const store = new MemoryStore();
  const runs = new MemoryRuns();
  const outbox: AuditOutboxMessage[] = [];
  const emitter = createAuditEmitter({
    outbox: {
      enqueue: (message) => {
        outbox.push(message);
        return Promise.resolve();
      },
    },
  });
  const audited: AuditEventInput[] = [];
  const deps: SecretResolverDeps = {
    store,
    crypto: createEnvelopeCrypto({ transit }),
    audit: (event) => {
      audited.push(event);
      return emitter.emitAudit(event);
    },
    runs: { standing: (t, r) => runs.standingOf(t, r) },
    ...overrides,
  };
  store.put({
    id: SECRET_ID,
    tenantId: TENANT_A,
    type: 'password',
    purpose: SECRET_PURPOSES.assetLogin,
    backend: 'openbao',
    status: 'active',
    version: 1,
    envelope: await envelopeFor(transit, TENANT_A, SECRET_PURPOSES.assetLogin),
    externalLocator: null,
  });
  return { resolver: createSecretResolver(deps), transit, store, runs, outbox, audited, deps };
}

export const REF = `bw-secret://${TENANT_A}/${SECRET_ID}`;
