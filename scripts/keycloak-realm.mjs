#!/usr/bin/env node
// Keycloak dev realm `blackwing-dev` (DEVENV-004, #158).
//
//   node scripts/keycloak-realm.mjs check          # `pnpm dev:keycloak:check`: validate the committed realm
//   node scripts/keycloak-realm.mjs export         # `pnpm dev:keycloak:export`: re-export the running realm
//                                                  #   into infra/compose/keycloak/realm-export.json
//   node scripts/keycloak-realm.mjs reset --yes    # `pnpm dev:keycloak:reset`: drop the Keycloak DB, re-import
//
// The committed export is a projection of the full Keycloak export onto the sections Blackwing manages
// (MANAGED below): realm settings, realm roles, groups, users, the `bw-*` clients and the user profile.
// Ids, timestamps, hashed credentials and client secrets are stripped; secrets and the test-user
// password become `${BW_DEV_KEYCLOAK_*}` placeholders that Keycloak resolves from its environment at
// import. Nothing this script writes or prints contains a credential.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const REALM_FILE = path.join(ROOT, 'infra/compose/keycloak/realm-export.json');
const COMPOSE_FILE = path.join(ROOT, 'infra/compose/docker-compose.dev.yml');

export const REALM = 'blackwing-dev';
export const TENANT = 'acme';
/** Tenant-scoped realm roles (CONTEXT_PACK §1.2). */
export const TENANT_ROLES = Object.freeze([
  'appsec-engineer',
  'asset-owner',
  'developer',
  'org-admin',
  'auditor',
  'ci-pipeline',
]);
/** Platform roles: Tinycrows staff, fully separate from tenant roles (§1.2, §8.4). */
export const PLATFORM_ROLES = Object.freeze(['platform-operator']);

/** Test users (dev passwords only) and the one realm role each must carry. */
export const TEST_USERS = Object.freeze({
  'appsec@acme.test': 'appsec-engineer',
  'owner@acme.test': 'asset-owner',
  'dev@acme.test': 'developer',
  'admin@acme.test': 'org-admin',
  'auditor@acme.test': 'auditor',
  'operator@blackwing.test': 'platform-operator',
});
export const PASSWORD_PLACEHOLDER = '${BW_DEV_KEYCLOAK_TEST_USER_PASSWORD}';

export const BFF_CLIENT = 'bw-console-bff';
export const API_CLIENT = 'bw-api';
export const CI_CLIENT = 'bw-ci';
/** Client secret placeholders, resolved by Keycloak from its env at import. */
export const CLIENT_SECRETS = Object.freeze({
  [BFF_CLIENT]: '${BW_DEV_KEYCLOAK_BFF_SECRET}',
  [API_CLIENT]: '${BW_DEV_KEYCLOAK_API_SECRET}',
  [CI_CLIENT]: '${BW_DEV_KEYCLOAK_CI_SECRET}',
});
/**
 * Console origins: `https://app.bw.localhost` (DEVENV-013 local TLS proxy) and the raw Next.js dev
 * server. Keep in sync with the proxy and the BFF route; `check` fails on any drift.
 */
export const CONSOLE_ORIGINS = Object.freeze([
  'https://app.bw.localhost',
  'https://app.bw.localhost:18443',
  'http://localhost:3000',
]);
export const BFF_CALLBACK_PATH = '/auth/callback';

