import assert from 'node:assert/strict';
import { test } from 'node:test';

import { loadRealm, resolvePlaceholders, sync, validateRealm } from './keycloak-sync.mjs';

const ENV = {
  BW_ENVIRONMENT: 'prod',
  BW_KEYCLOAK_PUBLIC_URL: 'https://id.example.test',
  BW_CONSOLE_ORIGIN: 'https://app.example.test',
  BW_KEYCLOAK_API_SECRET: 'a',
  BW_KEYCLOAK_CLI_SECRET: 'b',
};

/**
 * @param {ReturnType<typeof loadRealm>} realm
 * @param {number} i
 */
function clientAt(realm, i) {
  const c = realm.clients?.[i];
  assert.ok(c, `realm has client #${i}`);
  return c;
}

test('committed realm is valid and has no literal secrets', () => {
  const r = loadRealm();
  assert.deepEqual(validateRealm(r), []);
  assert.doesNotMatch(JSON.stringify(r), /"secret":\s*"(?!\$\{)/);
});

test('validation rejects weakened settings', () => {
  const r = loadRealm();
  r.bruteForceProtected = false;
  const [console_, api] = [clientAt(r, 0), clientAt(r, 1)];
  console_.attributes = {};
  console_.redirectUris = ['https://x.test/*'];
  api.secret = 'literal';
  const p = validateRealm(r).join('\n');
  assert.match(p, /bruteForceProtected/);
  assert.match(p, /PKCE S256/);
  assert.match(p, /wildcard/);
  assert.match(p, /literal secret/);
});

test('placeholders resolve; missing ones fail closed', () => {
  const out = resolvePlaceholders(loadRealm(), ENV);
  assert.equal(JSON.stringify(out).includes('${'), false);
  assert.throws(() => resolvePlaceholders(loadRealm(), {}), /BW_CONSOLE_ORIGIN/);
});

/** @typedef {Record<string, unknown>} Doc */

function fakeKeycloak() {
  /** @type {{ realm: Doc | null, roles: Map<string, Doc>, scopes: Doc[], clients: Doc[], calls: string[] }} */
  const db = { realm: null, roles: new Map(), scopes: [], clients: [], calls: [] };
  let n = 0;
  /** @type {(b: unknown, s?: number) => Response} */
  const j = (b, s = 200) =>
    /** @type {Response} */ (
      /** @type {unknown} */ ({ ok: s < 300, status: s, json: () => Promise.resolve(b) })
    );
  /** @type {typeof fetch} */
  const fetchFn = (url, { method, body } = {}) => {
    const parsed = new URL(typeof url === 'string' ? url : url instanceof URL ? url.href : url.url);
    const u = parsed.pathname;
    /** @type {Doc} */
    const b = typeof body === 'string' ? /** @type {Doc} */ (JSON.parse(body)) : {};
    db.calls.push(`${method} ${u}`);
    return Promise.resolve(handle(method, u, parsed, b));
  };
  /** @type {(method: string | undefined, u: string, parsed: URL, b: Doc) => Response} */
  const handle = (method, u, parsed, b) => {
    if (u === '/admin/realms/blackwing') {
      if (method === 'GET') return db.realm ? j(db.realm) : j({}, 404);
      db.realm = b;
      return j(null, 204);
    }
    if (u === '/admin/realms') {
      db.realm = b;
      return j(null, 201);
    }
    if (u.includes('/roles')) {
      const nm = decodeURIComponent((u.split('/roles')[1] ?? '').replace(/^\//, ''));
      if (method === 'GET') return db.roles.has(nm) ? j({ name: nm }) : j({}, 404);
      if (method === 'POST') db.roles.set(String(b.name), b);
      return j(null, 204);
    }
    if (u.includes('/client-scopes')) {
      if (method === 'GET') return j(db.scopes);
      if (method === 'POST') db.scopes.push({ ...b, id: `s${++n}` });
      return j(null, 204);
    }
    if (u.includes('/clients')) {
      if (method === 'GET') {
        const q = parsed.searchParams.get('clientId');
        return j(q ? db.clients.filter((c) => c.clientId === q) : db.clients);
      }
      if (method === 'POST') db.clients.push({ ...b, id: `c${++n}` });
      return j(null, 204);
    }
    throw new Error(`unexpected ${method} ${u}`);
  };
  return { db, fetchFn };
}

test('sync is idempotent: re-run creates nothing, never deletes or touches users', async () => {
  const realm = resolvePlaceholders(loadRealm(), ENV);
  const { db, fetchFn } = fakeKeycloak();
  const first = await sync(realm, { base: 'http://kc', token: 't', fetchFn });
  assert.ok(first.created > 0);
  const counts = [db.clients.length, db.roles.size, db.scopes.length];
  const second = await sync(realm, { base: 'http://kc', token: 't', fetchFn });
  assert.equal(second.created, 0);
  assert.deepEqual([db.clients.length, db.roles.size, db.scopes.length], counts);
  assert.equal(db.clients.length, 3);
  assert.ok(!db.calls.some((c) => c.startsWith('DELETE') || c.includes('/users')));
});

test('post-sync assertion fails when a required client is missing', async () => {
  const realm = resolvePlaceholders(loadRealm(), ENV);
  realm.clients = (realm.clients ?? []).filter((c) => c.clientId !== 'blackwing-cli');
  const { fetchFn } = fakeKeycloak();
  await assert.rejects(sync(realm, { base: 'http://kc', token: 't', fetchFn }), /blackwing-cli/);
});
