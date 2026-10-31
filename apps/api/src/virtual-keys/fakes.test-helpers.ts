import type { NewVirtualKey, StoredVirtualKey, TenantTx, VirtualKeyStore } from '@blackwing/db';

/** In-memory `VirtualKeyStore`: the same contract as the Postgres store, without a database. */
export function createFakeVirtualKeyStore(): VirtualKeyStore & {
  readonly rows: Map<string, StoredVirtualKey & { keySha256: Buffer }>;
} {
  const rows = new Map<string, StoredVirtualKey & { keySha256: Buffer }>();
  const tx = {} as unknown as TenantTx;
  const toStored = (row: NewVirtualKey): StoredVirtualKey & { keySha256: Buffer } => ({
    id: row.id,
    tenantId: row.tenantId,
    runId: row.runId,
    sessionId: row.sessionId,
    keyPrefix: row.keyPrefix,
    persona: row.persona,
    scope: row.scope,
    budgetContext: row.budgetContext,
    expiresAt: row.expiresAt,
    revokedAt: null,
    lastUsedAt: null,
    keySha256: row.keySha256,
  });
  const revokeWhere = async (
    predicate: (row: StoredVirtualKey) => boolean,
    afterWrite: (t: TenantTx, ids: readonly string[]) => Promise<void>,
  ): Promise<string[]> => {
    const ids: string[] = [];
    for (const row of rows.values()) {
      if (row.revokedAt === null && predicate(row)) {
        rows.set(row.id, { ...row, revokedAt: new Date() });
        ids.push(row.id);
      }
    }
    await afterWrite(tx, ids);
    return ids;
  };
  return {
    rows,
    async mint(row, afterWrite) {
      const stored = toStored(row);
      await afterWrite(tx);
      rows.set(row.id, stored);
      return stored;
    },
    resolve(keySha256) {
      const found = [...rows.values()].find((row) => row.keySha256.equals(keySha256));
      return Promise.resolve(found ?? null);
    },
    markUsed() {
      return Promise.resolve();
    },
    revokeIds(tenantId, ids, afterWrite) {
      return revokeWhere((row) => row.tenantId === tenantId && ids.includes(row.id), afterWrite);
    },
    revokeRun(tenantId, runId, afterWrite) {
      return revokeWhere((row) => row.tenantId === tenantId && row.runId === runId, afterWrite);
    },
  };
}
