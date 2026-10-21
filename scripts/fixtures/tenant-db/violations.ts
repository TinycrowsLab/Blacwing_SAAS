import { type Database, drizzle, type Queryable } from './drizzle-lite.js';
import { renamedWidgets } from './reexport.js';
import { gadgets, widgets } from './tables.js';

export function rawSelect(db: Database) {
  return db.select().from(widgets);
}

export function rawSelectWhere(db: Database) {
  return db.select().from(gadgets).where(1);
}

export function rawInsert(db: Database) {
  return db.insert(widgets).values({});
}

export function rawUpdate(db: Database) {
  return db.update(widgets).set({}).where(1);
}

export function rawDelete(db: Database) {
  return db.delete(gadgets).where(1);
}

export function rawJoin(db: Database) {
  return db.select().from(widgets).innerJoin(gadgets, 1);
}

export function rawJoinFromGlobal(db: Database) {
  return db.select().from(widgetsAlias()).leftJoin(widgets, 1);
}

export function viaCte(db: Database) {
  return db.with(1).select().from(widgets);
}

export function viaReexport(db: Database) {
  return db.selectDistinct().from(renamedWidgets);
}

export class Repo {
  constructor(private readonly db: Queryable) {}
  list() {
    return this.db.select().from(widgets);
  }
}

export function wrappedRawPool(db: Database) {
  return drizzle({ client: db }).select().from(widgets);
}

function widgetsAlias() {
  return gadgets;
}
