#!/usr/bin/env node
// Smoke test for the Keycloak dev realm (DEVENV-004, #158), against the running compose stack.
//
//   node scripts/keycloak-smoke.mjs [--env-file .env] [--project bwdev] [--override f.yml] [--restart]
//
// Plays the console BFF: for every test user it runs a real OIDC Authorization Code + PKCE (S256)
// login against the BFF redirect URI (submitting Keycloak's login form, no browser), exchanges the
// code with the BFF client secret and asserts the token claims:
//   - realm roles per persona; the `acme` tenant claim; `bw-api` in the audience;
//   - the Platform Operator has no tenant role and no tenant claim (§1.2, §8.4);
//   - no MFA prompt in dev; PKCE is mandatory; unregistered redirect URIs and password grants are refused;
//   - the CI service account gets a client-credentials token with `ci-pipeline` + tenant;
//   - token `iat` is within the clock-skew budget of the host clock.
// `--restart` also restarts Keycloak and asserts the existing realm is skipped, not re-imported.
// Exits non-zero on the first failed check. Never prints passwords, secrets or tokens.

import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  API_CLIENT,
  BFF_CALLBACK_PATH,
  BFF_CLIENT,
  CI_CLIENT,
  CONSOLE_ORIGINS,
  PLATFORM_ROLES,
  REALM,
  TENANT,
  TENANT_ROLES,
  TEST_USERS,
} from './keycloak-realm.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COMPOSE_FILE = path.join(ROOT, 'infra/compose/docker-compose.dev.yml');
/** Max tolerated |token iat - host clock| before token validation becomes flaky. */
export const MAX_CLOCK_SKEW_S = 60;
const HTTP_OK = 200;
const HTTP_FOUND = 302;
const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;
const MS_PER_S = 1000;
/** RFC 7636 recommends 32 random octets for the verifier. */
const PKCE_VERIFIER_BYTES = 32;
const NONCE_BYTES = 12;

/** Env value, or `fallback` when unset or empty. @param {string | undefined} v @param {string} fallback */
const envOr = (v, fallback) => (v === undefined || v === '' ? fallback : v);

/**
 * @typedef {{ envFile: string, project: string, override: string | undefined, restart: boolean }} Opts
 * @param {string[]} argv @returns {Opts}
 */
export function parseArgs(argv) {
  /** @type {Opts} */
  const opts = {
    envFile: path.join(ROOT, '.env'),
    project: 'bwdev',
    override: undefined,
    restart: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--restart') opts.restart = true;
    else if (arg === '--env-file' && next) {
      opts.envFile = path.resolve(next);
      i += 1;
    } else if (arg === '--project' && next) {
      opts.project = next;
      i += 1;
    } else if (arg === '--override' && next) {
      opts.override = path.resolve(next);
      i += 1;
    } else throw new Error(`unknown or incomplete argument: ${String(arg)}`);
  }
  return opts;
}

/** Parses KEY=value lines (no interpolation). @param {string} text @returns {Record<string, string>} */
export function parseEnv(text) {
  /** @type {Record<string, string>} */
  const env = {};
  for (const line of text.split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (m?.[1]) env[m[1]] = m[2] ?? '';
  }
  return env;
}

/** PKCE pair (RFC 7636, S256). @returns {{ verifier: string, challenge: string }} */
export function pkcePair() {
  const verifier = randomBytes(PKCE_VERIFIER_BYTES).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

/** Decodes a JWT payload without verifying it (claims inspection only). @param {string} jwt */
export function jwtClaims(jwt) {
  const part = jwt.split('.')[1];
  if (!part) throw new Error('malformed JWT');
  /** @type {unknown} */
  const claims = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  if (typeof claims !== 'object' || claims === null || Array.isArray(claims))
    throw new Error('JWT payload is not an object');
  return /** @type {Record<string, unknown>} */ (claims);
}

/** Minimal cookie jar for Keycloak's login-form round trip. */
class Jar {
  /** @type {Map<string, string>} */
  #c = new Map();
  /** @param {Response} res */
  take(res) {
    for (const sc of res.headers.getSetCookie()) {
      const [pair = ''] = sc.split(';');
      const eq = pair.indexOf('=');
      if (eq > 0) this.#c.set(pair.slice(0, eq).trim(), pair.slice(eq + 1));
    }
  }
  header() {
    return [...this.#c].map(([k, v]) => `${k}=${v}`).join('; ');
  }
}

/** @param {string} html */
function formAction(html) {
  const m = /<form[^>]*id="kc-form-login"[^>]*action="([^"]+)"/.exec(html);
  return m?.[1]?.replaceAll('&amp;', '&');
}

/**
 * Starts an authorization request and returns Keycloak's login page (or its redirect/error).
 * @param {string} issuer @param {Record<string, string>} params
 */
