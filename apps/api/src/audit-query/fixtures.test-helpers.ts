import { Registry } from 'prom-client';

import { createMemoryAuditQueryStore, type MemoryAuditQueryStore } from './memory.js';
import { AuditQueryService } from './service.js';
import { createCursorCodec } from '../pagination/cursor.js';

import type { AuditEventRecord, AuditQueryPrincipal } from './ports.js';

export const TENANT_A = '018f0000-0000-7000-8000-00000000000a';
export const TENANT_B = '018f0000-0000-7000-8000-00000000000b';
export const RUN_1 = '01890a5d-ac96-774b-bcce-b302099a8058';
export const RUN_2 = '01890a5d-ac96-774b-bcce-b302099a8059';
const SECRET_LENGTH = 48;
const SECRET = 'x'.repeat(SECRET_LENGTH);
export const BASE_AT = '2026-10-20T10:00:00.000Z';
const HEX_RADIX = 16;
const ID_TAIL_WIDTH = 12;
const HASH_BYTES = 32;
const BYTE_MODULUS = 256;

/** A ledger row with defaults; `seq` also derives a valid UUIDv7-shaped id and the chain hashes. */
export function ledgerRow(
  seq: number,
  overrides: Partial<Omit<AuditEventRecord, 'seq' | 'id' | 'hash' | 'prevHash'>> = {},
): AuditEventRecord {
  return {
    id: `018f0000-0000-7000-8000-${seq.toString(HEX_RADIX).padStart(ID_TAIL_WIDTH, '0')}`,
    seq,
    occurredAt: new Date(BASE_AT),
    action: 'kill.fired',
    severity: 'critical',
    actor: { type: 'user', id: 'usr_alice', email: 'alice@example.test' },
    target: { type: 'run', id: RUN_1 },
    outcome: 'success',
    reason: null,
    metadata: { scope: 'run' },
    metadataRef: null,
    traceId: null,
    runId: null,
    hash: new Uint8Array(HASH_BYTES).fill(seq % BYTE_MODULUS),
    prevHash: seq === 1 ? null : new Uint8Array(HASH_BYTES).fill((seq - 1) % BYTE_MODULUS),
    ...overrides,
  };
}

export function principal(
  roles: readonly string[],
  overrides: Partial<AuditQueryPrincipal> = {},
): AuditQueryPrincipal {
  return { type: 'user', id: 'usr_caller', tenantId: TENANT_A, roles, ...overrides };
}

export const AUDITOR = principal(['auditor']);
export const ORG_ADMIN = principal(['org_admin']);

export interface AuditQueryHarness {
  readonly store: MemoryAuditQueryStore;
  readonly service: AuditQueryService;
  readonly observed: { role: string; latencySeconds: number }[];
}

/** A service over the in-memory store, with one shared cursor secret. */
export function harness(): AuditQueryHarness {
  const store = createMemoryAuditQueryStore();
  const observed: { role: string; latencySeconds: number }[] = [];
  const service = new AuditQueryService({
    store,
    codec: createCursorCodec(SECRET),
    metrics: { registry: new Registry(), record: (o) => observed.push(o) },
  });
  return { store, service, observed };
}
