#!/usr/bin/env node
// Idempotent Keycloak realm sync (IAM-001, #329). Upserts realm settings, roles, client scopes and
// clients from infra/keycloak/realm-blackwing.json through the admin REST API. It never deletes and
// never touches users, organizations or identity providers, so re-runs are safe on a live realm.
// The MFA section (IAM-005, #338) creates the browser flow and enables the second-factor required actions.
// A live flow that differs from the file is a hard failure: the sync never rewrites an existing flow.
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

const MAX_ACCESS_TOKEN_LIFESPAN_SECONDS = 300;
const MAX_OTP_LOOK_AHEAD_WINDOW = 2;
const HTTP_NOT_FOUND = 404;
/** Providers the second factor needs: the password step, both factors and the "user has this factor" condition. */
const MFA_PROVIDERS = Object.freeze([
  'auth-username-password-form',
  'conditional-user-configured',
  'auth-otp-form',
  'webauthn-authenticator',
]);

/**
 * @typedef {{ name?: string, id?: string } & Record<string, unknown>} Named
 * @typedef {{ clientId: string, id?: string, publicClient?: boolean, standardFlowEnabled?: boolean,
 *   implicitFlowEnabled?: boolean, directAccessGrantsEnabled?: boolean, serviceAccountsEnabled?: boolean,
 *   secret?: string, redirectUris?: string[], webOrigins?: string[], attributes?: Record<string, string> }
 *   & Record<string, unknown>} Client
 * @typedef {{ name: string, protocolMappers?: Named[] } & Record<string, unknown>} ClientScope
 * @typedef {{ provider: string, requirement: string } | { alias: string, requirement: string,
 *   children: FlowNode[] }} FlowNode
 * @typedef {{ description?: string, flow?: { alias: string, executions: FlowNode[] },
 *   requiredActions?: { alias: string, name: string, enabled: unknown, defaultAction: boolean,
 *   priority: number }[] }} MfaSection
 * @typedef {{ realm: string, sslRequired?: string, bruteForceProtected?: boolean,
 *   organizationsEnabled?: boolean, duplicateEmailsAllowed?: boolean, loginWithEmailAllowed?: boolean,
 *   accessTokenLifespan?: number, clients?: Client[], clientScopes?: ClientScope[],
 *   roles?: { realm?: Named[] }, attributes?: Record<string, string>, users?: unknown,
 *   browserFlow?: string, mfa?: MfaSection }
 *   & Record<string, unknown>} Realm
 */

/**
 * Replaces `${VAR}` in every string; throws listing ALL missing variables (fail closed).
 * @template T
 * @param {T} value
 * @param {Record<string, string | undefined>} env
 * @returns {T}
 */