async function authorize(issuer, params) {
  const jar = new Jar();
  const url = `${issuer}/protocol/openid-connect/auth?${new URLSearchParams(params).toString()}`;
  const res = await fetch(url, { redirect: 'manual' });
  jar.take(res);
  return { res, jar, html: await res.text() };
}

/**
 * Full Auth Code + PKCE login as the BFF. Returns the token response (never logged).
 * @param {{ issuer: string, redirectUri: string, secret: string, username: string, password: string }} a
 */
export async function pkceLogin(a) {
  const { verifier, challenge } = pkcePair();
  const state = randomBytes(NONCE_BYTES).toString('hex');
  const { res, jar, html } = await authorize(a.issuer, {
    client_id: BFF_CLIENT,
    response_type: 'code',
    scope: 'openid',
    redirect_uri: a.redirectUri,
    state,
    nonce: randomBytes(NONCE_BYTES).toString('hex'),
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  if (res.status !== HTTP_OK) throw new Error(`auth endpoint returned ${String(res.status)}`);
  const action = formAction(html);
  if (!action) throw new Error('login form not found');
  const login = await fetch(action, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: jar.header() },
    body: new URLSearchParams({ username: a.username, password: a.password, credentialId: '' }),
  });
  const location = login.headers.get('location') ?? '';
  if (login.status !== HTTP_FOUND || !location.startsWith(`${a.redirectUri}?`)) {
    const body = await login.text();
    const otp = /otp|totp|authenticator/i.test(body);
    throw new Error(
      `login did not redirect to the BFF (${String(login.status)}${otp ? ', MFA prompt' : ''})`,
    );
  }
  const cb = new URL(location);
  if (cb.searchParams.get('state') !== state) throw new Error('state mismatch');
  const code = cb.searchParams.get('code');
  if (!code) throw new Error('no authorization code');
  const tok = await fetch(`${a.issuer}/protocol/openid-connect/token`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      authorization: `Basic ${Buffer.from(`${BFF_CLIENT}:${a.secret}`).toString('base64')}`,
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: a.redirectUri,
      code_verifier: verifier,
    }),
  });
  if (tok.status !== HTTP_OK) throw new Error(`code exchange failed (${String(tok.status)})`);
  return /** @type {{ access_token: string, id_token: string }} */ (await tok.json());
}

/** @param {Record<string, unknown>} claims @returns {string[]} */
const realmRoles = (claims) => {
  const ra = claims.realm_access;
  const roles = typeof ra === 'object' && ra !== null && 'roles' in ra ? ra.roles : [];
  return Array.isArray(roles) ? roles.map(String) : [];
};
/** @param {Record<string, unknown>} claims @returns {string[]} */
const audience = (claims) =>
  Array.isArray(claims.aud) ? claims.aud.map(String) : [String(claims.aud)];

