// The Blackwing ESLint plugin: repository-specific rules, registered as `blackwing/*` in
// eslint.config.mjs.

import { noRawTenantDb } from './no-raw-tenant-db.mjs';

export const blackwingPlugin = {
  meta: { name: 'blackwing' },
  rules: { 'no-raw-tenant-db': noRawTenantDb },
};
