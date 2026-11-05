import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { demoLoginEmail, demoLoginSql, syncDemoLogin } from './keycloak-demo-login.mjs';

const SUB = '0190f4b2-1111-7222-8333-444455556666';
const json = (/** @type {number} */ status, /** @type {unknown} */ body) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status });

/** A fake Keycloak admin API holding at most one user. Records method + path of every call. */
function fakeKeycloak(/** @type {{ exists?: boolean }} */ seed = {}) {
  let user = seed.exists === true ? { id: SUB } : undefined;
  /** @type {string[]} */
  const calls = [];
  /** @type {unknown[]} */
  const bodies = [];
  const fetchFn = (/** @type {string} */ url, /** @type {RequestInit} */ init = {}) => {
    const p = new URL(url).pathname + new URL(url).search;
    calls.push(`${init.method ?? 'GET'} ${p}`);
    if (typeof init.body === 'string') bodies.push(JSON.parse(init.body));
    if (p.endsWith('/openid-connect/token'))
      return Promise.resolve(json(200, { access_token: 't' }));
    if (p.includes('/users?exact=true'))
      return Promise.resolve(json(200, user === undefined ? [] : [user]));
    if (init.method === 'POST' && p.endsWith('/users')) {
      user = { id: SUB };
      return Promise.resolve(json(201));
    }
    if (p.includes('/group-by-path/'))
      return Promise.resolve(json(200, { id: p.endsWith('owners') ? 'g-own' : p.endsWith('engineers') ? 'g-sec' : `g-${p.split('/').pop()}` }));
    return Promise.resolve(json(204));
  };
  return { fetchFn: /** @type {typeof fetch} */ (/** @type {unknown} */ (fetchFn)), calls, bodies };
}

const input = (/** @type {typeof fetch} */ fetchFn) => ({
  base: 'http://kc',
  adminUser: 'a',
  adminPassword: 'b',
  email: 'demo@tinycrows.com',
  password: 'pw-value',
  fetchFn,
});

describe('demoLoginEmail', () => {
  it('is empty unless both email and password are set', () => {
    assert.equal(demoLoginEmail({}), '');
    assert.equal(demoLoginEmail({ BW_DEMO_LOGIN_EMAIL: 'demo@tinycrows.com' }), '');
    assert.equal(
      demoLoginEmail({ BW_DEMO_LOGIN_EMAIL: ' Demo@Tinycrows.com ', BW_DEMO_LOGIN_PASSWORD: 'x' }),
      'demo@tinycrows.com',
    );
  });
  it('refuses an email that could break out of SQL or a URL', () => {
    assert.throws(() =>
      demoLoginEmail({ BW_DEMO_LOGIN_EMAIL: "x'@a.b", BW_DEMO_LOGIN_PASSWORD: 'x' }),
    );
  });
});

describe('syncDemoLogin', () => {
  it('creates the user, sets the password and joins every role group', async () => {
    const kc = fakeKeycloak();
    const r = await syncDemoLogin(input(kc.fetchFn));
    assert.deepEqual(r, { sub: SUB, created: true });
    assert.ok(kc.calls.includes('POST /admin/realms/blackwing-dev/users'));
    assert.ok(kc.calls.includes(`PUT /admin/realms/blackwing-dev/users/${SUB}/reset-password`));
    assert.ok(kc.calls.includes(`PUT /admin/realms/blackwing-dev/users/${SUB}/groups/g-sec`));
    assert.ok(kc.calls.includes(`PUT /admin/realms/blackwing-dev/users/${SUB}/groups/g-own`));
    for (const name of ['developers', 'org-admins', 'auditors'])
      assert.ok(kc.calls.includes(`GET /admin/realms/blackwing-dev/group-by-path/acme/${name}`));
    assert.equal(kc.calls.filter((c) => c.includes('/groups/g-')).length, 5);
    assert.ok(kc.bodies.some((b) => JSON.stringify(b).includes('"tenant":["acme"]')));
  });
  it('updates an existing user instead of creating a second one', async () => {
    const kc = fakeKeycloak({ exists: true });
    const r = await syncDemoLogin(input(kc.fetchFn));
    assert.equal(r.created, false);
    assert.ok(!kc.calls.includes('POST /admin/realms/blackwing-dev/users'));
    assert.ok(kc.calls.includes(`PUT /admin/realms/blackwing-dev/users/${SUB}`));
  });
  it('reports failures by status only, never the password', async () => {
    const fetchFn = /** @type {typeof fetch} */ (() => Promise.resolve(json(401)));
    await assert.rejects(syncDemoLogin(input(fetchFn)), (e) => {
      assert.ok(e instanceof Error);
      assert.match(e.message, /HTTP 401/);
      assert.ok(!e.message.includes('pw-value'));
      return true;
    });
  });
});

describe('demoLoginSql', () => {
  it('upserts the user and the acme membership with every role', () => {
    const sql = demoLoginSql(SUB, 'demo@tinycrows.com');
    assert.match(sql, /ON CONFLICT \(keycloak_sub\)/);
    assert.match(sql, /ARRAY\['appsec_engineer','asset_owner','developer','org_admin','auditor'\]/);
    assert.match(sql, /t\.slug = 'acme'/);
    assert.ok(sql.indexOf('UPDATE users SET keycloak_sub') < sql.indexOf('INSERT INTO users'));
  });
  it('refuses inputs that are not a uuid, a plain email or a plain name', () => {
    assert.throws(() => demoLoginSql("x'; drop table users; --", 'demo@tinycrows.com'));
    assert.throws(() => demoLoginSql(SUB, "a'@b.c"));
    assert.throws(() => demoLoginSql(SUB, 'demo@tinycrows.com', "Bob'); --"));
  });
});
