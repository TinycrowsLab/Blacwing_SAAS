// Environment parsing for the k6 harness (PERF-001, #320).
//
// k6 has no process.env: every script passes its own `__ENV` into loadConfig(). Keeping the parser a pure
// function lets the Node self-tests (lib/harness.test.mjs) exercise it without k6.

import { PROFILES } from './profiles.js';

export const DEFAULT_BASE_URL = 'http://localhost:3000';

// CONTEXT_PACK §9: `Authorization: Bearer bw_pat_…` or `bw_ci_…`.
const TOKEN_PATTERN = /^bw_(pat|ci)_[A-Za-z0-9_-]{16,}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HTTP_URL_PATTERN = /^https?:\/\/[^\s/?#]+(\/[^\s?#]*)?$/;

/**
 * Parses and validates the harness environment. Throws with a clear message on any problem, so k6 aborts
 * before the first request. Error messages never echo the token.
 *
 * @param {Record<string, string | undefined>} env the k6 `__ENV` object (or a fixture in tests)
 * @returns {{ baseUrl: string, token: string, tenantId: string | undefined, profile: string }}
 */
export function loadConfig(env) {
  const rawUrl =
    env.PERF_BASE_URL === undefined || env.PERF_BASE_URL === ''
      ? DEFAULT_BASE_URL
      : env.PERF_BASE_URL;
  if (!HTTP_URL_PATTERN.test(rawUrl)) {
    throw new Error(`PERF_BASE_URL must be an absolute http(s) URL, got "${rawUrl}"`);
  }

  const token = env.PERF_TOKEN;
  if (token === undefined || token === '') {
    throw new Error('PERF_TOKEN is required (a bw_pat_ or bw_ci_ API token); no run was started');
  }
  if (!TOKEN_PATTERN.test(token)) {
    throw new Error('PERF_TOKEN is not a bw_pat_ or bw_ci_ token; the value was not printed');
  }

  const tenantId =
    env.PERF_TENANT_ID === undefined || env.PERF_TENANT_ID === '' ? undefined : env.PERF_TENANT_ID;
  if (tenantId !== undefined && !UUID_PATTERN.test(tenantId)) {
    throw new Error('PERF_TENANT_ID must be a UUID');
  }

  const profile =
    env.PERF_PROFILE === undefined || env.PERF_PROFILE === '' ? 'smoke' : env.PERF_PROFILE;
  if (!PROFILES.includes(profile)) {
    throw new Error(`PERF_PROFILE must be one of ${PROFILES.join('|')}, got "${profile}"`);
  }

  return Object.freeze({ baseUrl: rawUrl.replace(/\/+$/, ''), token, tenantId, profile });
}