/** @param {Opts} opts @param {string[]} args */
function compose(opts, args) {
  const files = ['-f', COMPOSE_FILE, ...(opts.override ? ['-f', opts.override] : [])];
  return execFileSync(
    'docker',
    ['compose', '-p', opts.project, '--env-file', opts.envFile, ...files, ...args],
    {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
}

/** @param {Opts} opts @returns {Promise<string[]>} */
export async function smoke(opts) {
  /** @type {string[]} */
  const passed = [];
  const check = (/** @type {string} */ name, /** @type {boolean} */ ok) => {
    if (!ok) throw new Error(`FAIL: ${name}`);
    passed.push(name);
    process.stdout.write(`ok - ${name}\n`);
  };
  const env = parseEnv(readFileSync(opts.envFile, 'utf8'));
  const base = envOr(
    env.BW_DEV_KEYCLOAK_PUBLIC_URL,
    `http://localhost:${envOr(env.BW_DEV_KEYCLOAK_PORT, '18080')}`,
  );
  const issuer = `${base}/realms/${REALM}`;
  const password = env.BW_DEV_KEYCLOAK_TEST_USER_PASSWORD ?? '';
  const bffSecret = env.BW_DEV_KEYCLOAK_BFF_SECRET ?? '';
  const [origin = ''] = CONSOLE_ORIGINS;
  const redirectUri = `${origin}${BFF_CALLBACK_PATH}`;

  if (opts.restart) {
    const since = new Date().toISOString();
    compose(opts, ['restart', 'keycloak']);
    compose(opts, ['up', '-d', '--wait', '--wait-timeout', '300', 'keycloak']);
    const logs = compose(opts, ['logs', '--since', since, 'keycloak']);
    check(
      'restart on an existing DB skips the realm import (idempotent)',
      logs.includes('already exists. Import skipped'),
    );
  }

  const disc = await fetch(`${issuer}/.well-known/openid-configuration`);
  const meta = /** @type {{ issuer?: string, code_challenge_methods_supported?: string[] }} */ (
    await disc.json()
  );
  check(
    `realm ${REALM} is imported and serves OIDC discovery`,
    disc.status === HTTP_OK && meta.issuer === issuer,
  );
  check('S256 PKCE is supported', (meta.code_challenge_methods_supported ?? []).includes('S256'));

  for (const [username, role] of Object.entries(TEST_USERS)) {
    const tokens = await pkceLogin({ issuer, redirectUri, secret: bffSecret, username, password });
    const at = jwtClaims(tokens.access_token);
    const roles = realmRoles(at);
    check(`${username}: Auth Code + PKCE login via the BFF redirect URI, no MFA prompt`, true);
    check(`${username}: access token carries realm role ${role}`, roles.includes(role));
    check(`${username}: token audience includes ${API_CLIENT}`, audience(at).includes(API_CLIENT));
    check(`${username}: issuer is ${issuer}`, at.iss === issuer);
    const iat = Number(at.iat);
    check(
      `${username}: token iat within ${String(MAX_CLOCK_SKEW_S)}s of host clock`,
      Math.abs(iat - Date.now() / MS_PER_S) <= MAX_CLOCK_SKEW_S,
    );
    if (PLATFORM_ROLES.includes(role)) {
      check(
        `${username}: platform operator has no tenant roles`,
        !roles.some((r) => TENANT_ROLES.includes(r)),
      );
      check(`${username}: platform operator has no tenant claim`, at.tenant === undefined);
    } else {
      check(`${username}: access token tenant claim is ${TENANT}`, at.tenant === TENANT);
      check(
        `${username}: id token tenant claim is ${TENANT}`,
        jwtClaims(tokens.id_token).tenant === TENANT,
      );
      check(`${username}: no platform roles`, !roles.some((r) => PLATFORM_ROLES.includes(r)));
    }
  }

  const noPkce = await authorize(issuer, {
    client_id: BFF_CLIENT,
    response_type: 'code',
    scope: 'openid',
    redirect_uri: redirectUri,
    state: 's',
  });
  const noPkceLoc = noPkce.res.headers.get('location') ?? '';
  check(
    'authorization request without PKCE is refused',
    noPkce.res.status === HTTP_FOUND && noPkceLoc.includes('error=invalid_request'),
  );

  const { challenge } = pkcePair();
  const bad = await authorize(issuer, {
    client_id: BFF_CLIENT,
    response_type: 'code',
    scope: 'openid',
    redirect_uri: 'https://evil.bw.localhost.example/auth/callback',
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  check(
    'unregistered redirect URI is refused',
    bad.res.status === HTTP_BAD_REQUEST && /redirect_uri/i.test(bad.html),
  );

  const tokenUrl = `${issuer}/protocol/openid-connect/token`;
  /** @param {string} id @param {string} secret @param {Record<string, string>} body */
  const grant = (id, secret, body) =>
    fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`,
      },
      body: new URLSearchParams(body),
    });
  const [firstUser = ''] = Object.keys(TEST_USERS);
  const direct = await grant(BFF_CLIENT, bffSecret, {
    grant_type: 'password',
    username: firstUser,
    password,
  });
  check('password grant on the BFF client is refused', direct.status >= HTTP_BAD_REQUEST);

  const ci = await grant(CI_CLIENT, env.BW_DEV_KEYCLOAK_CI_SECRET ?? '', {
    grant_type: 'client_credentials',
  });
  check('CI service account obtains a client-credentials token', ci.status === HTTP_OK);
  const ciAt = jwtClaims(/** @type {{ access_token: string }} */ (await ci.json()).access_token);
  check(
    'CI token carries ci-pipeline, tenant acme and the bw-api audience',
    realmRoles(ciAt).includes('ci-pipeline') &&
      ciAt.tenant === TENANT &&
      audience(ciAt).includes(API_CLIENT),
  );
  const ciWrong = await grant(CI_CLIENT, 'wrong-secret', { grant_type: 'client_credentials' });
  check('CI client with a wrong secret is refused', ciWrong.status === HTTP_UNAUTHORIZED);

  const admin = await fetch(`${base}/realms/master/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'password',
      client_id: 'admin-cli',
      username: envOr(env.BW_DEV_KEYCLOAK_ADMIN_USER, 'bw_kc_admin'),
      password: env.BW_DEV_KEYCLOAK_ADMIN_PASSWORD ?? '',
    }),
  });
  check('bootstrap admin can sign in to the master realm', admin.status === HTTP_OK);
  const adminToken = /** @type {{ access_token: string }} */ (await admin.json()).access_token;
  const ra = await fetch(`${base}/admin/realms/${REALM}/authentication/required-actions`, {
    headers: { authorization: `Bearer ${adminToken}` },
  });
  const actions = /** @type {{ alias: string, defaultAction: boolean }[]} */ (await ra.json());
  check(
    'MFA is not mandatory in dev (no default required action)',
    ra.status === HTTP_OK && actions.every((a) => !a.defaultAction),
  );
  return passed;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const passed = await smoke(parseArgs(process.argv.slice(2)));
    process.stdout.write(`\n${String(passed.length)} checks passed\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
