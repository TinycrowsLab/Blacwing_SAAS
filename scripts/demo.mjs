#!/usr/bin/env node
// `pnpm demo`: one command to bring up a localhost demo of the Blackwing console (DEMO-001).
//
//   node scripts/demo.mjs            # start everything (idempotent)
//   node scripts/demo.mjs status     # show what is running
//   node scripts/demo.mjs stop       # stop api, worker and web started by this script
//
// Steps, in order (each one is safe to re-run):
//   1. dependency stack (`pnpm dev:deps` when Postgres or Keycloak is not healthy)
//   2. Juice Shop lab target on 127.0.0.1:3001 (docker container `bw-demo-juice`)
//   3. demo database `blackwing_demo` (the shared dev database is migrated by other worktrees)
//   4. migrations, then the dev seed (`pnpm db:seed`, which skips tables that are not merged yet)
//   5. API (127.0.0.1:13400), worker and web (DEMO_HOST, default 127.0.0.1, port 3000)
//
// Configuration: the repository `.env` (written by `pnpm dev:deps`) plus `.env.demo`, which this script
// writes on first run (gitignored, holds the demo-only session secret). Logs and pids live in `.demo/`.
// Secrets are never printed.

import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUN_DIR = path.join(ROOT, '.demo');
const LOG_DIR = path.join(RUN_DIR, 'logs');
const PID_FILE = path.join(RUN_DIR, 'pids.json');
const DEMO_ENV_FILE = path.join(ROOT, '.env.demo');
const PNPM = process.env.DEMO_PNPM ?? 'pnpm';
// Heavy commands go through bwheavy when it is installed (see docs/runbooks/demo.md).
const HEAVY = existsSync('/home/lamp/.local/bin/bwheavy')
  ? '/home/lamp/.local/bin/bwheavy'
  : undefined;

const JUICE_CONTAINER = 'bw-demo-juice';
const JUICE_HOST_PORT = Number(process.env.DEMO_JUICE_PORT ?? 3001);
const DEMO_DB = 'blackwing_demo';
const WEB_PORT = Number(process.env.DEMO_WEB_PORT ?? 3000);
const API_PORT = 13400;
const WORKER_HEALTH_PORT = 13800;

const log = (msg) => process.stdout.write(`[demo] ${msg}\n`);
const fail = (msg) => {
  process.stderr.write(`[demo] ERROR: ${msg}\n`);
  process.exit(1);
};