/** Realm-level settings kept in the committed export. */
const REALM_KEYS = Object.freeze([
  'realm',
  'displayName',
  'enabled',
  'sslRequired',
  'registrationAllowed',
  'loginWithEmailAllowed',
  'duplicateEmailsAllowed',
  'resetPasswordAllowed',
  'editUsernameAllowed',
  'rememberMe',
  'verifyEmail',
  'bruteForceProtected',
  'permanentLockout',
  'failureFactor',
  'accessTokenLifespan',
  'ssoSessionIdleTimeout',
  'ssoSessionMaxLifespan',
  'otpPolicyType',
  'attributes',
]);
const REALM_ATTRIBUTE_KEYS = Object.freeze(['bw.environment']);
const ROLE_KEYS = Object.freeze(['name', 'description', 'attributes']);
const GROUP_KEYS = Object.freeze(['name', 'path', 'attributes', 'realmRoles', 'subGroups']);
const USER_KEYS = Object.freeze([
  'username',
  'email',
  'emailVerified',
  'firstName',
  'lastName',
  'enabled',
  'attributes',
  'groups',
  'realmRoles',
  'serviceAccountClientId',
  'credentials',
  'requiredActions',
]);
const CLIENT_KEYS = Object.freeze([
  'clientId',
  'name',
  'description',
  'enabled',
  'protocol',
  'publicClient',
  'clientAuthenticatorType',
  'secret',
  'standardFlowEnabled',
  'implicitFlowEnabled',
  'directAccessGrantsEnabled',
  'serviceAccountsEnabled',
  'frontchannelLogout',
  'consentRequired',
  'fullScopeAllowed',
  'redirectUris',
  'webOrigins',
  'attributes',
  'protocolMappers',
]);
const CLIENT_ATTRIBUTE_KEYS = Object.freeze([
  'pkce.code.challenge.method',
  'post.logout.redirect.uris',
  'oauth2.device.authorization.grant.enabled',
  'oidc.ciba.grant.enabled',
]);
const MAPPER_KEYS = Object.freeze(['name', 'protocol', 'protocolMapper', 'config']);
const USER_PROFILE = 'org.keycloak.userprofile.UserProfileProvider';
const BUILTIN_ROLES = Object.freeze([
  'offline_access',
  'uma_authorization',
  `default-roles-${REALM}`,
]);

/** @typedef {Record<string, unknown>} Obj */

/** @param {unknown} v @returns {v is Obj} */
const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
/** @param {unknown} v @returns {Obj[]} */
const objs = (v) => (Array.isArray(v) ? v.filter((x) => isObj(x)) : []);
/** @param {unknown} v @returns {string[]} */
const strs = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);

/**
 * Keeps only `keys` of `o` (in that order), dropping undefined and empty arrays/objects.
 * @param {Obj} o @param {readonly string[]} keys @returns {Obj}
 */
function pick(o, keys) {
  /** @type {Obj} */
  const out = {};
  for (const k of keys) {
    const v = o[k];
    if (v === undefined || v === null) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    if (isObj(v) && Object.keys(v).length === 0) continue;
    out[k] = v;
  }
  return out;
}

/** Recursively sorts object keys (arrays keep their order). @param {unknown} v @returns {unknown} */
function sortKeys(v) {
  if (Array.isArray(v)) return v.map((x) => sortKeys(x));
  if (!isObj(v)) return v;
  return Object.fromEntries(
    Object.keys(v)
      .sort()
      .map((k) => [k, sortKeys(v[k])]),
  );
}

/** @param {Obj[]} list @param {string} key */
const byKey = (list, key) => [...list].sort((a, b) => String(a[key]).localeCompare(String(b[key])));

/** @param {Obj} g @returns {Obj} */
function cleanGroup(g) {
  const out = pick(g, GROUP_KEYS);
  const sub = objs(g.subGroups).map((g2) => cleanGroup(g2));
  if (sub.length > 0) out.subGroups = byKey(sub, 'name');
  else delete out.subGroups;
  return out;
}

/** @param {Obj} u @returns {Obj} */
function cleanUser(u) {
  const out = pick(u, USER_KEYS);
  const roles = strs(u.realmRoles).filter((r) => !BUILTIN_ROLES.includes(r));
  if (roles.length > 0) out.realmRoles = roles.sort();
  else delete out.realmRoles;
  if (typeof u.serviceAccountClientId === 'string') delete out.credentials;
  else out.credentials = [{ temporary: false, type: 'password', value: PASSWORD_PLACEHOLDER }];
  if (Array.isArray(out.groups)) out.groups = strs(out.groups).sort();
  return out;
}

/** @param {Obj} c @returns {Obj} */
function cleanClient(c) {
  const out = pick(c, CLIENT_KEYS);
  const clientId = String(c.clientId);
  if (out.publicClient === true) delete out.secret;
  else
    out.secret = Object.hasOwn(CLIENT_SECRETS, clientId)
      ? CLIENT_SECRETS[/** @type {keyof typeof CLIENT_SECRETS} */ (clientId)]
      : '';
  if (isObj(c.attributes)) {
    const attrs = pick(c.attributes, CLIENT_ATTRIBUTE_KEYS);
    if (Object.keys(attrs).length > 0) out.attributes = attrs;
    else delete out.attributes;
  }
  const mappers = objs(c.protocolMappers).map((m) => pick(m, MAPPER_KEYS));
  if (mappers.length > 0) out.protocolMappers = byKey(mappers, 'name');
  for (const k of ['redirectUris', 'webOrigins'])
    if (Array.isArray(out[k])) out[k] = strs(out[k]).sort();
  return out;
}

