#!/usr/bin/env node
// Local health summary of the dev stack (DEVENV-010, #164): `pnpm dev:doctor`. `pnpm dev` runs it first.
//
//   node scripts/dev-doctor.mjs
//
// Prints (1) `.env` keys missing or empty versus `.env.example` (DEVENV-003 check-env), (2) the health of
// every dependency and bootstrap job, (3) the loopback endpoints. Key NAMES and URLs only: no value from
// `.env` is ever printed (CONTEXT_PACK §8.7). Exit 0 when everything is healthy and `.env` is complete,
// 1 otherwise (with the fix to run), 2 when Docker is unreachable.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { diffEnv } from './check-env.mjs';
import { CORE_SERVICES, DOCKER_HINT } from './dev-orchestrate.mjs';
import { classify, composeRunner, formatTable, parseComposePs } from './wait-for-health.mjs';

const LABEL_WIDTH = 14;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Long-running services that must be healthy, and bootstrap jobs that must have completed. */
export const DOCTOR_SERVICES = Object.freeze([...CORE_SERVICES, 'keycloak']);
export const DOCTOR_ONE_SHOTS = Object.freeze(['minio-init', 'temporal-bootstrap', 'keycloak-db']);

/** [label, port env var, default port, scheme]; overridable through `.env` like compose. */
export const ENDPOINTS = Object.freeze(
  /** @type {const} */ ([
    ['postgres', 'BW_DEV_POSTGRES_PORT', '15432', 'postgres'],
    ['valkey', 'BW_DEV_VALKEY_PORT', '16379', 'redis'],
    ['neo4j browser', 'BW_DEV_NEO4J_HTTP_PORT', '17474', 'http'],
    ['neo4j bolt', 'BW_DEV_NEO4J_BOLT_PORT', '17687', 'bolt'],
    ['keycloak', 'BW_DEV_KEYCLOAK_PORT', '18080', 'http'],
    ['openbao', 'BW_DEV_OPENBAO_PORT', '18200', 'http'],
    ['minio api', 'BW_DEV_MINIO_PORT', '19000', 'http'],
    ['minio console', 'BW_DEV_MINIO_CONSOLE_PORT', '19001', 'http'],
    ['temporal', 'BW_DEV_TEMPORAL_PORT', '17233', 'grpc'],
    ['temporal ui', 'BW_DEV_TEMPORAL_UI_PORT', '18233', 'http'],
    ['mailpit smtp', 'BW_DEV_MAILPIT_SMTP_PORT', '11025', 'smtp'],
    ['mailpit ui', 'BW_DEV_MAILPIT_UI_PORT', '18025', 'http'],
    ['interactsh', 'BW_DEV_INTERACTSH_HTTP_PORT', '18081', 'http'],
  ]),
);

/**
 * @param {Record<string, string | undefined>} env
 * @returns {string[]}
 */
export function endpointLines(env) {
  return ENDPOINTS.map(([label, key, dflt, scheme]) => {
    const port = /^\d+$/.test(env[key] ?? '') ? String(env[key]) : dflt;
    return `  ${label.padEnd(LABEL_WIDTH)} ${scheme}://127.0.0.1:${port}`;
  });
}

/**
 * @param {{
 *   example: string,
 *   envText: string | undefined,
 *   ps: () => { status: number | null, stdout: string },
 *   dockerUp?: () => boolean,
 *   env?: Record<string, string | undefined>,
 *   out?: (s: string) => void,
 *   err?: (s: string) => void,
 * }} io
 * @returns {number}
 */
export function doctor(io) {
  const out = io.out ?? ((s) => process.stdout.write(s));
  const err = io.err ?? ((s) => process.stderr.write(s));
  let ok = true;

  out('== .env ==\n');
  if (io.envText === undefined) {
    err('  missing .env: run `pnpm dev:deps` (it creates .env from .env.example)\n');
    ok = false;
  } else {
    const { missing, empty } = diffEnv(io.example, io.envText);
    if (missing.length > 0) err(`  warning: missing .env keys: ${missing.join(', ')}\n`);
    if (empty.length > 0) err(`  warning: empty .env keys: ${empty.join(', ')}\n`);
    if (missing.length + empty.length > 0) {
      err('  add them from .env.example (`pnpm dev:deps` fills generated passwords)\n');
      ok = false;
    } else out('  ok\n');
  }

  out('== services ==\n');
  const ps = io.ps();
  if (ps.status !== 0 && !(io.dockerUp?.() ?? false)) {
    err(`  Docker is not reachable. ${DOCKER_HINT}\n`);
    return 2;
  }
  if (ps.status !== 0) err('  docker compose ps failed (is .env complete?)\n');
  const entries = ps.status === 0 ? parseComposePs(ps.stdout) : [];
  const statuses = [
    ...DOCTOR_SERVICES.map((service) => ({
      service,
      ...classify(
        entries.find((e) => e.Service === service),
        false,
      ),
    })),
    ...DOCTOR_ONE_SHOTS.map((service) => ({
      service,
      ...classify(
        entries.find((e) => e.Service === service),
        true,
      ),
    })),
  ];
  out(formatTable(statuses));
  const bad = statuses.filter((s) => s.verdict !== 'ready').map((s) => s.service);
  if (bad.length > 0) {
    err(
      `  not healthy: ${bad.join(', ')}. Run \`pnpm dev:deps\` (or \`pnpm dev:deps:reset --yes\`).\n`,
    );
    ok = false;
  }

  out('== endpoints ==\n');
  out(`${endpointLines(io.env ?? {}).join('\n')}\n`);
  out(ok ? 'dev:doctor: all healthy\n' : 'dev:doctor: problems found\n');
  return ok ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const envFile = path.join(ROOT, '.env');
  const envText = existsSync(envFile) ? readFileSync(envFile, 'utf8') : undefined;
  /** @type {Record<string, string | undefined>} */
  const fileEnv = {};
  for (const line of (envText ?? '').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m?.[1]) fileEnv[m[1]] = m[2];
  }
  const run = composeRunner(envFile);
  process.exitCode = doctor({
    example: readFileSync(path.join(ROOT, '.env.example'), 'utf8'),
    envText,
    ps: () => run(['ps', '--all', '--format', 'json']),
    env: { ...fileEnv, ...process.env },
    dockerUp: () => spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0,
  });
}
