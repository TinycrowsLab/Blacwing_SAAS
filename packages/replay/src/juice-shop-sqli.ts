import { normaliseIp, parseScopeRules, type ScopeRules } from '@blackwing/contracts';
import { ValidationError } from '@blackwing/errors';

import { portOf } from './lab-guard.js';

import type { ErrorSignatureOracle } from './oracle.js';
import type { ReplayPlan } from './replay.js';

/**
 * The pinned demo scenario (#881): SQL injection detection on the Juice Shop product search, verified
 * against the digest-pinned lab image in `infra/compose/docker-compose.dev.yml`. Planner, specialist and
 * validator all bind to the same ids below: the catalogue class `webapi.injection.sql` (WSTG-INPV-05,
 * CWE-89, A03, active_safe), the oracle id, and the endpoint.
 */

/** Catalogue class (packages/domain WEBAPI_CATALOGUE). Stable across planner and specialist configs. */
export const JUICE_SHOP_SQLI_TEST_CASE_ID = 'webapi.injection.sql';
export const JUICE_SHOP_SQLI_ORACLE_ID = 'oracle.webapi.injection.sql.error_signature.v1';
/** The compose image, digest-pinned (v17.1.1). Other Juice Shop builds change the error text, so they are not covered. */
export const JUICE_SHOP_LAB_IMAGE =
  'bkimminich/juice-shop:v17.1.1@sha256:9e437b456e444ff001d1663e4f6f05c796fe02f1058dd2651d6791a15b43dfeb';
/** Default lab origin: the compose target published on loopback only (`BW_TARGET_JUICE_SHOP_PORT`). */
export const JUICE_SHOP_LAB_ORIGIN = 'http://127.0.0.1:13000';
const JUICE_SHOP_SEARCH_PATH = '/rest/products/search';
const JUICE_SHOP_SEARCH_PARAMETER = 'q';
/**
 * Benign detection probe: an ordinary token with one unbalanced quote, which breaks the SQL string literal.
 * It extracts no data. A lone quote is not used because the lab answers it with 200 and an empty result.
 */
export const JUICE_SHOP_SQLI_PROBE = "a'";
/** Negative control: an ordinary search term for the same parameter. */
export const JUICE_SHOP_SQLI_CONTROL = 'apple';
/** Replays needed before a candidate can be confirmed (the issue requires reproduction twice). */
const JUICE_SHOP_SQLI_RUNS = 2;

/**
 * Oracle: the lab answers a broken quote with HTTP 500 and a page containing the SQLite error. Verified
 * against the pinned image: `a'` gives 500 `SQLITE_ERROR: near ...`, and `apple` gives 200 with products.
 */
export const JUICE_SHOP_SQLI_ORACLE: ErrorSignatureOracle = Object.freeze({
  id: JUICE_SHOP_SQLI_ORACLE_ID,
  type: 'error_signature',
  expectedStatus: 500,
  signatures: Object.freeze(['SQLITE_ERROR']),
});

/**
 * The scenario's scope: the lab origin's host and port, minus the application's version endpoint. The same
 * shape as the seeded standing authorisation (`packages/db/src/seed/plan.ts`).
 */
export function juiceShopScopeRules(origin: URL): ScopeRules {
  const host = origin.hostname.replace(/^\[(.*)\]$/, '$1');
  const port = portOf(origin);
  const ip = normaliseIp(host);
  const address = ip === null ? { host } : { cidr: ip };
  return parseScopeRules({
    rules: [
      { effect: 'include', ...address, ports: [port] },
      { effect: 'exclude', ...address, paths: ['/rest/admin/application-version'] },
    ],
  });
}

/** Builds the replay plan for the scenario against `lab`, the lab origin. Throws on a malformed origin. */
export function buildJuiceShopSqliPlan(lab: string = JUICE_SHOP_LAB_ORIGIN): ReplayPlan {
  let origin: URL;
  try {
    origin = new URL(lab);
  } catch {
    throw new ValidationError('the lab origin is not a valid URL');
  }
  const search = (term: string): string => {
    const url = new URL(JUICE_SHOP_SEARCH_PATH, origin);
    url.searchParams.set(JUICE_SHOP_SEARCH_PARAMETER, term);
    return url.toString();
  };
  return {
    testCaseId: JUICE_SHOP_SQLI_TEST_CASE_ID,
    oracle: JUICE_SHOP_SQLI_ORACLE,
    probeUrl: search(JUICE_SHOP_SQLI_PROBE),
    negativeControlUrl: search(JUICE_SHOP_SQLI_CONTROL),
    runs: JUICE_SHOP_SQLI_RUNS,
    scope: juiceShopScopeRules(origin),
    labImage: JUICE_SHOP_LAB_IMAGE,
  };
}