export function resolvePlaceholders(value, env) {
  const missing = new Set();
  /** @type {(v: unknown) => unknown} */
  const walk = (v) => {
    if (typeof v === 'string')
      return v.replace(/\$\{([A-Z0-9_]+)\}/g, (_, /** @type {string} */ n) => {
        const x = env[n];
        if (x === undefined || x === '') missing.add(n);
        return x ?? '';
      });
    if (Array.isArray(v)) return v.map((x) => walk(x));
    if (v && typeof v === 'object')
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  const out = /** @type {T} */ (walk(value));
  if (missing.size)
    throw new Error(`missing environment variables: ${[...missing].sort().join(', ')}`);
  return out;
}

/** @param {string} [file] @returns {Realm} */
export function loadRealm(file = REALM_FILE) {
  /** @type {unknown} */
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  return /** @type {Realm} */ (parsed);
}

/**
 * Visits every node of a flow tree depth-first, with its depth. The order matches the Admin API listing.
 * @param {FlowNode[]} nodes
 * @param {(node: FlowNode, level: number) => void} visit
 * @param {number} [level]
 */
export function walkFlow(nodes, visit, level = 0) {
  for (const n of nodes) {
    visit(n, level);
    if ('children' in n) walkFlow(n.children, visit, level + 1);
  }
}

/**
 * The listing key of each node, e.g. `0|flow:blackwing forms|ALTERNATIVE`; compared against the live flow.
 * @param {FlowNode[]} nodes
 * @returns {string[]}
 */
export function flowKeys(nodes) {
  /** @type {string[]} */
  const keys = [];
  walkFlow(nodes, (n, level) =>
    keys.push(
      'children' in n
        ? `${level}|flow:${n.alias}|${n.requirement}`
        : `${level}|exec:${n.provider}|${n.requirement}`,
    ),
  );
  return keys;
}

/**
 * Returns a list of problems (empty = valid).
 * @param {Realm} r
 * @returns {string[]}
 */
export function validateRealm(r) {
  /** @type {string[]} */
  const p = [];
  if (r.realm !== 'blackwing') p.push('realm must be "blackwing"');
  if (r.sslRequired !== 'external') p.push('sslRequired must be external');
  if (r.bruteForceProtected !== true) p.push('bruteForceProtected must be true');
  if (r.organizationsEnabled !== true) p.push('organizationsEnabled must be true');
  if (r.duplicateEmailsAllowed !== false) p.push('duplicateEmailsAllowed must be false');
  if (r.loginWithEmailAllowed !== true) p.push('loginWithEmailAllowed must be true');
  const ttl = r.accessTokenLifespan ?? 0;
  if (!(ttl > 0 && ttl <= MAX_ACCESS_TOKEN_LIFESPAN_SECONDS))
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
  const acr = parseAcrMap(r.attributes?.['acr.loa.map']);
  if (acr?.password !== 1 || acr.strong !== 2 || Object.keys(acr).length !== 2)
    p.push('acr.loa.map must map exactly password=1 and strong=2 (step-up, IAM-009)');
  if (r.users) p.push('realm file must not contain users');
  p.push(...validateMfa(r));
  return p;
}

/**
 * @param {string | undefined} raw
 * @returns {Record<string, number> | undefined}
 */
function parseAcrMap(raw) {
  if (raw === undefined) return undefined;
  try {
    const parsed = /** @type {unknown} */ (JSON.parse(raw));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    return /** @type {Record<string, number>} */ (parsed);
  } catch {
    return undefined;
  }
}

/**
 * MFA rules for local accounts (IAM-005): TOTP and WebAuthn enabled, single-use TOTP codes, a bounded clock-drift
 * window, WebAuthn user verification, and a browser flow that carries both second factors.
 * @param {Realm} r
 * @returns {string[]}
 */
function validateMfa(r) {
  /** @type {string[]} */
  const p = [];
  const mfa = r.mfa;
  if (!mfa) return ['mfa section is required (IAM-005)'];
  if (r.browserFlow !== mfa.flow?.alias) p.push('browserFlow must be the mfa flow alias');
  const providers = new Set();
  walkFlow(mfa.flow?.executions ?? [], (n) => {
    if (!('children' in n)) providers.add(n.provider);
  });
  for (const need of MFA_PROVIDERS) if (!providers.has(need)) p.push(`mfa flow missing ${need}`);
  for (const alias of ['CONFIGURE_TOTP', 'webauthn-register'])
    if (!mfa.requiredActions?.some((a) => a.alias === alias && a.enabled === true))
      p.push(`required action ${alias} must be enabled`);
  const win = r.otpPolicyLookAheadWindow;
  if (!(Number.isInteger(win) && win >= 1 && win <= MAX_OTP_LOOK_AHEAD_WINDOW))
    p.push(`otpPolicyLookAheadWindow must be 1..${MAX_OTP_LOOK_AHEAD_WINDOW} periods`);
  if (r.otpPolicyCodeReusable !== false) p.push('otpPolicyCodeReusable must be false');
  if (r.webAuthnPolicyUserVerificationRequirement !== 'required')
    p.push('WebAuthn user verification must be required');
  return p;
}

/**
 * @param {typeof fetch} fetchFn
 * @param {string} base
 * @param {string} token
 * @param {string} method
 * @param {string} url
 * @param {unknown} [body]
 * @returns {Promise<unknown>}
 */
async function call(fetchFn, base, token, method, url, body) {
  const res = await fetchFn(`${base}${url}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (res.status === HTTP_NOT_FOUND && method === 'GET') return null;
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status}`);
  return method === 'GET' ? /** @type {unknown} */ (await res.json()) : null;
}

/**
 * Upsert-only sync. Returns counts. Never deletes, never touches users.
 * @param {Realm} realm
 * @param {{ base: string, token: string, fetchFn?: typeof fetch, log?: (m: string) => void }} opts
 */
export async function sync(realm, { base, token, fetchFn = fetch, log = () => undefined }) {
  const stats = { created: 0, updated: 0 };
  const { clients = [], roles = {}, clientScopes = [], mfa, ...settings } = realm;
  // The flow is bound only after it exists (see below), so the first realm PUT must not reference it.
  delete settings.browserFlow;
  const name = realm.realm;
  const R = `/admin/realms/${name}`;
  /** @type {(method: string, url: string, body?: unknown) => Promise<unknown>} */
  const c = (method, url, body) => call(fetchFn, base, token, method, url, body);
  /** @type {(url: string) => Promise<Named[]>} */
  const list = async (url) => /** @type {Named[] | null} */ (await c('GET', url)) ?? [];
  if (await c('GET', R)) {
    await c('PUT', R, settings);
    stats.updated++;
  } else {
    await c('POST', '/admin/realms', settings);
    stats.created++;
  }
  log(`realm ${name} synced`);
  /**
   * @template {Named} T
   * @param {string} kind
   * @param {string} listUrl
   * @param {keyof T & string} key
   * @param {T[]} items
   * @param {(it: T) => Promise<Named | undefined | null> | Named | undefined | null} lookup
   * @param {(found: Named) => string} idOf
   */
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
      log(`${kind} ${String(it[key])} ${found ? 'updated' : 'created'}`);
    }
  };
  await upsert(
    'role',
    `${R}/roles`,
    'name',
    roles.realm ?? [],
    async (r) =>
      /** @type {Named | null} */ (
        await c('GET', `${R}/roles/${encodeURIComponent(r.name ?? '')}`)
      ),
    (f) => encodeURIComponent(f.name ?? ''),
  );
  const scopes = await list(`${R}/client-scopes`);
  await upsert(
    'client-scope',
    `${R}/client-scopes`,
    'name',
    clientScopes,
    (s) => scopes.find((x) => x.name === s.name),
    (f) => f.id ?? '',
  );
  await upsert(
    'client',
    `${R}/clients`,
    'clientId',
    clients,
    async (cl) => (await list(`${R}/clients?clientId=${encodeURIComponent(cl.clientId)}`))[0],
    (f) => f.id ?? '',
  );
  // Startup assertion: everything required exists after the sync.
  const live = /** @type {Client[]} */ (await list(`${R}/clients`));
  for (const id of REQUIRED_CLIENTS)
    if (!live.some((x) => x.clientId === id))
      throw new Error(`post-sync assertion failed: client ${id} missing`);
  if (mfa) {
    const m = await syncMfa(realm.realm, mfa, c);
    stats.created += m.created;
    stats.updated += m.updated;
    await c('PUT', R, { realm: name, browserFlow: mfa.flow.alias });
    log(`browser flow ${mfa.flow.alias} bound`);
  }
  return stats;
}

