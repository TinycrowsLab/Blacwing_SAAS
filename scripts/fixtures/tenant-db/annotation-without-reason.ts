import { type Database } from './drizzle-lite.js';
import { widgets } from './tables.js';

export function bare(db: Database) {
  // blackwing:allow-raw-tenant-db
  return db.select().from(widgets);
}