/** @param {unknown} components @returns {Obj | undefined} */
function cleanComponents(components) {
  if (!isObj(components)) return undefined;
  const ups = objs(components[USER_PROFILE]).map((c) => {
    const cfg = isObj(c.config) ? strs(c.config['kc.user.profile.config']) : [];
    const parsed = cfg[0] === undefined ? undefined : /** @type {unknown} */ (JSON.parse(cfg[0]));
    return {
      providerId: c.providerId,
      ...(parsed === undefined
        ? {}
        : { config: { 'kc.user.profile.config': [JSON.stringify(sortKeys(parsed))] } }),
    };
  });
  return ups.length > 0 ? { [USER_PROFILE]: ups } : undefined;
}

/**
 * Projects a (full) Keycloak realm export onto the committed, credential-free shape.
 * Idempotent: `sanitizeExport(sanitizeExport(x))` equals `sanitizeExport(x)`.
 * @param {Obj} raw
 * @returns {Obj}
 */
export function sanitizeExport(raw) {
  const out = pick(raw, REALM_KEYS);
  if (isObj(raw.attributes)) {
    const attrs = pick(raw.attributes, REALM_ATTRIBUTE_KEYS);
    if (Object.keys(attrs).length > 0) out.attributes = attrs;
    else delete out.attributes;
  }
  const roles = isObj(raw.roles) ? objs(raw.roles.realm) : [];
  out.roles = {
    realm: byKey(
      roles.filter((r) => !BUILTIN_ROLES.includes(String(r.name))).map((r) => pick(r, ROLE_KEYS)),
      'name',
    ),
  };
  out.groups = byKey(
    objs(raw.groups).map((g2) => cleanGroup(g2)),
    'name',
  );
  out.users = byKey(
    objs(raw.users).map((u) => cleanUser(u)),
    'username',
  );
  out.clients = byKey(
    objs(raw.clients)
      .filter((c) => String(c.clientId).startsWith('bw-'))
      .map((c) => cleanClient(c)),
    'clientId',
  );
  const components = cleanComponents(raw.components);
  if (components) out.components = components;
  return /** @type {Obj} */ (sortKeys(out));
}

/** @param {Obj} realm @returns {string} */
export function serialize(realm) {
  return `${JSON.stringify(realm, null, 2)}\n`;
}

/**
 * Effective realm roles of a user: direct roles plus the roles of every group on its path.
 * @param {Obj} realm @param {Obj} user @returns {Set<string>}
 */
export function effectiveRoles(realm, user) {
  const roles = new Set(strs(user.realmRoles));
  /** @type {Map<string, string[]>} */
  const byPath = new Map();
  /** @param {Obj[]} groups @param {string} parent */
  const walk = (groups, parent) => {
    for (const g of groups) {
      const p = `${parent}/${String(g.name)}`;
      byPath.set(p, strs(g.realmRoles));
      walk(objs(g.subGroups), p);
    }
  };
  walk(objs(realm.groups), '');
  for (const gp of strs(user.groups)) {
    const parts = gp.split('/').filter(Boolean);
    for (let i = 1; i <= parts.length; i += 1)
      for (const r of byPath.get(`/${parts.slice(0, i).join('/')}`) ?? []) roles.add(r);
  }
  return roles;
}

/**
 * Validates the committed realm export. Returns a list of problems (empty = valid).
 * @param {unknown} realm
 * @returns {string[]}
 */