/**
 * Creates the MFA browser flow when absent and enables the second-factor required actions. An existing flow is
 * compared with the file and a difference throws: the sync never rewrites a live flow.
 * @param {string} realmName
 * @param {MfaSection} mfa
 * @param {(method: string, url: string, body?: unknown) => Promise<unknown>} c
 */
async function syncMfa(realmName, mfa, c) {
  const stats = { created: 0, updated: 0 };
  const R = `/admin/realms/${realmName}`;
  if (!mfa.flow || !mfa.requiredActions)
    throw new Error('mfa section needs flow and requiredActions');
  const alias = mfa.flow.alias;
  for (const ra of mfa.requiredActions) {
    await c('PUT', `${R}/authentication/required-actions/${encodeURIComponent(ra.alias)}`, {
      alias: ra.alias,
      name: ra.name,
      providerId: ra.alias,
      enabled: ra.enabled,
      defaultAction: ra.defaultAction,
      priority: ra.priority,
    });
    stats.updated++;
  }
  const flows = /** @type {{ alias: string }[] | null} */ (
    await c('GET', `${R}/authentication/flows`)
  );
  if (flows?.some((f) => f.alias === alias)) {
    const live = /** @type {Named[] | null} */ (
      await c('GET', `${R}/authentication/flows/${encodeURIComponent(alias)}/executions`)
    );
    const liveKeys = (live ?? []).map((row) => {
      const level = /** @type {number} */ (row.level);
      const requirement = /** @type {string} */ (row.requirement);
      const id =
        row.authenticationFlow === true
          ? `flow:${String(row.displayName)}`
          : `exec:${String(row.providerId)}`;
      return `${level}|${id}|${requirement}`;
    });
    const want = flowKeys(mfa.flow.executions);
    if (liveKeys.length !== want.length || liveKeys.some((k, i) => k !== want[i]))
      throw new Error(
        `browser flow "${alias}" differs from realm-blackwing.json; reconcile it by hand`,
      );
  } else {
    await c('POST', `${R}/authentication/flows`, {
      alias,
      description: mfa.description,
      providerId: 'basic-flow',
      topLevel: true,
      builtIn: false,
    });
    await createFlowNodes(c, R, alias, mfa.flow.executions);
    stats.created++;
  }
  return stats;
}

