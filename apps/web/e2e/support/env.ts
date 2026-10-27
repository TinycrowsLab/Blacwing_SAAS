// Settings of the Playwright e2e suite (CI-006, #140), resolved from the repository `.env` that
// `pnpm dev:deps` writes, with the process environment on top (compose precedence).
//
// Fail closed: every URL the suite drives must be a plain loopback address. The suite only ever talks
// to the local dev stack and the local Juice Shop lab target, never to anything reachable off the host
// (CLAUDE.md "Never do"; CONTEXT_PACK §8). No secret value is ever part of an error message.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

/** Realm the dev Keycloak imports (infra/compose/keycloak/realm-export.json). */
const DEV_REALM = 'blackwing-dev';
/** Seeded `owner` of the demo tenant `acme` (DEVENV-011). */
export const DEFAULT_TEST_USER = 'owner@acme.test';

const DEFAULTS = Object.freeze({
  BW_TARGET_JUICE_SHOP_URL: 'http://127.0.0.1:13000',
  BW_DEV_KEYCLOAK_PUBLIC_URL: 'http://localhost:18080',
  BW_WEB_URL: 'http://127.0.0.1:3000',
});

export interface E2eSettings {
  /** The Juice Shop lab target, also the seeded demo asset (`.env.example` contract). */
  readonly targetUrl: URL;
  /** Keycloak as the browser reaches it (issuer host). */
  readonly keycloakUrl: URL;
  /** The web console (`pnpm dev` serves apps/web here). */
  readonly webUrl: URL;
  readonly realm: string;
  readonly testUser: string;
  /** Dev-only password of the seeded Keycloak test users; `undefined` when `.env` has none. */
  readonly testPassword: string | undefined;
}

export class E2eConfigError extends Error {
  override readonly name = 'E2eConfigError';
}

const LOOPBACK_NAMES = new Set(['localhost', '[::1]']);
const IPV4_OCTETS = 4;
const OCTET_MAX = 255;

/** True for `localhost`, `*.localhost` (RFC 6761), 127.0.0.0/8 and `[::1]`. */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (LOOPBACK_NAMES.has(host) || host.endsWith('.localhost')) return true;
  const octets = host.split('.');
  return (
    octets.length === IPV4_OCTETS &&
    octets[0] === '127' &&
    octets.every((o) => /^\d{1,3}$/.test(o) && Number(o) <= OCTET_MAX)
  );
}

/**
 * Parses `raw` as an http(s) URL on a loopback host; anything else throws (fail closed).
 * @param key setting name, for the error message only
 */
export function requireLoopbackUrl(key: string, raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new E2eConfigError(`${key} is not a valid URL`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new E2eConfigError(`${key} must use http or https, got ${url.protocol}`);
  }
  if (url.username !== '' || url.password !== '') {
    throw new E2eConfigError(`${key} must not carry credentials`);
  }
  if (!isLoopbackHost(url.hostname)) {
    throw new E2eConfigError(
      `${key} must point at a loopback host (the local dev stack), got ${url.hostname}`,
    );
  }
  return url;
}

type EnvMap = Readonly<Record<string, string | undefined>>;

/** Reads a dotenv file; a missing file is an empty map (CI may pass everything through env). */
export function readEnvFile(file: string): Record<string, string> {
  if (!existsSync(file)) return {};
  return parseEnv(readFileSync(file, 'utf8')) as Record<string, string>;
}

function pick(env: EnvMap, key: keyof typeof DEFAULTS): string {
  const value = env[key];
  return value === undefined || value === '' ? DEFAULTS[key] : value;
}

/**
 * Resolves the suite settings. `processEnv` wins over `fileEnv`, as with docker compose.
 * @param fileEnv values from the repository `.env`
 * @param processEnv the process environment
 */
export function resolveE2eSettings(fileEnv: EnvMap, processEnv: EnvMap): E2eSettings {
  const env: EnvMap = { ...fileEnv, ...processEnv };
  const password = env.BW_DEV_KEYCLOAK_TEST_USER_PASSWORD;
  const user = env.BW_E2E_TEST_USER;
  return {
    targetUrl: requireLoopbackUrl(
      'BW_TARGET_JUICE_SHOP_URL',
      pick(env, 'BW_TARGET_JUICE_SHOP_URL'),
    ),
    keycloakUrl: requireLoopbackUrl(
      'BW_DEV_KEYCLOAK_PUBLIC_URL',
      pick(env, 'BW_DEV_KEYCLOAK_PUBLIC_URL'),
    ),
    webUrl: requireLoopbackUrl('BW_WEB_URL', pick(env, 'BW_WEB_URL')),
    realm: DEV_REALM,
    testUser: user === undefined || user === '' ? DEFAULT_TEST_USER : user,
    testPassword: password === undefined || password === '' ? undefined : password,
  };
}

/** Returns the test-user password, or throws a message naming the missing key (never a value). */
export function requireTestPassword(settings: E2eSettings): string {
  if (settings.testPassword === undefined) {
    throw new E2eConfigError(
      'BW_DEV_KEYCLOAK_TEST_USER_PASSWORD is empty: run `pnpm dev:deps` to generate .env',
    );
  }
  return settings.testPassword;
}

const ENV_FILE = new URL('../../../../.env', import.meta.url);

/** Settings for this checkout: repository `.env` plus the process environment. */
export function loadE2eSettings(): E2eSettings {
  return resolveE2eSettings(readEnvFile(fileURLToPath(ENV_FILE)), process.env);
}
