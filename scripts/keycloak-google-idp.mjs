#!/usr/bin/env node
// Google SSO for the dev realm (`pnpm demo google`, also run by `pnpm demo`). Google is brokered by Keycloak only:
// the app never talks to Google. This script upserts the `google` identity provider in realm blackwing-dev and,
// in the demo only, the mappers that give a first-time Google user the demo tenant and roles.
//
//   node scripts/keycloak-google-idp.mjs     # idempotent; exit 0 with instructions when the client is not set
//
// Reads BW_DEV_GOOGLE_CLIENT_ID / BW_DEV_GOOGLE_CLIENT_SECRET from the process environment, else from the repository
// `.env`. Admin credentials come from BW_DEV_KEYCLOAK_ADMIN_USER / BW_DEV_KEYCLOAK_ADMIN_PASSWORD. Secrets are never
// printed, logged or written to a tracked file.
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const REALM = 'blackwing-dev';
export const IDP_ALIAS = 'google';
/** The demo tenant (slug) a Google user is placed in. Demo mode only. */
export const DEMO_TENANT_SLUG = 'acme';
/** Realm role granted ONLY by the Google mappers. The demo API uses it to recognise a first-time Google user. */
export const DEMO_MARKER_ROLE = 'bw-demo-google';
/** Realm roles every Google user gets in the demo: requester (appsec-engineer) and read access (auditor). */
export const DEMO_ROLES = Object.freeze(['appsec-engineer', 'auditor']);
export const DEFAULT_KEYCLOAK_PORT = '18080';
const HTTP_NOT_FOUND = 404;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Parses KEY=VALUE lines (no expansion, no quoting rules beyond stripping one pair of quotes).
 * @param {string} text
 * @returns {Record<string, string>}
 */
