// Threshold-breach fixture (PERF-001, #320). Deliberately impossible thresholds: k6 must exit non-zero.
// `make -C infra/perf ci-smoke` runs it against the offline target and asserts the failure.

import { check } from 'k6';
import http from 'k6/http';

import { authHeaders } from '../lib/auth.js';
import { loadConfig } from '../lib/config.js';
import { summaryOutputs } from '../lib/output.js';

const HTTP_OK = 200;

/* global __ENV */
// Throws during init (before any request) when the environment is incomplete.
const config = loadConfig(__ENV);

export const options = {
  vus: 1,
  iterations: 5,
  discardResponseBodies: true,
  // A 0.001 ms p95 cannot be met by any real request, so the run must breach.
  thresholds: { http_req_duration: ['p(95)<0.001'] },
};

export default function () {
  const res = http.get(`${config.baseUrl}/health/live`, { headers: authHeaders(config) });
  check(res, { 'health/live is 200': (r) => r.status === HTTP_OK });
}

/**
 * @param {unknown} data k6 summary
 * @returns {Record<string, string>} outputs
 */
export function handleSummary(data) {
  return summaryOutputs(data, {
    scriptName: 'threshold-breach',
    token: config.token,
    now: new Date(),
  });
}