/** Parses KEY=VALUE lines (no expansion). Values are never logged. */
function parseEnvFile(file) {
  if (!existsSync(file)) return {};
  const out = {};
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    out[line.slice(0, eq).trim()] = line
      .slice(eq + 1)
      .trim()
      .replace(/^["']|["']$/g, '');
  }
  return out;
}

function ensureDemoEnv() {
  const existing = parseEnvFile(DEMO_ENV_FILE);
  if (existing.BW_WEB_SESSION_SECRET) return existing;
  const generated = {
    BW_WEB_SESSION_SECRET: randomBytes(48).toString('base64url'),
    BW_WEB_SESSION_SECRET_PREVIOUS: '',
    BW_CONSOLE_ORIGIN: `http://localhost:${WEB_PORT}`,
  };
  const body = Object.entries(generated)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  writeFileSync(
    DEMO_ENV_FILE,
    `# Demo-only overrides written by scripts/demo.mjs. Gitignored. Dev only.\n${body}\n`,
    {
      mode: 0o600,
    },
  );
  log('wrote .env.demo (demo-only session secret)');
  return { ...generated };
}

/** The environment every demo process gets: .env, then .env.demo, then the demo database and ports. */
function demoEnv(demo) {
  const base = parseEnvFile(path.join(ROOT, '.env'));
  const dbUrl = (url) => (url ?? '').replace(/\/blackwing(\?|$)/, `/${DEMO_DB}$1`);
  return {
    ...process.env,
    ...base,
    ...demo,
    NODE_ENV: 'development',
    DATABASE_URL: dbUrl(base.DATABASE_URL),
    MIGRATION_DATABASE_URL: dbUrl(base.MIGRATION_DATABASE_URL),
    PGDATABASE: DEMO_DB,
    API_PORT: String(API_PORT),
    WORKER_HEALTH_PORT: String(WORKER_HEALTH_PORT),
    WEB_ORIGIN: `http://localhost:${WEB_PORT}`,
    BW_CONSOLE_ORIGIN: demo.BW_CONSOLE_ORIGIN,
    BW_TARGET_JUICE_SHOP_URL: `http://127.0.0.1:${JUICE_HOST_PORT}`,
    NEXT_PUBLIC_API_BASE_URL: '/v1',
  };
}

function run(cmd, args, options = {}) {
  const useHeavy = options.heavy === true && HEAVY !== undefined;
  const result = spawnSync(useHeavy ? HEAVY : cmd, useHeavy ? [cmd, ...args] : args, {
    cwd: options.cwd ?? ROOT,
    env: options.env ?? process.env,
    stdio: options.quiet ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    encoding: 'utf8',
  });
  return result;
}

function dockerRunning(name) {
  const r = spawnSync('docker', ['ps', '--filter', `name=^${name}$`, '--format', '{{.Names}}'], {
    encoding: 'utf8',
  });
  return r.status === 0 && r.stdout.trim() === name;
}

function healthy(url) {
  const r = spawnSync('curl', ['-sf', '-m', '3', '-o', '/dev/null', url]);
  return r.status === 0;
}

function stepDeps(env) {
  const pgUp = dockerRunning('bwdev-postgres-1');
  const kcUp = healthy(
    `http://127.0.0.1:${env.BW_DEV_KEYCLOAK_PORT ?? 18080}/realms/blackwing-dev/.well-known/openid-configuration`,
  );
  if (pgUp && kcUp) {
    log('dependency stack already healthy (postgres, keycloak)');
    return;
  }
  log('starting dependency stack (pnpm dev:deps)');
  const r = run(PNPM, ['dev:deps'], { heavy: true });
  if (r.status !== 0) fail('pnpm dev:deps failed; see its output above');
}

function stepJuice() {
  if (dockerRunning(JUICE_CONTAINER)) {
    log(`Juice Shop already running on 127.0.0.1:${JUICE_HOST_PORT}`);
    return;
  }
  spawnSync('docker', ['rm', '-f', JUICE_CONTAINER], { stdio: 'ignore' });
  log(`starting Juice Shop lab target on 127.0.0.1:${JUICE_HOST_PORT}`);
  const r = run(
    'docker',
    [
      'run',
      '-d',
      '--name',
      JUICE_CONTAINER,
      '-p',
      `127.0.0.1:${JUICE_HOST_PORT}:3000`,
      'bkimminich/juice-shop',
    ],
    { heavy: true },
  );
  if (r.status !== 0)
    log('WARNING: could not start Juice Shop (docker run failed); the asset will show as offline');
}

function psqlSuper(sql, env) {
  const user = env.BW_DEV_POSTGRES_SUPERUSER;
  return spawnSync(
    'docker',
    [
      'exec',
      '-e',
      `PGPASSWORD=${env.BW_DEV_POSTGRES_SUPERUSER_PASSWORD}`,
      'bwdev-postgres-1',
      'psql',
      '-U',
      user,
      '-d',
      'blackwing',
      '-Atc',
      sql,
    ],
    { encoding: 'utf8' },
  );
}

function stepDatabase(env) {
  const exists = psqlSuper(`select 1 from pg_database where datname='${DEMO_DB}'`, env);
  if (exists.status !== 0) fail('cannot reach postgres to create the demo database');
  if (exists.stdout.trim() === '1') {
    log(`database ${DEMO_DB} exists`);
    return;
  }
  const owner = env.BW_DEV_POSTGRES_MIGRATOR_USER;
  const create = psqlSuper(`create database ${DEMO_DB} owner ${owner}`, env);
  if (create.status !== 0) fail(`could not create database ${DEMO_DB}: ${create.stderr}`);
  log(`created database ${DEMO_DB}`);
}

function stepMigrateAndSeed(env) {
  log('running migrations');
  const m = run(PNPM, ['--filter', '@blackwing/db', 'run', 'db:migrate'], { env, heavy: true });
  if (m.status !== 0) fail('migrations failed; see the output above');
  log('seeding demo tenant (missing tables are skipped by the seed and reported in its log)');
  const s = run(PNPM, ['--filter', '@blackwing/db', 'run', 'db:seed'], { env, heavy: true });
  if (s.status !== 0)
    log('WARNING: db:seed exited non-zero; the console still starts, see the output above');
}

function loadPids() {
  return existsSync(PID_FILE) ? JSON.parse(readFileSync(PID_FILE, 'utf8')) : {};
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function startService(name, dir, args, env) {
  mkdirSync(LOG_DIR, { recursive: true });
  const out = openSync(path.join(LOG_DIR, `${name}.log`), 'a');
  // `pnpm --dir <pkg> exec <bin>` resolves the package's own binary (tsx, next) without hard-coding node_modules.
  const child = spawn(PNPM, ['--dir', dir, 'exec', ...args], {
    cwd: ROOT,
    env,
    detached: true,
    stdio: ['ignore', out, out],
  });
  closeSync(out);
  child.on('error', (err) => {
    process.stderr.write(`[demo] ERROR: could not start ${name}: ${err.message}\n`);
  });
  child.unref();
  return child.pid;
}

function stepServices(env) {
  const pids = loadPids();
  const bin = (pkg, file) => path.join(ROOT, pkg, file);
  const specs = [
    ['api', 'apps/api', ['tsx', `--env-file=${path.join(ROOT, '.env')}`, 'src/main.ts']],
    ['worker', 'apps/worker', ['tsx', `--env-file=${path.join(ROOT, '.env')}`, 'src/main.ts']],
  ];
  for (const [name, dir, args] of specs) {
    if (pids[name] && alive(pids[name])) {
      log(`${name} already running (pid ${pids[name]})`);
      continue;
    }
    const pid = startService(name, dir, args, env);
    pids[name] = pid;
    log(`started ${name} (pid ${pid})`);
  }
  if (pids.web && alive(pids.web)) {
    log(`web already running (pid ${pids.web})`);
  } else {
    const host = env.DEMO_HOST ?? '127.0.0.1';
    const pid = startService(
      'web',
      'apps/web',
      ['next', 'dev', '--hostname', host, '--port', String(WEB_PORT)],
      env,
    );
    pids.web = pid;
    log(`started web on ${host}:${WEB_PORT} (pid ${pid})`);
  }
  writeFileSync(PID_FILE, JSON.stringify(pids, null, 2));
}

function waitFor(label, url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (healthy(url)) return true;
    spawnSync('sleep', ['2']);
  }
  log(`WARNING: ${label} not answering at ${url} after ${timeoutMs / 1000}s (see .demo/logs/)`);
  return false;
}

function printSummary(env) {
  const host = env.DEMO_HOST ?? '127.0.0.1';
  const kc = `http://localhost:${env.BW_DEV_KEYCLOAK_PORT ?? 18080}`;
  const pw =
    env.BW_DEV_KEYCLOAK_TEST_USER_PASSWORD ?? '(see .env: BW_DEV_KEYCLOAK_TEST_USER_PASSWORD)';
  process.stdout.write(`
Blackwing demo is up.

  Console        http://localhost:${WEB_PORT}        (LAN: http://${host}:${WEB_PORT} when DEMO_HOST is set)
  API            http://127.0.0.1:${API_PORT}/health
  Keycloak       ${kc}/realms/blackwing-dev
  Juice Shop     http://127.0.0.1:${JUICE_HOST_PORT}   (assessment target)

Demo users (Keycloak realm blackwing-dev, password from .env BW_DEV_KEYCLOAK_TEST_USER_PASSWORD):
  requester (operator)   appsec@acme.test
  approver               owner@acme.test
  viewer                 auditor@acme.test
  password               ${pw.startsWith('(') ? pw : '<BW_DEV_KEYCLOAK_TEST_USER_PASSWORD from .env>'}

Logs: ${LOG_DIR}   Stop: node scripts/demo.mjs stop
`);
}

function status() {
  const pids = loadPids();
  for (const name of ['api', 'worker', 'web']) {
    const pid = pids[name];
    log(`${name}: ${pid && alive(pid) ? `running (pid ${pid})` : 'not running'}`);
  }
  log(`juice shop: ${dockerRunning(JUICE_CONTAINER) ? 'running' : 'not running'}`);
  log(`web answering: ${healthy(`http://127.0.0.1:${WEB_PORT}/login`) ? 'yes' : 'no'}`);
  log(`api answering: ${healthy(`http://127.0.0.1:${API_PORT}/health/live`) ? 'yes' : 'no'}`);
}

function stop() {
  const pids = loadPids();
  for (const [name, pid] of Object.entries(pids)) {
    if (!alive(pid)) continue;
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      process.kill(pid, 'SIGTERM');
    }
    log(`stopped ${name} (pid ${pid})`);
  }
  if (existsSync(PID_FILE)) unlinkSync(PID_FILE);
}

async function main() {
  const cmd = process.argv[2] ?? 'up';
  if (cmd === 'status') return status();
  if (cmd === 'stop') return stop();
  if (cmd !== 'up') fail(`unknown command ${cmd} (use up, status or stop)`);

  const demo = ensureDemoEnv();
  const env = demoEnv(demo);
  if (env.BW_DEV_POSTGRES_SUPERUSER === undefined) fail('.env is missing; run pnpm dev:deps first');
  stepDeps(env);
  stepJuice();
  stepDatabase(env);
  stepMigrateAndSeed(env);
  stepServices(env);
  waitFor('API', `http://127.0.0.1:${API_PORT}/health/live`, 60_000);
  waitFor('web', `http://127.0.0.1:${WEB_PORT}/login`, 120_000);
  printSummary(env);
}

await main();
