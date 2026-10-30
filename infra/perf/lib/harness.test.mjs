// Unit self-tests for the k6 harness lib (PERF-001, #320). Run with `pnpm test:scripts` or `make -C infra/perf unit`.
// They exercise the pure modules that k6 scripts import, plus the offline target fixture.

import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';

import { authHeaders, redact } from './auth.js';
import { DEFAULT_BASE_URL, loadConfig } from './config.js';
import { BODY_SAMPLE_LIMIT, capBody, fileTimestamp, summaryOutputs } from './output.js';
import { buildOptions, PROFILES, scenarioFor } from './profiles.js';
import { presetThresholds } from './thresholds.js';
import { createTarget } from '../fixtures/target.mjs';

const TOKEN = 'bw_pat_0123456789abcdefGHIJ';

/**
 * @param {() => unknown} fn
 * @returns {string} the message thrown by fn, or '' when it does not throw
 */
function errorMessage(fn) {
  try {
    fn();
  } catch (err) {
    return err instanceof Error ? err.message : '';
  }
  return '';
}
const TENANT = '0190f2a4-7c1d-7e3a-9b1f-2d3c4e5f6a7b';

test('threshold presets match the issue contract and are fresh per call', () => {
  assert.deepEqual(presetThresholds(), {
    http_req_duration: ['p(95)<800', 'p(99)<1500'],
    http_req_failed: ['rate<0.01'],
    checks: ['rate>0.99'],
  });
  const first = presetThresholds();
  first.checks.push('rate>0');
  assert.deepEqual(presetThresholds().checks, ['rate>0.99']);
});

test('each profile maps to its documented load shape', () => {
  assert.deepEqual(scenarioFor('smoke'), { executor: 'constant-vus', vus: 1, duration: '30s' });
  assert.deepEqual(scenarioFor('load'), {
    executor: 'ramping-vus',
    startVUs: 0,
    stages: [{ duration: '5m', target: 50 }],
  });
  assert.deepEqual(scenarioFor('stress'), {
    executor: 'ramping-vus',
    startVUs: 0,
    stages: [{ duration: '5m', target: 300 }],
  });
  assert.deepEqual(scenarioFor('soak'), { executor: 'constant-vus', vus: 20, duration: '1h' });
  assert.deepEqual(PROFILES, ['smoke', 'load', 'stress', 'soak']);
});

test('buildOptions wires the scenario, the presets and discarded bodies', () => {
  const options = buildOptions('soak');
  assert.deepEqual(Object.keys(options.scenarios), ['main']);
  assert.deepEqual(options.scenarios.main, scenarioFor('soak'));
  assert.deepEqual(options.thresholds, presetThresholds());
  assert.equal(options.discardResponseBodies, true);
});

test('an unknown profile is rejected by scenarioFor and buildOptions', () => {
  assert.throws(() => scenarioFor('spike'), /unknown PERF_PROFILE "spike"/);
  assert.throws(() => buildOptions('chaos'), /unknown PERF_PROFILE/);
});

test('loadConfig defaults to localhost and the smoke profile', () => {
  const config = loadConfig({ PERF_TOKEN: TOKEN });
  assert.equal(config.baseUrl, DEFAULT_BASE_URL);
  assert.equal(DEFAULT_BASE_URL, 'http://localhost:3000');
  assert.equal(config.profile, 'smoke');
  assert.equal(config.tenantId, undefined);
  assert.equal(config.token, TOKEN);
});

test('loadConfig fails fast without a token and never echoes a rejected token', () => {
  assert.throws(() => loadConfig({}), /PERF_TOKEN is required/);
  assert.throws(() => loadConfig({ PERF_TOKEN: '' }), /PERF_TOKEN is required/);
  const secret = 'not-a-bw-token-supersecret';
  const message = errorMessage(() => loadConfig({ PERF_TOKEN: secret }));
  assert.match(message, /not a bw_pat_ or bw_ci_ token/);
  assert.ok(!message.includes(secret));
});

test('loadConfig accepts only absolute http(s) base URLs and strips trailing slashes', () => {
  assert.equal(
    loadConfig({ PERF_TOKEN: TOKEN, PERF_BASE_URL: 'https://api.example.test/' }).baseUrl,
    'https://api.example.test',
  );
  for (const bad of ['ftp://x.test', 'file:///etc/passwd', 'localhost:3000', 'http://']) {
    assert.throws(
      () => loadConfig({ PERF_TOKEN: TOKEN, PERF_BASE_URL: bad }),
      /PERF_BASE_URL must be an absolute/,
    );
  }
});

