import {
  type Database,
  drizzle,
  type SystemTx,
  type TenantTx,
  withSystem,
  withTenant,
} from './drizzle-lite.js';
import { gadgets, users, widgets } from './tables.js';

export function insideWithTenant(db: Database) {
  return withTenant(db, 'id', (tx) => tx.select().from(widgets).where(1));
}

export function insideWithTenantWrites(db: Database) {
  return withTenant(db, 'id', (tx) => [
    tx.insert(widgets).values({}),
    tx.update(gadgets).set({}),
    tx.delete(gadgets).where(1),
    tx.select().from(widgets).innerJoin(gadgets, 1),
  ]);
}

export function typedTenantHandle(tx: TenantTx) {
  return tx.select().from(widgets);
}

export function nonTenantTable(db: Database) {
  return [db.select().from(users), db.insert(users).values({}), db.delete(users)];
}

export function systemHandle(tx: SystemTx) {
  return tx.select().from(widgets);
}

export function insideWithSystem(db: Database) {
  return withSystem(db, (tx) => tx.select().from(widgets));
}

export function annotated(db: Database) {
  // blackwing:allow-raw-tenant-db owner-role backfill, audited by the migration runner
  return db.select().from(widgets);
}

export function notAQuery() {
  return Array.from(widgets as unknown as Iterable<unknown>);
}

export function wrappedTenantTx(tx: TenantTx) {
  return drizzle({ client: tx }).select().from(widgets);
}
