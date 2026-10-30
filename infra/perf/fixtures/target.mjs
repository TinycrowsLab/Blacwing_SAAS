// Offline stand-in for the API's public liveness route, used by `make -C infra/perf ci-smoke` (PERF-001, #320).
// It answers 200 only for the exact Bearer token it was created with, so a passing smoke run proves the auth
// helper injected the token. It never logs the token.

import http from 'node:http';

const OK = 200;
const UNAUTHORIZED = 401;
const NOT_FOUND = 404;

/**
 * @param {{ token: string }} opts the Bearer token the target accepts
 * @returns {import('node:http').Server}
 */
export function createTarget({ token }) {
  return http.createServer((req, res) => {
    if (req.url !== '/health/live') {
      res.writeHead(NOT_FOUND, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'not_found' }));
      return;
    }
    const authorised = req.headers.authorization === `Bearer ${token}`;
    res.writeHead(authorised ? OK : UNAUTHORIZED, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: authorised ? 'ok' : 'unauthorized' }));
  });
}