export function validateRealm(realm) {
  /** @type {string[]} */
  const errors = [];
  const fail = (/** @type {string} */ m) => errors.push(m);
  if (!isObj(realm)) return ['realm export is not a JSON object'];

  if (realm.realm !== REALM)
    fail(`realm must be "${REALM}" (dev only), got ${String(realm.realm)}`);
  if (!isObj(realm.attributes) || realm.attributes['bw.environment'] !== 'dev')
    fail('realm attribute bw.environment must be "dev"');
  if (realm.registrationAllowed !== false) fail('self-registration must be disabled');
  if (realm.bruteForceProtected !== true) fail('brute-force protection must be on');
  if (realm.sslRequired !== 'external') fail('sslRequired must be "external"');

  const text = JSON.stringify(realm);
  for (const m of text.matchAll(/\$\{([^}]*)\}/g))
    if (!/^BW_DEV_KEYCLOAK_[A-Z0-9_]+$/.test(m[1] ?? ''))
      fail(`unexpected placeholder \${${String(m[1])}}`);
  if (/"(secretData|credentialData|hashedSaltedValue)"/.test(text))
    fail('hashed credentials must not be committed');
  if (/"(id|containerId|createdTimestamp)":/.test(text)) fail('ids/timestamps must be stripped');

  const roleNames = new Set(
    objs(isObj(realm.roles) ? realm.roles.realm : undefined).map((r) => String(r.name)),
  );
  for (const r of [...TENANT_ROLES, ...PLATFORM_ROLES])
    if (!roleNames.has(r)) fail(`missing realm role ${r}`);
  for (const r of objs(isObj(realm.roles) ? realm.roles.realm : undefined)) {
    const scope = isObj(r.attributes) ? strs(r.attributes['bw.scope'])[0] : undefined;
    const want = PLATFORM_ROLES.includes(String(r.name)) ? 'platform' : 'tenant';
    if (scope !== want) fail(`role ${String(r.name)} must have attribute bw.scope=${want}`);
  }

  const users = objs(realm.users);
  for (const [username, role] of Object.entries(TEST_USERS)) {
    const u = users.find((x) => x.username === username);
    if (!u) {
      fail(`missing test user ${username}`);
      continue;
    }
    if (u.email !== username || u.emailVerified !== true || u.enabled !== true)
      fail(`${username}: email must match, be verified and enabled`);
    if (!u.firstName || !u.lastName)
      fail(`${username}: firstName/lastName required (no profile prompt)`);
    if (strs(u.requiredActions).length > 0)
      fail(`${username}: no required actions (no MFA in dev)`);
    const creds = objs(u.credentials);
    if (
      creds.length !== 1 ||
      !creds.every((c) => c.value === PASSWORD_PLACEHOLDER && c.temporary === false)
    )
      fail(`${username}: password must be the ${PASSWORD_PLACEHOLDER} placeholder`);
    const roles = effectiveRoles(realm, u);
    if (!roles.has(role)) fail(`${username}: missing role ${role}`);
    const tenant = isObj(u.attributes) ? strs(u.attributes.tenant) : [];
    if (PLATFORM_ROLES.includes(role)) {
      const leaked = [...roles].filter((r) => TENANT_ROLES.includes(r));
      if (leaked.length > 0)
        fail(`${username}: platform operator holds tenant roles ${leaked.join(',')}`);
      if (tenant.length > 0) fail(`${username}: platform operator must have no tenant attribute`);
    } else {
      if (tenant.join(',') !== TENANT) fail(`${username}: tenant attribute must be ${TENANT}`);
      const platform = [...roles].filter((r) => PLATFORM_ROLES.includes(r));
      if (platform.length > 0) fail(`${username}: tenant user holds platform roles`);
    }
  }
  for (const u of users) {
    const name = String(u.username);
    const isSa = typeof u.serviceAccountClientId === 'string';
    if (!isSa && !(name in TEST_USERS)) fail(`unexpected user ${name}`);
    if (!isSa && !name.endsWith('.test')) fail(`${name}: test users use the reserved .test TLD`);
  }

  const clients = objs(realm.clients);
  const client = (/** @type {string} */ id) => clients.find((c) => c.clientId === id);
  const bff = client(BFF_CLIENT);
  if (!bff) fail(`missing client ${BFF_CLIENT}`);
  else {
    if (bff.publicClient !== false) fail(`${BFF_CLIENT} must be confidential`);
    if (bff.standardFlowEnabled !== true)
      fail(`${BFF_CLIENT} must allow the authorization code flow`);
    for (const k of ['implicitFlowEnabled', 'directAccessGrantsEnabled', 'serviceAccountsEnabled'])
      if (bff[k] !== false) fail(`${BFF_CLIENT}.${k} must be false`);
    const attrs = isObj(bff.attributes) ? bff.attributes : {};
    if (attrs['pkce.code.challenge.method'] !== 'S256')
      fail(`${BFF_CLIENT} must require PKCE S256`);
    const want = CONSOLE_ORIGINS.map((o) => `${o}${BFF_CALLBACK_PATH}`).sort();
    if (JSON.stringify(strs(bff.redirectUris).sort()) !== JSON.stringify(want))
      fail(`${BFF_CLIENT} redirectUris must be exactly ${want.join(', ')}`);
    if (strs(bff.redirectUris).some((u) => u.includes('*')))
      fail('wildcard redirect URIs are forbidden');
    if (JSON.stringify(strs(bff.webOrigins).sort()) !== JSON.stringify([...CONSOLE_ORIGINS].sort()))
      fail(`${BFF_CLIENT} webOrigins must be exactly the console origins`);
  }
  const api = client(API_CLIENT);
  if (!api) fail(`missing client ${API_CLIENT}`);
  else
    for (const k of [
      'standardFlowEnabled',
      'implicitFlowEnabled',
      'directAccessGrantsEnabled',
      'serviceAccountsEnabled',
      'publicClient',
    ])
      if (api[k] !== false) fail(`${API_CLIENT}.${k} must be false (resource server only)`);
  const ci = client(CI_CLIENT);
  if (!ci) fail(`missing client ${CI_CLIENT}`);
  else {
    if (ci.serviceAccountsEnabled !== true) fail(`${CI_CLIENT} must have a service account`);
    for (const k of [
      'standardFlowEnabled',
      'implicitFlowEnabled',
      'directAccessGrantsEnabled',
      'publicClient',
    ])
      if (ci[k] !== false) fail(`${CI_CLIENT}.${k} must be false (client credentials only)`);
    const sa = users.find((u) => u.serviceAccountClientId === CI_CLIENT);
    if (!sa) fail(`${CI_CLIENT} service-account user missing`);
    else if (!effectiveRoles(realm, sa).has('ci-pipeline'))
      fail(`${CI_CLIENT} service account needs ci-pipeline`);
  }
  for (const c of [bff, api, ci].filter((x) => isObj(x))) {
    const id = String(c.clientId);
    if (c.secret !== CLIENT_SECRETS[/** @type {keyof typeof CLIENT_SECRETS} */ (id)])
      fail(`${id}: secret must be its \${BW_DEV_KEYCLOAK_*} placeholder`);
  }
  for (const c of [bff, ci].filter((x) => isObj(x))) {
    const mappers = objs(c.protocolMappers);
    const tenant = mappers.find(
      (m) =>
        m.protocolMapper === 'oidc-usermodel-attribute-mapper' &&
        isObj(m.config) &&
        m.config['claim.name'] === 'tenant',
    );
    if (!tenant || !isObj(tenant.config) || tenant.config['access.token.claim'] !== 'true')
      fail(`${String(c.clientId)}: tenant claim mapper (access token) missing`);
    const aud = mappers.find((m) => m.protocolMapper === 'oidc-audience-mapper');
    if (!aud || !isObj(aud.config) || aud.config['included.client.audience'] !== API_CLIENT)
      fail(`${String(c.clientId)}: audience mapper for ${API_CLIENT} missing`);
  }

  const ups = isObj(realm.components) ? objs(realm.components[USER_PROFILE]) : [];
  const cfgText =
    ups[0] && isObj(ups[0].config) ? strs(ups[0].config['kc.user.profile.config'])[0] : undefined;
  if (cfgText === undefined) fail('user profile must declare the tenant attribute');
  else {
    const cfg = /** @type {unknown} */ (JSON.parse(cfgText));
    const attrs = isObj(cfg) ? objs(cfg.attributes) : [];
    const t = attrs.find((a) => a.name === 'tenant');
    const perms = t && isObj(t.permissions) ? t.permissions : {};
    if (!t) fail('user profile must declare the tenant attribute');
    else if (JSON.stringify(strs(perms.edit)) !== '["admin"]')
      fail('tenant attribute must be editable by admins only (users cannot change their tenant)');
    if (isObj(cfg) && cfg.unmanagedAttributePolicy !== undefined)
      fail('unmanaged attributes must stay disabled');
  }
  return errors;
}

