import type { SocKillContext, SocKillTokenRecord, SocKillTokenStore } from './ports.js';

const keyOf = (tenantId: string, sha256: Buffer): string => `${tenantId}|${sha256.toString('hex')}`;

/**
 * In-process {@link SocKillTokenStore} for tests and the API's local dev wiring until the Postgres
 * adapter lands (#95). `consume` has no `await`, so on one event loop it is one critical section,
 * the guarantee the DB adapter gets from a single conditional `UPDATE`. Reads are tenant-filtered.
 */
export class InMemorySocKillTokenStore implements SocKillTokenStore {
  private readonly rows = new Map<string, SocKillTokenRecord>();

  insert(record: SocKillTokenRecord): Promise<void> {
    const key = keyOf(record.tenantId, record.tokenSha256);
    if (this.rows.has(key)) return Promise.reject(new Error('duplicate token hash'));
    this.rows.set(key, record);
    return Promise.resolve();
  }

  findBySha256(tenantId: string, sha256: Buffer): Promise<SocKillTokenRecord | null> {
    return Promise.resolve(this.rows.get(keyOf(tenantId, sha256)) ?? null);
  }

  consume(tenantId: string, id: string): Promise<number | null> {
    const entry = this.entry(tenantId, id);
    if (entry === undefined) return Promise.resolve(null);
    const [key, row] = entry;
    if (row.revokedAt !== null || row.useCount >= row.maxUses) return Promise.resolve(null);
    this.rows.set(key, { ...row, useCount: row.useCount + 1 });
    return Promise.resolve(row.useCount + 1);
  }

  refund(tenantId: string, id: string): Promise<void> {
    const entry = this.entry(tenantId, id);
    if (entry !== undefined && entry[1].useCount > 0) {
      this.rows.set(entry[0], { ...entry[1], useCount: entry[1].useCount - 1 });
    }
    return Promise.resolve();
  }

  revoke(tenantId: string, id: string, at: Date): Promise<void> {
    const entry = this.entry(tenantId, id);
    if (entry !== undefined) this.rows.set(entry[0], { ...entry[1], revokedAt: at });
    return Promise.resolve();
  }

  /** Test helper: every stored row. */
  rowsForTest(): readonly SocKillTokenRecord[] {
    return [...this.rows.values()];
  }

  /** Test helper: the stored row for a link id. */
  get(tenantId: string, id: string): SocKillTokenRecord | undefined {
    return this.entry(tenantId, id)?.[1];
  }

  private entry(tenantId: string, id: string): [string, SocKillTokenRecord] | undefined {
    return [...this.rows.entries()].find(([, r]) => r.tenantId === tenantId && r.id === id);
  }
}

/** A fixed {@link SocKillContext} (tests and local dev wiring). */
export function createInMemorySocKillContext(world: {
  readonly suspendedTenants?: readonly string[];
  readonly labels: Readonly<Record<string, string>>;
  readonly windowEnds?: Readonly<Record<string, Date>>;
}): SocKillContext {
  return {
    tenantActive: (tenantId) => Promise.resolve(!(world.suspendedTenants ?? []).includes(tenantId)),
    scopeLabel: (_tenantId, _scope, ref) => Promise.resolve(world.labels[ref] ?? null),
    openWindowEnd: (_tenantId, assetId) => Promise.resolve(world.windowEnds?.[assetId] ?? null),
  };
}
