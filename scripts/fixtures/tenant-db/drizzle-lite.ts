// A minimal stand-in for the drizzle query builder and @blackwing/db handles, so the rule's type
// checks run without the real packages. The brand property names match with-tenant.ts.

declare const tenantTxBrand: unique symbol;
declare const systemTxBrand: unique symbol;

export interface Table {
  readonly name: string;
}

export interface Builder {
  from(table: Table): Builder;
  innerJoin(table: Table, on: unknown): Builder;
  leftJoin(table: Table, on: unknown): Builder;
  where(condition: unknown): Builder;
}

export interface Writer {
  values(rows: unknown): Writer;
  set(changes: unknown): Writer;
  where(condition: unknown): Writer;
}

export interface Queryable {
  select(): Builder;
  selectDistinct(): Builder;
  with(cte: unknown): { select(): Builder };
  insert(table: Table): Writer;
  update(table: Table): Writer;
  delete(table: Table): Writer;
}

/** The raw database / pool handle. */
export type Database = Queryable & { readonly kind: 'database' };
/** What withTenant passes to its callback. */
export type TenantTx = Queryable & { readonly [tenantTxBrand]: true };
/** What withSystem passes to its callback. */
export type SystemTx = Queryable & { readonly [systemTxBrand]: true };

export declare function tenantIdColumn(): unknown;
export declare function column(name: string): unknown;
export declare function pgTable(name: string, columns: Record<string, unknown>): Table;
export declare function withTenant<T>(
  db: Database,
  tenantId: string,
  fn: (tx: TenantTx) => T,
): Promise<T>;
export declare function withSystem<T>(db: Database, fn: (tx: SystemTx) => T): Promise<T>;

/** drizzle({ client }): wraps a pool or transaction client in the query builder. */
export declare function drizzle(config: { client: object }): Queryable;