/** @returns {Obj} */
export function loadRealm(file = REALM_FILE) {
  /** @type {unknown} */
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  if (!isObj(parsed)) throw new Error(`${file}: realm export must be a JSON object`);
  return parsed;
}

/**
 * @typedef {{ envFile: string, project: string, override: string | undefined, yes: boolean }} CliOpts
 * @param {string[]} argv @returns {CliOpts}
 */
export function parseCliArgs(argv) {
  /** @type {CliOpts} */
  const o = { envFile: path.join(ROOT, '.env'), project: 'bwdev', override: undefined, yes: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--yes') o.yes = true;
    else if (arg === '--env-file' && next) {
      o.envFile = path.resolve(next);
      i += 1;
    } else if (arg === '--project' && next) {
      o.project = next;
      i += 1;
    } else if (arg === '--override' && next) {
      o.override = path.resolve(next);
      i += 1;
    } else throw new Error(`unknown or incomplete argument: ${String(arg)}`);
  }
  return o;
}

/** @param {CliOpts} cli @param {string[]} args @param {{ capture?: boolean }} [o] */
function compose(cli, args, o = {}) {
  const files = ['-f', COMPOSE_FILE, ...(cli.override ? ['-f', cli.override] : [])];
  return execFileSync(
    'docker',
    ['compose', '-p', cli.project, '--env-file', cli.envFile, ...files, ...args],
    {
      encoding: 'utf8',
      stdio: o.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    },
  );
}

