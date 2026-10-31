// Mint, revoke and validate per-session virtual model keys (GATEWAY-002, #405, CONTEXT_PACK §4.1, §8.6, §8.7,
// §8.8). The raw `bwk_` key is returned once, by `mint`, and is never stored or logged: only its SHA-256 and a
// non-secret prefix reach the database. A mint and its audit event commit together; so do a revoke and its event.

import {
  DEFAULT_VIRTUAL_KEY_TTL_SECONDS,
  virtualKeyMintRequestSchema,
  virtualKeyRevokeRequestSchema,
  type VirtualKeyContext,
  type VirtualKeyMintResponse,
  type VirtualKeyRevokeResponse,
} from '@blackwing/contracts';
import { generateVirtualKey, hashVirtualKey, virtualKeyLookupPrefix } from '@blackwing/crypto';
import {
  createVirtualKeyAuthenticator,
  type SystemAuditEmitter,
  type TenantTx,
  type VirtualKeyStore,
} from '@blackwing/db';
import { ValidationError } from '@blackwing/errors';
import { newId } from '@blackwing/ids';

import type { VirtualKeyMetrics } from './metrics.js';
import type { AuditEventInput } from '@blackwing/audit';

const MS_PER_SECOND = 1000;
const MODEL_GATEWAY_ACTOR = 'model-gateway';

/** Writes one audit event inside the transaction `tx` (§8.8). A rejection rolls the write back. */
export type VirtualKeyAuditWriter = (tx: TenantTx, event: AuditEventInput) => Promise<void>;

export interface VirtualKeyServiceOptions {
  readonly store: VirtualKeyStore;
  readonly audit: VirtualKeyAuditWriter;
  /** Audit of the tenant-less resolve path (`db.system_access`). */
  readonly systemAudit: SystemAuditEmitter;
  readonly metrics: VirtualKeyMetrics;
  readonly defaultTtlSeconds?: number;
  readonly now?: () => Date;
  /** Key source; defaults to 256 bits of CSPRNG output. Injected only by tests. */
  readonly generate?: () => string;
  /** Row id source (UUIDv7); injected only by tests. */
  readonly newRowId?: () => string;
}

/** The authenticated caller of an internal endpoint, recorded as the audit actor. */
interface VirtualKeyCaller {
  readonly identity: string;
}

export interface VirtualKeyService {
  mint(body: unknown, caller: VirtualKeyCaller): Promise<VirtualKeyMintResponse>;
  revoke(body: unknown, caller: VirtualKeyCaller): Promise<VirtualKeyRevokeResponse>;
  /** Resolves a presented key to its request context, or `undefined` for every failure (one uniform refusal). */
  authenticate(key: string): Promise<VirtualKeyContext | undefined>;
}

function invalid(what: string): ValidationError {
  return new ValidationError(`${what} is invalid`);
}

export function createVirtualKeyService(options: VirtualKeyServiceOptions): VirtualKeyService {
  const now = options.now ?? (() => new Date());
  const generate = options.generate ?? generateVirtualKey;
  const newRowId = options.newRowId ?? newId;
  const defaultTtl = options.defaultTtlSeconds ?? DEFAULT_VIRTUAL_KEY_TTL_SECONDS;
  const { store, metrics } = options;
  const authenticator = createVirtualKeyAuthenticator({
    store,
    audit: options.systemAudit,
    actor: MODEL_GATEWAY_ACTOR,
    now,
  });

  return {
    async mint(body, caller) {
      const parsed = virtualKeyMintRequestSchema.safeParse(body);
      if (!parsed.success) {
        metrics.mints.inc({ outcome: 'rejected' });
        throw invalid('virtual key mint request');
      }
      const input = parsed.data;
      const ttlSeconds = input.ttlSeconds ?? defaultTtl;
      const expiresAt = new Date(now().getTime() + ttlSeconds * MS_PER_SECOND);
      const key = generate();
      const virtualKeyId = newRowId();
      const scope = {
        tenantId: input.tenantId,
        runId: input.runId,
        sessionId: input.sessionId,
        persona: input.persona,
      };
      await store.mint(
        {
          id: virtualKeyId,
          tenantId: input.tenantId,
          runId: input.runId,
          sessionId: input.sessionId,
          keyPrefix: virtualKeyLookupPrefix(key),
          keySha256: hashVirtualKey(key),
          persona: input.persona,
          scope,
          budgetContext: input.budgetContext,
          expiresAt,
        },
        (tx) =>
          options.audit(tx, {
            tenantId: input.tenantId,
            action: 'vkey.minted',
            actor: { type: 'service', id: caller.identity },
            target: { type: 'virtual_key', id: virtualKeyId },
            outcome: 'success',
            runId: input.runId,
            metadata: {
              keyPrefix: virtualKeyLookupPrefix(key),
              sessionId: input.sessionId,
              persona: input.persona,
              expiresAt: expiresAt.toISOString(),
            },
          }),
      );
      metrics.mints.inc({ outcome: 'minted' });
      metrics.active.inc();
      return { key, virtualKeyId, expiresAt: expiresAt.toISOString() };
    },

    async revoke(body, caller) {
      const parsed = virtualKeyRevokeRequestSchema.safeParse(body);
      if (!parsed.success) throw invalid('virtual key revoke request');
      const input = parsed.data;
      const byRun = 'runId' in input;
      const trigger = byRun ? 'run' : 'ids';
      const write = async (tx: TenantTx, revokedIds: readonly string[]): Promise<void> => {
        if (revokedIds.length === 0) return;
        await options.audit(tx, {
          tenantId: input.tenantId,
          action: 'vkey.revoked',
          actor: { type: 'service', id: caller.identity },
          target: {
            type: 'virtual_key',
            id: byRun ? input.runId : (revokedIds[0] ?? input.tenantId),
          },
          outcome: 'success',
          ...(byRun ? { runId: input.runId } : {}),
          metadata: { trigger, count: revokedIds.length, virtualKeyIds: [...revokedIds] },
        });
      };
      const revokedVirtualKeyIds =
        'virtualKeyIds' in input
          ? await store.revokeIds(input.tenantId, input.virtualKeyIds, write)
          : await store.revokeRun(input.tenantId, input.runId, write);
      metrics.revokes.inc({ trigger }, revokedVirtualKeyIds.length);
      metrics.active.dec(revokedVirtualKeyIds.length);
      return { revokedVirtualKeyIds };
    },

    authenticate: authenticator,
  };
}
