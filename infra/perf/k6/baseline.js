// Baseline k6 script (PERF-001, #320): one authenticated probe of the public liveness route per iteration.
// The profile (PERF_PROFILE=smoke|load|stress|soak) decides the load shape; thresholds are the shared presets.
// Run through the Makefile (`make -C infra/perf smoke`) or `pnpm perf:smoke`. Profile-specific API scripts
// (PERF-002…007) reuse the same lib/ modules.

import { check } from 'k6';
import http from 'k6/http';

import { authHeaders } from '../lib/auth.js';
import { loadConfig } from '../lib/config.js';
import { summaryOutputs } from '../lib/output.js';
import { buildOptions } from '../lib/profiles.js';

const HTTP_OK = 200;

/* global __ENV */
// Throws during init (before any request) when the environment is incomplete.
const config = loadConfig(__ENV);

export const options = buildOptions(config.profile);

export default function () {
  const res = http.get(`${config.baseUrl}/health/live`, {
    headers: authHeaders(config),
    tags: { name: 'health_live' },
  });
  check(res, { 'health/live is 200': (r) => r.status === HTTP_OK });
}

/**
 * @param {unknown} data k6 summary
 * @returns {Record<string, string>} outputs
 */
export function handleSummary(data) {
  return summaryOutputs(data, { scriptName: 'baseline', token: config.token, now: new Date() });
}