/** @param {string[]} argv @returns {number} */
export function main(argv) {
  const [cmd = 'check', ...rest] = argv;
  const cli = parseCliArgs(rest);
  if (cmd === 'check') {
    const errors = validateRealm(loadRealm());
    const committed = readFileSync(REALM_FILE, 'utf8');
    if (serialize(sanitizeExport(loadRealm())) !== committed)
      errors.push('realm-export.json is not in canonical form: run `pnpm dev:keycloak:export`');
    for (const e of errors) process.stderr.write(`realm-export.json: ${e}\n`);
    if (errors.length === 0) process.stdout.write(`realm-export.json: ok (${REALM})\n`);
    return errors.length === 0 ? 0 : 1;
  }
  if (cmd === 'export') {
    // A second Keycloak process exports the realm from the shared DB without touching the server.
    const out = '/tmp/bw-realm-export.json';
    compose(cli, [
      'exec',
      '-T',
      'keycloak',
      '/opt/keycloak/bin/kc.sh',
      'export',
      '--realm',
      REALM,
      '--users',
      'same_file',
      '--file',
      out,
      '--http-management-port',
      '9001',
    ]);
    const raw = compose(cli, ['exec', '-T', 'keycloak', 'cat', out], { capture: true });
    compose(cli, ['exec', '-T', 'keycloak', 'rm', '-f', out]);
    /** @type {unknown} */
    const parsedExport = JSON.parse(raw);
    if (!isObj(parsedExport)) throw new Error('keycloak export is not a JSON object');
    const clean = sanitizeExport(parsedExport);
    const errors = validateRealm(clean);
    writeFileSync(REALM_FILE, serialize(clean));
    for (const e of errors) process.stderr.write(`warning: ${e}\n`);
    process.stdout.write(`wrote ${path.relative(ROOT, REALM_FILE)} (review with git diff)\n`);
    return errors.length === 0 ? 0 : 1;
  }
  if (cmd === 'reset') {
    if (!cli.yes) {
      process.stderr.write(
        'dev:keycloak:reset drops the shared Keycloak database (all realms, sessions and users) and\n' +
          're-imports realm-export.json. Re-run with --yes: pnpm dev:keycloak:reset --yes\n',
      );
      return 2;
    }
    compose(cli, ['stop', 'keycloak']);
    compose(cli, ['run', '--rm', '-e', 'BW_KEYCLOAK_DB_RESET=yes', 'keycloak-db']);
    compose(cli, ['up', '-d', '--wait', '--wait-timeout', '300', 'keycloak']);
    return 0;
  }
  process.stderr.write(`unknown command: ${cmd} (expected check | export | reset)\n`);
  return 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `keycloak-realm: ${error instanceof Error ? error.message.split('\n')[0] : 'failed'}\n`,
    );
    process.exitCode = 1;
  }
}
