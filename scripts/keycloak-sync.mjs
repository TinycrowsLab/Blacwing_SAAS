#!/usr/bin/env node
// Idempotent Keycloak realm sync (IAM-001, #329). Upserts realm settings, roles, client scopes and
// clients from infra/keycloak/realm-blackwing.json through the admin REST API. It never deletes and
// never touches users, organizations or identity providers, so re-runs are safe on a live realm.
//   node scripts/keycloak-sync.mjs check      # offline validation of the committed realm
//   node scripts/keycloak-sync.mjs apply      # sync (needs BW_KEYCLOAK_URL + admin credentials in env)
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const REALM_FILE = path.join(ROOT, 'infra/keycloak/realm-blackwing.json');
export const REQUIRED_CLIENTS = Object.freeze([
  'blackwing-console',
  'blackwing-api',
  'blackwing-cli',
]);
export const REQUIRED_ROLES = Object.freeze([
  'appsec-engineer',
  'asset-owner',
  'developer',
  'org-admin',
  'auditor',
  'ci-pipeline',
  'platform-operator',
]);
export const REQUIRED_CLAIMS = Object.freeze(['tenantId', 'roles']);

/** Replaces `${VAR}` in every string; throws listing ALL missing variables (fail closed). */
export function resolvePlaceholders(value, env) {
  const missing = new Set();
  const walk = (v) => {
    if (typeof v === 'string')
      return v.replace(/\$\{([A-Z0-9_]+)\}/g, (_, n) => {
        const x = env[n];
        if (x === undefined || x === '') missing.add(n);
        return x ?? '';
      });
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object')
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  const out = walk(value);
  if (missing.size)
    throw new Error(`missing environment variables: ${[...missing].sort().join(', ')}`);
  return out;
}

export function loadRealm(file = REALM_FILE) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

/** Returns a list of problems (empty = valid). */
export function validateRealm(r) {
  const p = [];
  if (r.realm !== 'blackwing') p.push('realm must be "blackwing"');
  if (r.sslRequired !== 'external') p.push('sslRequired must be external');
  if (r.bruteForceProtected !== true) p.push('bruteForceProtected must be true');
  if (r.organizationsEnabled !== true) p.push('organizationsEnabled must be true');
  if (r.duplicateEmailsAllowed !== false) p.push('duplicateEmailsAllowed must be false');
  if (r.loginWithEmailAllowed !== true) p.push('loginWithEmailAllowed must be true');
  if (!(r.accessTokenLifespan > 0 && r.accessTokenLifespan <= 300))
    p.push('accessTokenLifespan must be 1..300s');
  const clients = new Map((r.clients ?? []).map((c) => [c.clientId, c]));
  for (const id of REQUIRED_CLIENTS) if (!clients.has(id)) p.push(`missing client ${id}`);
  const con = clients.get('blackwing-console');
  if (con) {
    if (con.publicClient !== true || con.standardFlowEnabled !== true)
      p.push('console must be public with standard flow');
    if (con.attributes?.['pkce.code.challenge.method'] !== 'S256')
      p.push('console must require PKCE S256');
    if (con.implicitFlowEnabled || con.directAccessGrantsEnabled)
      p.push('console must not allow implicit/password grants');
  }
  for (const id of ['blackwing-api', 'blackwing-cli']) {
    const c = clients.get(id);
    if (!c) continue;
    if (c.publicClient !== false) p.push(`${id} must be confidential`);
    if (c.serviceAccountsEnabled !== true) p.push(`${id} needs service accounts`);
    if (c.secret !== undefined && !/^\$\{[A-Z0-9_]+\}$/.test(c.secret))
      p.push(`${id} secret must be a placeholder (literal secret)`);
  }
  for (const c of clients.values())
    for (const u of [...(c.redirectUris ?? []), ...(c.webOrigins ?? [])])
      if (u.includes('*')) p.push(`${c.clientId}: wildcard redirect/origin "${u}"`);
  const roles = new Set((r.roles?.realm ?? []).map((x) => x.name));
  for (const n of REQUIRED_ROLES) if (!roles.has(n)) p.push(`missing role ${n}`);
  const mappers = (r.clientScopes ?? []).flatMap((s) => s.protocolMappers ?? []).map((x) => x.name);
  for (const n of REQUIRED_CLAIMS) if (!mappers.includes(n)) p.push(`missing claim mapper ${n}`);
  if (!r.attributes?.['acr.loa.map']) p.push('acr.loa.map required for step-up');
  if (r.users) p.push('realm file must not contain users');
  return p;
}

async function call(fetchFn, base, token, method, url, body) {
  const res = await fetchFn(`${base}${url}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 404 && method === 'GET') return null;
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status}`);
  return method === 'GET' ? res.json() : null;
}

/** Upsert-only sync. Returns counts. Never deletes, never touches users. */
export async function sync(realm, { base, token, fetchFn = fetch, log = () => {} }) {
  const stats = { created: 0, updated: 0 };
  const { clients = [], roles = {}, clientScopes = [], ...settings } = realm;
  const name = realm.realm;
  const R = `/admin/realms/${name}`;
  const c = (method, url, body) => call(fetchFn, base, token, method, url, body);
  if (await c('GET', R)) {
    await c('PUT', R, settings);
    stats.updated++;
  } else {
    await c('POST', '/admin/realms', settings);
    stats.created++;
  }
  log(`realm ${name} synced`);
  const upsert = async (kind, listUrl, key, items, lookup, idOf) => {
    for (const it of items) {
      const found = await lookup(it);
      if (found) {
        await c('PUT', `${listUrl}/${idOf(found)}`, { ...it, id: found.id });
        stats.updated++;
      } else {
        await c('POST', listUrl, it);
        stats.created++;
      }
      log(`${kind} ${it[key]} ${found ? 'updated' : 'created'}`);
    }
  };
  await upsert(
    'role',
    `${R}/roles`,
    'name',
    roles.realm ?? [],
    (r) => c('GET', `${R}/roles/${encodeURIComponent(r.name)}`),
    (f) => encodeURIComponent(f.name),
  );
  const scopes = (await c('GET', `${R}/client-scopes`)) ?? [];
  await upsert(
    'client-scope',
    `${R}/client-scopes`,
    'name',
    clientScopes,
    (s) => scopes.find((x) => x.name === s.name),
    (f) => f.id,
  );
  await upsert(
    'client',
    `${R}/clients`,
    'clientId',
    clients,
    async (cl) => (await c('GET', `${R}/clients?clientId=${encodeURIComponent(cl.clientId)}`))?.[0],
    (f) => f.id,
  );
  // Startup assertion: everything required exists after the sync.
  const live = (await c('GET', `${R}/clients`)) ?? [];
  for (const id of REQUIRED_CLIENTS)
    if (!live.some((x) => x.clientId === id))
      throw new Error(`post-sync assertion failed: client ${id} missing`);
  return stats;
}

async function adminToken(env, fetchFn = fetch) {
  const body = new URLSearchParams({
    grant_type: 'password',
    client_id: 'admin-cli',
    username: env.BW_KEYCLOAK_ADMIN_USER ?? '',
    password: env.BW_KEYCLOAK_ADMIN_PASSWORD ?? '',
  });
  const res = await fetchFn(`${env.BW_KEYCLOAK_URL}/realms/master/protocol/openid-connect/token`, {
    method: 'POST',
    body,
  });
  if (!res.ok) throw new Error(`admin token request failed: ${res.status}`);
  return (await res.json()).access_token;
}

export async function main(argv, env = process.env) {
  const raw = loadRealm();
  const problems = validateRealm(raw);
  if (problems.length) {
    for (const x of problems) process.stderr.write(`realm-blackwing.json: ${x}\n`);
    return 1;
  }
  if (argv[0] === 'check') {
    process.stdout.write('realm-blackwing.json: ok\n');
    return 0;
  }
  if (argv[0] !== 'apply') {
    process.stderr.write('usage: keycloak-sync.mjs check|apply\n');
    return 2;
  }
  for (const v of ['BW_KEYCLOAK_URL', 'BW_KEYCLOAK_ADMIN_USER', 'BW_KEYCLOAK_ADMIN_PASSWORD'])
    if (!env[v]) {
      process.stderr.write(`missing environment variable ${v}\n`);
      return 1;
    }
  const realm = resolvePlaceholders(raw, env);
  const token = await adminToken(env);
  const stats = await sync(realm, {
    base: env.BW_KEYCLOAK_URL,
    token,
    log: (m) => process.stdout.write(`${m}\n`),
  });
  process.stdout.write(`sync done: ${JSON.stringify(stats)}\n`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      process.stderr.write(`${e.message}\n`);
      process.exit(1);
    },
  );
