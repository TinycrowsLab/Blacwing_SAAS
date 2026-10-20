import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { RLS_SQL_FILES } from '@blackwing/testing/containers';

const roles = readFileSync(fileURLToPath(new URL('./roles.sql', import.meta.url)), 'utf8');

describe('roles.sql', () => {
  it('is the role bootstrap the Testcontainers helper applies, verbatim (no drift)', () => {
    const cluster = readFileSync(RLS_SQL_FILES.roles, 'utf8');
    const database = readFileSync(RLS_SQL_FILES.database, 'utf8');
    expect(roles).toContain(cluster);
    expect(roles).toContain(database);
    expect(roles.indexOf(cluster)).toBeLessThan(roles.indexOf(database));
  });

  it('never grants the app role SUPERUSER, BYPASSRLS or the owner role', () => {
    const statements = roles.replace(/--.*$/gm, '');
    expect(statements).toMatch(/ALTER ROLE bw_app NOSUPERUSER[^;]*NOBYPASSRLS/);
    expect(statements).not.toMatch(/\bBYPASSRLS\b(?<!NOBYPASSRLS)/);
    expect(statements).not.toMatch(/ROLE bw_app[^;]*\bSUPERUSER\b(?<!NOSUPERUSER)/);
    expect(statements).not.toMatch(/GRANT\s+bw_owner\s+TO\s+bw_app/i);
    expect(statements).toMatch(/REVOKE ALL ON SCHEMA public FROM PUBLIC/);
    expect(statements).toMatch(/REVOKE ALL ON DATABASE %I FROM PUBLIC/);
    expect(statements).toMatch(/GRANT CONNECT ON DATABASE %I TO bw_app/);
    expect(statements).toMatch(/GRANT USAGE ON SCHEMA public TO bw_app/);
  });

  it('stores no credential', () => {
    expect(roles).not.toMatch(/PASSWORD\s+'/i);
  });
});