/**
 * Appends each node to its parent flow in file order (Keycloak appends to the end of a flow), then sets its
 * requirement on the row it just created: the last direct child of the parent in the listing.
 * @param {(method: string, url: string, body?: unknown) => Promise<unknown>} c
 * @param {string} R
 * @param {string} parent
 * @param {FlowNode[]} nodes
 */
async function createFlowNodes(c, R, parent, nodes) {
  const url = `${R}/authentication/flows/${encodeURIComponent(parent)}/executions`;
  for (const n of nodes) {
    if ('children' in n) {
      await c('POST', `${url}/flow`, {
        alias: n.alias,
        type: 'basic-flow',
        description: n.alias,
        provider: 'registration-page-form',
      });
    } else {
      await c('POST', `${url}/execution`, { provider: n.provider });
    }
    const rows = /** @type {Named[] | null} */ (await c('GET', url));
    const added = (rows ?? []).findLast((row) => row.level === 0);
    if (!added)
      throw new Error(
        `browser flow "${parent}": node ${'children' in n ? n.alias : n.provider} was not created`,
      );
    await c('PUT', url, { ...added, requirement: n.requirement });
    if ('children' in n) await createFlowNodes(c, R, n.alias, n.children);
  }
}

/**
 * @param {Record<string, string | undefined>} env
 * @param {typeof fetch} [fetchFn]
 * @returns {Promise<string>}
 */
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
  return /** @type {{ access_token: string }} */ (await res.json()).access_token;
}

/**
 * @param {string[]} argv
 * @param {Record<string, string | undefined>} [env]
 * @returns {Promise<number>}
 */
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
    base: /** @type {string} */ (env.BW_KEYCLOAK_URL),
    token,
    log: (m) => process.stdout.write(`${m}\n`),
  });
  process.stdout.write(`sync done: ${JSON.stringify(stats)}\n`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (/** @type {unknown} */ e) => {
      process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
      process.exit(1);
    },
  );
