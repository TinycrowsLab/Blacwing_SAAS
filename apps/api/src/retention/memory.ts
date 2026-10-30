import type {
  RetentionAuditRecord,
  RetentionPolicyWrite,
  RetentionStore,
  RetentionTx,
  StoredRetentionPolicy,
} from './ports.js';

/**
 * In-process `RetentionStore` for unit tests and local wiring. Transactions for one tenant run one at a
 * time (a per-tenant promise chain stands in for the row lock of the Postgres adapter), so a concurrent
 * `PUT` sees the write that won. Audit records are kept in order for assertions.
 */
export class InMemoryRetentionStore implements RetentionStore {
  readonly audit: RetentionAuditRecord[] = [];
  private readonly rows = new Map<string, StoredRetentionPolicy>();
  private readonly tails = new Map<string, Promise<unknown>>();
  private now: () => string;

  constructor(options: { readonly now?: () => string } = {}) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  read(tenantId: string): Promise<readonly StoredRetentionPolicy[]> {
    return Promise.resolve(this.rowsOf(tenantId));
  }

  transact<T>(tenantId: string, fn: (tx: RetentionTx) => Promise<T>): Promise<T> {
    const previous = this.tails.get(tenantId) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(() => this.runOnce(tenantId, fn));
    this.tails.set(
      tenantId,
      run.catch(() => undefined),
    );
    return run;
  }

  private async runOnce<T>(tenantId: string, fn: (tx: RetentionTx) => Promise<T>): Promise<T> {
    // Work on a copy so a throw leaves the stored rows and the audit trail untouched.
    const staged = new Map(this.rows);
    const stagedAudit: RetentionAuditRecord[] = [];
    const tx: RetentionTx = {
      lockAndLoad: () => Promise.resolve(this.rowsOf(tenantId, staged)),
      upsert: (writes) => {
        for (const write of writes) this.stage(staged, write);
        return Promise.resolve();
      },
      appendAudit: (record) => {
        stagedAudit.push(record);
        return Promise.resolve();
      },
    };
    const result = await fn(tx);
    for (const [key, value] of staged) this.rows.set(key, value);
    this.audit.push(...stagedAudit);
    return result;
  }

  private stage(into: Map<string, StoredRetentionPolicy>, write: RetentionPolicyWrite): void {
    into.set(`${write.tenantId}|${write.dataClass}`, {
      ...write,
      legalHoldOverrides: false,
      updatedAt: this.now(),
    });
  }

  private rowsOf(
    tenantId: string,
    source: ReadonlyMap<string, StoredRetentionPolicy> = this.rows,
  ): StoredRetentionPolicy[] {
    return [...source.values()].filter((row) => row.tenantId === tenantId);
  }
}