export function parseEnvText(text) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    out[line.slice(0, eq).trim()] = line
      .slice(eq + 1)
      .trim()
      .replace(/^(["'])(.*)\1$/, '$2');
  }
  return out;
}

/**
 * The Google client. The process environment wins over `.env`, but an empty value never hides a set one.
 * @param {Record<string, string | undefined>} processEnv
 * @param {Record<string, string>} fileEnv
 * @returns {{ clientId: string, clientSecret: string }}
 */
export function readGoogleCredentials(processEnv, fileEnv) {
  const pick = (/** @type {string} */ key) => processEnv[key] || fileEnv[key] || '';
  return {
    clientId: pick('BW_DEV_GOOGLE_CLIENT_ID'),
    clientSecret: pick('BW_DEV_GOOGLE_CLIENT_SECRET'),
  };
}

/**
 * The Keycloak origin the browser uses (the redirect URI Google calls must be built from it), without a trailing slash.
 * @param {Record<string, string | undefined>} env
 */
export function publicKeycloakBase(env) {
  const port = env.BW_DEV_KEYCLOAK_PORT || DEFAULT_KEYCLOAK_PORT;
  const base = env.BW_DEV_KEYCLOAK_PUBLIC_URL || `http://localhost:${port}`;
  return base.replace(/\/+$/, '');
}

/** The redirect URI to register in Google Cloud Console (Keycloak's broker endpoint for the `google` alias). */
export function brokerRedirectUri(base) {
  return `${base}/realms/${REALM}/broker/${IDP_ALIAS}/endpoint`;
}

/**
 * The one paragraph printed when the Google client is not configured.
 * @param {string} base
 */
export function missingCredentialsMessage(base) {
  return [
    'Google sign-in is not configured, so nothing was changed in Keycloak. To enable it: create an OAuth client',
    '(type Web application) in Google Cloud Console, set BW_DEV_GOOGLE_CLIENT_ID and BW_DEV_GOOGLE_CLIENT_SECRET in',
    'the repository .env (gitignored), then run `pnpm demo google`. In that client add the Authorised redirect URI',
    `${brokerRedirectUri(base)} and the Authorised JavaScript origin ${base}.`,
    'The demo keeps working with the normal Keycloak sign-in until then.',
  ].join(' ');
}

/**
 * The identity provider representation. Our keys win; anything else already on the live provider is kept by the caller.
 * @param {{ clientId: string, clientSecret: string }} creds
 */
export function identityProviderRepresentation(creds) {
  return {
    alias: IDP_ALIAS,
    displayName: 'Google',
    providerId: 'google',
    enabled: true,
    trustEmail: false,
    storeToken: false,
    addReadTokenRoleOnCreate: false,
    linkOnly: false,
    hideOnLogin: false,
    config: {
      clientId: creds.clientId,
      clientSecret: creds.clientSecret,
      defaultScope: 'openid email profile',
      syncMode: 'IMPORT',
    },
  };
}

/**
 * Demo-only mappers. They run on every Google login (FORCE) so the demo tenant, roles and marker are always set.
 * Mapper types: `hardcoded-attribute-idp-mapper` (user attribute `tenant`, the claim the dev realm maps) and
 * `oidc-hardcoded-role-idp-mapper` (one realm role per mapper).
 * @returns {{ name: string, identityProviderMapper: string, config: Record<string, string> }[]}
 */
export function demoMappers() {
  return [
    {
      name: 'bw-demo-tenant',
      identityProviderMapper: 'hardcoded-attribute-idp-mapper',
      config: { attribute: 'tenant', 'attribute.value': DEMO_TENANT_SLUG, syncMode: 'FORCE' },
    },
    ...[...DEMO_ROLES, DEMO_MARKER_ROLE].map((role) => ({
      name: `bw-demo-role-${role}`,
      identityProviderMapper: 'oidc-hardcoded-role-idp-mapper',
      config: { role, syncMode: 'FORCE' },
    })),
  ];
}

/**
 * Upserts the provider and the demo mappers through the admin REST API. Pure of process state: fetch is injected.
 * @param {{ base: string, creds: { clientId: string, clientSecret: string }, adminUser: string,
 *   adminPassword: string, fetchFn?: typeof fetch, log?: (line: string) => void }} input
 * @returns {Promise<{ created: boolean, mappersChanged: number }>}
 */
export async function syncGoogleIdp(input) {
  const fetchFn = input.fetchFn ?? fetch;
  const log = input.log ?? (() => {});
  const token = await adminToken(input.base, input.adminUser, input.adminPassword, fetchFn);
  const api = async (
    /** @type {string} */ method,
    /** @type {string} */ p,
    /** @type {unknown} */ body,
  ) => {
    const res = await fetchFn(`${input.base}/admin/realms/${REALM}${p}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return res;
  };

  const idpPath = `/identity-provider/instances/${IDP_ALIAS}`;
  const existing = await api('GET', idpPath, undefined);
  let created = false;
  if (existing.status === HTTP_NOT_FOUND) {
    const rep = identityProviderRepresentation(input.creds);
    const res = await api('POST', '/identity-provider/instances', rep);
    if (!res.ok)
      throw new Error(`creating the google identity provider failed: HTTP ${res.status}`);
    created = true;
    log('created the google identity provider');
  } else if (existing.ok) {
    const live = /** @type {Record<string, unknown>} */ (await existing.json());
    const rep = identityProviderRepresentation(input.creds);
    const merged = {
      ...live,
      ...rep,
      config: { .../** @type {object} */ (live.config ?? {}), ...rep.config },
    };
    const res = await api('PUT', idpPath, merged);
    if (!res.ok)
      throw new Error(`updating the google identity provider failed: HTTP ${res.status}`);
    log('updated the google identity provider');
  } else {
    throw new Error(`reading the google identity provider failed: HTTP ${existing.status}`);
  }

  const verify = await api('GET', idpPath, undefined);
  const verified = verify.ok
    ? /** @type {{ providerId?: string, enabled?: boolean }} */ (await verify.json())
    : {};
  if (verified.providerId !== 'google' || verified.enabled !== true) {
    throw new Error('verification failed: the google identity provider is missing or disabled');
  }

  await ensureRealmRole(api, DEMO_MARKER_ROLE);
  const mappersRes = await api('GET', `${idpPath}/mappers`, undefined);
  if (!mappersRes.ok)
    throw new Error(`listing the google mappers failed: HTTP ${mappersRes.status}`);
  const live =
    /** @type {{ id: string, name: string, identityProviderMapper?: string, config?: object }[]} */ (
      await mappersRes.json()
    );
  let mappersChanged = 0;
  for (const want of demoMappers()) {
    const found = live.find((m) => m.name === want.name);
    const rep = { ...want, identityProviderAlias: IDP_ALIAS };
    const res = found
      ? await api('PUT', `${idpPath}/mappers/${found.id}`, { ...rep, id: found.id })
      : await api('POST', `${idpPath}/mappers`, rep);
    if (!res.ok) throw new Error(`writing mapper ${want.name} failed: HTTP ${res.status}`);
    mappersChanged += 1;
  }
  log(`demo mappers in place (${mappersChanged})`);
  return { created, mappersChanged };
}

/**
 * @param {(method: string, p: string, body: unknown) => Promise<Response>} api
 * @param {string} name
 */
async function ensureRealmRole(api, name) {
  const got = await api('GET', `/roles/${name}`, undefined);
  if (got.ok) return;
  if (got.status !== HTTP_NOT_FOUND)
    throw new Error(`reading realm role ${name} failed: HTTP ${got.status}`);
  const res = await api('POST', '/roles', {
    name,
    description: 'Demo only: granted to Google sign-ins (pnpm demo google).',
  });
  if (!res.ok) throw new Error(`creating realm role ${name} failed: HTTP ${res.status}`);
}

/**
 * @param {string} base
 * @param {string} user
 * @param {string} password
 * @param {typeof fetch} fetchFn
 */
async function adminToken(base, user, password, fetchFn) {
  const res = await fetchFn(`${base}/realms/master/protocol/openid-connect/token`, {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'password',
      client_id: 'admin-cli',
      username: user,
      password,
    }),
  });
  if (!res.ok) throw new Error(`admin sign-in to Keycloak failed: HTTP ${res.status}`);
  return /** @type {{ access_token: string }} */ (await res.json()).access_token;
}

/** CLI entry. Returns the process exit code. */
export async function main(argv = process.argv.slice(2), processEnv = process.env) {
  const fileEnv = existsSync(path.join(ROOT, '.env'))
    ? parseEnvText(readFileSync(path.join(ROOT, '.env'), 'utf8'))
    : {};
  const env = {
    ...fileEnv,
    ...Object.fromEntries(Object.entries(processEnv).filter(([, v]) => v)),
  };
  const base = publicKeycloakBase(env);
  const creds = readGoogleCredentials(processEnv, fileEnv);
  if (creds.clientId === '' || creds.clientSecret === '') {
    process.stdout.write(`${missingCredentialsMessage(base)}\n`);
    return 0;
  }
  const port = env.BW_DEV_KEYCLOAK_PORT || DEFAULT_KEYCLOAK_PORT;
  const adminBase = `http://127.0.0.1:${port}`;
  try {
    const result = await syncGoogleIdp({
      base: adminBase,
      creds,
      adminUser: env.BW_DEV_KEYCLOAK_ADMIN_USER ?? '',
      adminPassword: env.BW_DEV_KEYCLOAK_ADMIN_PASSWORD ?? '',
      log: (line) => process.stdout.write(`[google-idp] ${line}\n`),
    });
    process.stdout.write(
      `[google-idp] ready: realm ${REALM}, alias ${IDP_ALIAS}${result.created ? ' (new)' : ''}. ` +
        `Google redirect URI: ${brokerRedirectUri(base)}\n`,
    );
    return 0;
  } catch (error) {
    // Messages carry status codes only; never the secret or the response body.
    process.stderr.write(
      `[google-idp] ERROR: ${error instanceof Error ? error.message : 'unknown error'}\n`,
    );
    return 1;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