test('loadConfig validates the optional tenant as a UUID', () => {
  assert.equal(loadConfig({ PERF_TOKEN: TOKEN, PERF_TENANT_ID: TENANT }).tenantId, TENANT);
  assert.throws(
    () => loadConfig({ PERF_TOKEN: TOKEN, PERF_TENANT_ID: 'acme' }),
    /PERF_TENANT_ID must be a UUID/,
  );
});

test('loadConfig rejects unknown profiles and accepts the four known ones', () => {
  for (const profile of PROFILES) {
    assert.equal(loadConfig({ PERF_TOKEN: TOKEN, PERF_PROFILE: profile }).profile, profile);
  }
  assert.throws(
    () => loadConfig({ PERF_TOKEN: TOKEN, PERF_PROFILE: 'spike' }),
    /PERF_PROFILE must be one of/,
  );
});

test('loadConfig returns a frozen object', () => {
  assert.throws(() => {
    loadConfig({ PERF_TOKEN: TOKEN }).baseUrl = 'https://evil.test';
  }, TypeError);
});

test('authHeaders injects the Bearer token and X-Tenant only when pinned', () => {
  assert.deepEqual(authHeaders({ token: TOKEN, tenantId: undefined }), {
    Authorization: `Bearer ${TOKEN}`,
    Accept: 'application/json',
  });
  assert.equal(authHeaders({ token: TOKEN, tenantId: TENANT })['X-Tenant'], TENANT);
});

test('redact removes every token occurrence and is a no-op for an empty token', () => {
  assert.equal(redact(`a ${TOKEN} b ${TOKEN}`, TOKEN), 'a [redacted] b [redacted]');
  assert.equal(redact('unchanged', ''), 'unchanged');
});

test('capBody caps by code points, is surrogate-pair safe and bounds huge input', () => {
  assert.equal(capBody(undefined), '');
  assert.equal(capBody(null), '');
  assert.equal(capBody('short'), 'short');
  const long = 'x'.repeat(BODY_SAMPLE_LIMIT + 1);
  assert.equal(capBody(long), `${'x'.repeat(BODY_SAMPLE_LIMIT)}…`);
  const emoji = '😀'.repeat(BODY_SAMPLE_LIMIT + 10);
  assert.equal(capBody(emoji), `${'😀'.repeat(BODY_SAMPLE_LIMIT)}…`);
  assert.equal(capBody('😀'.repeat(BODY_SAMPLE_LIMIT)), '😀'.repeat(BODY_SAMPLE_LIMIT));
  const huge = 'y'.repeat(5_000_000);
  assert.equal(capBody(huge).length, BODY_SAMPLE_LIMIT + 1);
});

test('fileTimestamp is ISO-8601 UTC with colons replaced for filenames', () => {
  assert.equal(fileTimestamp(new Date('2026-10-30T13:04:05.000Z')), '2026-10-30T13-04-05.000Z');
});

test('summaryOutputs writes a per-run JSON file, a stdout pointer and no token', () => {
  const now = new Date('2026-10-30T13:04:05.000Z');
  const out = summaryOutputs(
    { metrics: { note: `leaked ${TOKEN}` } },
    { scriptName: 'baseline', token: TOKEN, now },
  );
  const file = 'infra/perf/results/baseline-2026-10-30T13-04-05.000Z.json';
  assert.deepEqual(Object.keys(out).sort(), [file, 'stdout']);
  assert.equal(out.stdout, `results written to ${file}\n`);
  const body = out[file] ?? '';
  assert.ok(!body.includes(TOKEN));
  assert.ok(body.includes('[redacted]'));
  assert.doesNotThrow(() => JSON.parse(body));
  assert.ok(body.includes('"note": "leaked [redacted]"'));
});

test('the offline target answers 200 only for the exact Bearer token', async () => {
  const server = createTarget({ token: TOKEN }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  const base = `http://127.0.0.1:${port}`;
  try {
    const ok = await fetch(`${base}/health/live`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(ok.status, 200);
    const wrong = await fetch(`${base}/health/live`, {
      headers: { Authorization: 'Bearer bw_pat_wrongwrongwrongwrong' },
    });
    assert.equal(wrong.status, 401);
    const missing = await fetch(`${base}/health/live`);
    assert.equal(missing.status, 401);
    const other = await fetch(`${base}/v1/anything`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(other.status, 404);
  } finally {
    server.close();
    await once(server, 'close');
  }
});
