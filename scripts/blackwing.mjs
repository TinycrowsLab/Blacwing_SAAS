#!/usr/bin/env node
// `pnpm start:local`: one command to run Blackwing on this machine (console, API, worker, AI hunt engine).
//
//   node scripts/blackwing.mjs            # start everything (idempotent)
//   node scripts/blackwing.mjs status     # show what is running
//   node scripts/blackwing.mjs smoke      # run the assessment flow end to end on its own database (exit 1 on failure)
//   node scripts/blackwing.mjs stop       # stop the api, worker, hunt engine and web started by this script
//   node scripts/blackwing.mjs lab        # only the Juice Shop lab container
//
// Steps, in order (each one is safe to re-run):
//   1. dependency stack (`pnpm dev:deps` when Postgres is not running)
//   2. the Juice Shop lab when Docker is available; skipped otherwise
//   3. the product database (BW_DB_NAME, default `blackwing_app`): a clean database of its own. The shared dev database
//      `blackwing` (migrated and seeded by other worktrees) and the older `blackwing_demo` are never touched.
//   4. migrations only (no seed), then one workspace (tenant) with an empty name when the database has none: the first
//      administrator names it on /welcome after signing in with Google
//   5. API (127.0.0.1:13400, BW_DEMO_MODE=1 mounts the console routes), worker, hunt engine, then the web console as a
//      production build (`next build`, then `next start` on 127.0.0.1:3000). Nothing is registered: people add their
//      own targets in the console, the local lab included.
//
// `smoke` runs on its own database `blackwing_smoke` (migrated and seeded: the seeded personas live only there), with a
// private API on 13401 and hunt engine, so the product database never sees smoke rows.
//
// Configuration: the repository `.env` (written by `pnpm dev:deps`) plus `.env.demo`, which this script completes on
// first run (gitignored: AUTH_SECRET and the internal API token are generated here; the Google client AUTH_GOOGLE_ID /
// AUTH_GOOGLE_SECRET and BW_ADMIN_EMAILS are added by hand). Logs and pids live in `.demo/`. Secret values are never
// printed.

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
const ENV_FILE = path.join(ROOT, '.env.demo');
const PNPM = process.env.DEMO_PNPM ?? 'pnpm';
// Heavy commands go through bwheavy when it is installed (see docs/runbooks/local-stack.md).
const HEAVY = existsSync('/home/lamp/.local/bin/bwheavy')
  ? '/home/lamp/.local/bin/bwheavy'
  : undefined;

// Local lab (OWASP Juice Shop) started by `up` when Docker is available. Never used by the platform itself.
const LAB_CONTAINER = 'bw-demo-lab';
const LAB_IMAGE = process.env.DEMO_LAB_IMAGE ?? 'bkimminich/juice-shop';
const LAB_PORT = Number(process.env.DEMO_LAB_PORT ?? 3001);
const LAB_CONTAINER_PORT = Number(process.env.DEMO_LAB_CONTAINER_PORT ?? 3000);
// Not `blackwing`: that is the shared dev database, seeded by other worktrees. Not `blackwing_demo`: earlier test data.
const DB_NAME = process.env.BW_DB_NAME ?? 'blackwing_app';
const SMOKE_DB_NAME = 'blackwing_smoke';
const SMOKE_API_PORT = 13401;
const SMOKE_WORKER_HEALTH_PORT = 13801;
// Same variable and default as the API and the hunt engine; passed to both so the console shows the real deadline.
const GATE2_TIMEOUT_S = process.env.BW_GATE2_TIMEOUT_S ?? '300';
const STACK_FILE = path.join(RUN_DIR, 'stack.json');
const WEB_PORT = Number(process.env.DEMO_WEB_PORT ?? 3000);
// The console's public origin; Google must allow `<origin>/api/auth/callback/google` as a redirect URI.
const CONSOLE_ORIGIN = (process.env.DEMO_PUBLIC_ORIGIN ?? `http://localhost:${WEB_PORT}`).replace(
  /\/$/,
  '',
);
const API_PORT = Number(process.env.DEMO_API_PORT ?? 13400);
const WORKER_HEALTH_PORT = 13800;
const API_ORIGIN = `http://127.0.0.1:${API_PORT}`;
// Seeded directory users of the seed tenant, used by `smoke` only (they exist only in the smoke database).
const SEED_USERS = {
  requester: 'appsec@acme.test',
  approver: 'owner@acme.test',
};
// Keys earlier versions wrote to .env.demo that nothing reads any more (the Keycloak session and presenter login).
const OBSOLETE_KEYS = [
  'BW_WEB_SESSION_SECRET',
  'BW_WEB_SESSION_SECRET_PREVIOUS',
  'BW_CONSOLE_ORIGIN',
  'BW_DEMO_LOGIN_EMAIL',
  'BW_DEMO_LOGIN_PASSWORD',
];

const log = (msg) => process.stdout.write(`[blackwing] ${msg}\n`);
const fail = (msg) => {
  process.stderr.write(`[blackwing] ERROR: ${msg}\n`);
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

/** Completes .env.demo: generates AUTH_SECRET and the internal token once, drops obsolete keys. */
function ensureEnvFile() {
  const existing = parseEnvFile(ENV_FILE);
  const kept = Object.fromEntries(
    Object.entries(existing).filter(([k]) => !OBSOLETE_KEYS.includes(k)),
  );
  const next = {
    ...kept,
    AUTH_SECRET: existing.AUTH_SECRET ?? randomBytes(32).toString('base64url'),
    BW_DEMO_INTERNAL_TOKEN:
      existing.BW_DEMO_INTERNAL_TOKEN ?? randomBytes(32).toString('base64url'),
    AUTH_GOOGLE_ID: existing.AUTH_GOOGLE_ID ?? '',
    AUTH_GOOGLE_SECRET: existing.AUTH_GOOGLE_SECRET ?? '',
    BW_ADMIN_EMAILS: existing.BW_ADMIN_EMAILS ?? '',
  };
  const same =
    Object.keys(next).length === Object.keys(existing).length &&
    Object.keys(next).every((k) => existing[k] === next[k]);
  if (!same) {
    const body = Object.entries(next)
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');
    writeFileSync(
      ENV_FILE,
      `# Local Blackwing settings, written by scripts/blackwing.mjs. Gitignored: holds secrets.\n` +
        `# AUTH_GOOGLE_ID / AUTH_GOOGLE_SECRET: the Google OAuth client; BW_ADMIN_EMAILS: who may sign in (comma list).\n` +
        `${body}\n`,
      { mode: 0o600 },
    );
    log('updated .env.demo (generated secrets are not printed)');
  }
  for (const key of ['AUTH_GOOGLE_ID', 'AUTH_GOOGLE_SECRET', 'BW_ADMIN_EMAILS']) {
    if (next[key] === '')
      log(`WARNING: ${key} is empty in .env.demo: nobody can sign in until it is set`);
  }
  return next;
}

/** The environment every process gets: .env, then .env.demo, then the database, ports and sign-in settings. */
function stackEnv(local, dbName = DB_NAME, apiPort = API_PORT, workerHealthPort = WORKER_HEALTH_PORT) {
  const base = parseEnvFile(path.join(ROOT, '.env'));
  const dbUrl = (url) => (url ?? '').replace(/\/blackwing(\?|$)/, `/${dbName}$1`);
  return {
    ...process.env,
    ...base,
    ...local,
    NODE_ENV: 'development',
    DATABASE_URL: dbUrl(base.DATABASE_URL),
    MIGRATION_DATABASE_URL: dbUrl(base.MIGRATION_DATABASE_URL),
    PGDATABASE: dbName,
    API_PORT: String(apiPort),
    WORKER_HEALTH_PORT: String(workerHealthPort),
    WEB_ORIGIN: CONSOLE_ORIGIN,
    BW_CONSOLE_ORIGIN: CONSOLE_ORIGIN,
    // dev lets the hunt engine use the host's Claude login when no ANTHROPIC_API_KEY is set (local runs only).
    BW_ENV: process.env.BW_ENV ?? base.BW_ENV ?? 'dev',
    // The console routes are mounted in the API only with BW_DEMO_MODE=1.
    BW_DEMO_MODE: '1',
    BW_DEMO_API_ORIGIN: `http://127.0.0.1:${apiPort}`,
    BW_DEMO_TENANT_ID: local.BW_DEMO_TENANT_ID ?? '',
    BW_GATE2_TIMEOUT_S: GATE2_TIMEOUT_S,
    // Auth.js (web): Google sign-in, JWT session cookie, callback at <AUTH_URL>/api/auth/callback/google.
    AUTH_URL: CONSOLE_ORIGIN,
    AUTH_TRUST_HOST: 'true',
  };
}

function run(cmd, args, options = {}) {
  const useHeavy = options.heavy === true && HEAVY !== undefined;
  return spawnSync(useHeavy ? HEAVY : cmd, useHeavy ? [cmd, ...args] : args, {
    cwd: options.cwd ?? ROOT,
    env: options.env ?? process.env,
    stdio: options.stdio ?? 'inherit',
    encoding: 'utf8',
  });
}

function dockerRunning(name) {
  const r = spawnSync('docker', ['ps', '--filter', `name=^${name}$`, '--format', '{{.Names}}'], {
    encoding: 'utf8',
  });
  return r.status === 0 && r.stdout.trim() === name;
}

function healthy(url) {
  return spawnSync('curl', ['-sf', '-m', '3', '-o', '/dev/null', url]).status === 0;
}

function stepDeps() {
  if (dockerRunning('bwdev-postgres-1')) {
    log('postgres is running');
    return;
  }
  log('starting the dependency stack (pnpm dev:deps)');
  if (run(PNPM, ['dev:deps'], { heavy: true }).status !== 0)
    fail('pnpm dev:deps failed; see its output above');
}

/** Starts the Juice Shop lab. Returns false (never exits) when Docker or the container is not available. */
function stepLab() {
  if (spawnSync('docker', ['info'], { stdio: 'ignore' }).status !== 0) {
    log(
      'WARNING: Docker is not available: the Juice Shop lab is skipped (register any authorised URL instead)',
    );
    return false;
  }
  if (dockerRunning(LAB_CONTAINER)) {
    log(`lab already running on http://127.0.0.1:${LAB_PORT}`);
    return true;
  }
  spawnSync('docker', ['rm', '-f', LAB_CONTAINER], { stdio: 'ignore' });
  log(`starting lab ${LAB_IMAGE} on http://127.0.0.1:${LAB_PORT}`);
  const r = spawnSync(
    'docker',
    [
      'run',
      '-d',
      '--name',
      LAB_CONTAINER,
      '-p',
      `127.0.0.1:${LAB_PORT}:${LAB_CONTAINER_PORT}`,
      LAB_IMAGE,
    ],
    { stdio: 'inherit' },
  );
  if (r.status !== 0) {
    log('WARNING: could not start the lab container; continuing without it');
    return false;
  }
  return true;
}

function psqlSuper(sql, env, database = 'blackwing') {
  return spawnSync(
    'docker',
    [
      'exec',
      '-e',
      `PGPASSWORD=${env.BW_DEV_POSTGRES_SUPERUSER_PASSWORD}`,
      'bwdev-postgres-1',
      'psql',
      '-U',
      env.BW_DEV_POSTGRES_SUPERUSER,
      '-d',
      database,
      '-Atc',
      sql,
    ],
    { encoding: 'utf8' },
  );
}

function stepDatabase(env, dbName) {
  if (!/^[a-z_][a-z0-9_]*$/.test(dbName)) fail(`invalid database name ${dbName}`);
  const exists = psqlSuper(`select 1 from pg_database where datname='${dbName}'`, env);
  if (exists.status !== 0) fail('cannot reach postgres to create the database');
  if (exists.stdout.trim() === '1') {
    log(`database ${dbName} exists`);
  } else {
    const create = psqlSuper(
      `create database ${dbName} owner ${env.BW_DEV_POSTGRES_MIGRATOR_USER}`,
      env,
    );
    if (create.status !== 0) fail(`could not create database ${dbName}: ${create.stderr}`);
    log(`created database ${dbName}`);
  }
  // The migrations need these, and only a superuser may create them (infra/compose/postgres/init does it for `blackwing`).
  const ext = psqlSuper(
    'create extension if not exists vector; create extension if not exists pgcrypto;',
    env,
    dbName,
  );
  if (ext.status !== 0) fail(`could not create the extensions in ${dbName}: ${ext.stderr}`);
}

/** The workspace the console runs in: the only active tenant (the oldest, should there ever be more). '' when none. */
function tenantId(env, dbName) {
  const r = psqlSuper(
    "select id from tenants where status = 'active' order by created_at limit 1",
    env,
    dbName,
  );
  return r.status === 0 ? r.stdout.trim() : '';
}

function stepMigrate(env) {
  log(`running migrations on ${env.PGDATABASE}`);
  if (
    run(PNPM, ['--filter', '@blackwing/db', 'run', 'db:migrate'], { env, heavy: true }).status !== 0
  )
    fail('migrations failed; see the output above');
}

/**
 * A fresh product database gets one workspace with an empty name and no users: the first administrator's Google sign-in
 * creates their user and membership (API), and /welcome names the workspace. Superuser insert (tenants force RLS).
 */
function stepBootstrapTenant(env) {
  const count = psqlSuper('select count(*) from tenants', env, DB_NAME);
  if (count.status !== 0) fail(`cannot read tenants in ${DB_NAME}: ${count.stderr}`);
  if (Number(count.stdout.trim()) > 0) return;
  const slug = `ws-${randomBytes(3).toString('hex')}`;
  const insert = psqlSuper(
    `insert into tenants (slug, name, region) values ('${slug}', '', 'local')`,
    env,
    DB_NAME,
  );
  if (insert.status !== 0) fail(`could not create the workspace: ${insert.stderr}`);
  log('created the workspace (it is named on /welcome at the first sign-in)');
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
    process.stderr.write(`[blackwing] ERROR: could not start ${name}: ${err.message}\n`);
  });
  child.unref();
  return child.pid;
}

/** Builds the console for production (no dev server: no recompiling on navigation). Output in .demo/logs/web-build.log. */
function buildWeb(env) {
  mkdirSync(LOG_DIR, { recursive: true });
  log('building the web console (next build, about a minute)');
  const out = openSync(path.join(LOG_DIR, 'web-build.log'), 'w');
  const r = run(PNPM, ['--dir', 'apps/web', 'exec', 'next', 'build'], {
    env,
    heavy: true,
    stdio: ['ignore', out, out],
  });
  closeSync(out);
  if (r.status !== 0) fail(`next build failed; see ${path.join(LOG_DIR, 'web-build.log')}`);
}

function stepServices(env) {
  const pids = loadPids();
  // A running API keeps the database it was started with; say so when that is not this one.
  const stack = existsSync(STACK_FILE) ? JSON.parse(readFileSync(STACK_FILE, 'utf8')) : {};
  if (pids.api && alive(pids.api) && stack.db !== DB_NAME)
    log(
      `WARNING: the running API uses database ${stack.db ?? '(unknown)'}, not ${DB_NAME}. ` +
        'Restart it to switch: node scripts/blackwing.mjs stop && node scripts/blackwing.mjs',
    );
  else if (!(pids.api && alive(pids.api)))
    writeFileSync(STACK_FILE, JSON.stringify({ db: DB_NAME }, null, 2));
  const specs = [
    ['api', 'apps/api', ['tsx', `--env-file=${path.join(ROOT, '.env')}`, 'src/main.ts']],
    ['worker', 'apps/worker', ['tsx', `--env-file=${path.join(ROOT, '.env')}`, 'src/main.ts']],
    // AI hunt engine: polls the database for queued runs and runs the Claude agent team against the run's scope.
    ['demo-runner', 'apps/worker', ['tsx', 'src/demo/main.ts']],
  ];
  for (const [name, dir, args] of specs) {
    if (pids[name] && alive(pids[name])) {
      log(`${name} already running (pid ${pids[name]})`);
      continue;
    }
    pids[name] = startService(name, dir, args, env);
    log(`started ${name} (pid ${pids[name]})`);
  }
  // Saved before the web build, so a failed build never leaves untracked processes behind.
  writeFileSync(PID_FILE, JSON.stringify(pids, null, 2));
  if (pids.web && alive(pids.web)) {
    log(`web already running (pid ${pids.web})`);
  } else {
    const webEnv = { ...env, NODE_ENV: 'production' };
    buildWeb(webEnv);
    const host = env.DEMO_HOST ?? '127.0.0.1';
    pids.web = startService(
      'web',
      'apps/web',
      ['next', 'start', '--hostname', host, '--port', String(WEB_PORT)],
      webEnv,
    );
    log(`started web on ${host}:${WEB_PORT} (pid ${pids.web})`);
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

function printSummary(env, labUp) {
  const admins = (env.BW_ADMIN_EMAILS ?? '').split(',').filter((e) => e.trim() !== '');
  process.stdout.write(`
Blackwing is up.

  Console        ${CONSOLE_ORIGIN}   (bound to ${env.DEMO_HOST ?? '127.0.0.1'}:${WEB_PORT})
  Sign in        Continue with Google as ${admins.length === 0 ? '(set BW_ADMIN_EMAILS in .env.demo)' : admins.join(', ')}
  Google client  redirect URI ${CONSOLE_ORIGIN}/api/auth/callback/google
  API            ${API_ORIGIN}/health/live
  Database       ${DB_NAME}
  Local test target  ${labUp ? `http://127.0.0.1:${LAB_PORT} (add it in the app like any site)` : 'not running (node scripts/blackwing.mjs lab starts it)'}
  Check it       DEMO_SMOKE_TARGET=http://127.0.0.1:${LAB_PORT} node scripts/blackwing.mjs smoke   (own database ${SMOKE_DB_NAME})

Logs: ${LOG_DIR}   Stop: pnpm stop:local
`);
}

/** Calls the API's console routes with the internal token and a seeded identity (what the web sends after sign-in). */
async function apiCall(origin, token, user, method, route, body, roles) {
  const headers = { accept: 'application/json', 'x-bw-demo-token': token };
  if (user !== undefined) headers['x-bw-demo-user'] = user;
  if (roles !== undefined) headers['x-bw-demo-roles'] = roles;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${origin}/v1/demo${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  });
  const text = await res.text();
  let json = {};
  try {
    json = text === '' ? {} : JSON.parse(text);
  } catch {
    json = { raw: text.slice(0, 200) };
  }
  return { status: res.status, json, text };
}

const smokeRequest = (assetId) => ({
  assetId,
  objective: 'Smoke test: short black-box web assessment (OWASP Top 10 indicators).',
  intrusiveness: 'active_safe',
  budgetRequests: 60,
  budgetSeconds: 300,
  costCapUsd: 2,
});

/** Stops a process group started by startService (the pnpm wrapper and its children). */
function stopGroup(pid) {
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    if (alive(pid)) process.kill(pid, 'SIGTERM');
  }
}

/**
 * The smoke stack: database `blackwing_smoke` (created, migrated and seeded), a private API on 13401 and a hunt engine
 * against it. Returns a function that stops both. The product database and the product services are never touched.
 * Only the hunt engine is started: the Temporal worker is not part of this flow and would share the product's task queue.
 */
function startSmokeStack(local) {
  const base = stackEnv(local, SMOKE_DB_NAME, SMOKE_API_PORT, SMOKE_WORKER_HEALTH_PORT);
  if (base.BW_DEV_POSTGRES_SUPERUSER === undefined) fail('.env is missing; run pnpm dev:deps first');
  stepDatabase(base, SMOKE_DB_NAME);
  stepMigrate(base);
  log(`seeding ${SMOKE_DB_NAME} (the smoke personas live only there)`);
  if (run(PNPM, ['--filter', '@blackwing/db', 'run', 'db:seed'], { env: base, heavy: true }).status !== 0)
    fail('db:seed failed on the smoke database; see the output above');
  // The seed's tenant is the one the seeded requester belongs to (superuser read: memberships force RLS).
  const tenant = psqlSuper(
    `select m.tenant_id from memberships m join users u on u.id = m.user_id where lower(u.email) = '${SEED_USERS.requester}' limit 1`,
    base,
    SMOKE_DB_NAME,
  ).stdout.trim();
  if (tenant === '') fail(`the seeded tenant is not in ${SMOKE_DB_NAME}`);
  const env = stackEnv(
    { ...local, BW_DEMO_TENANT_ID: tenant },
    SMOKE_DB_NAME,
    SMOKE_API_PORT,
    SMOKE_WORKER_HEALTH_PORT,
  );
  const pids = [
    startService('smoke-api', 'apps/api', ['tsx', `--env-file=${path.join(ROOT, '.env')}`, 'src/main.ts'], env),
    startService('smoke-runner', 'apps/worker', ['tsx', 'src/demo/main.ts'], env),
  ];
  const stopAll = () => {
    for (const pid of pids) stopGroup(pid);
    log('stopped the smoke API and hunt engine');
  };
  if (!waitFor('smoke API', `http://127.0.0.1:${SMOKE_API_PORT}/health/live`, 90_000)) {
    stopAll();
    fail(`the smoke API did not start; see ${path.join(LOG_DIR, 'smoke-api.log')}`);
  }
  return stopAll;
}

/**
 * `smoke`: checks the web sign-in wiring (read-only, on the running console), then runs the assessment flow end to end on
 * the smoke stack with two seeded identities (separation of duties), and exits 1 on any failure.
 */
async function smoke() {
  const local = parseEnvFile(ENV_FILE);
  const token = local.BW_DEMO_INTERNAL_TOKEN ?? '';
  if (token === '') fail('no internal token in .env.demo; run node scripts/blackwing.mjs first');
  const smokeOrigin = `http://127.0.0.1:${SMOKE_API_PORT}`;
  const api = (user, method, route, body, roles) =>
    apiCall(smokeOrigin, token, user, method, route, body, roles);
  const requester = { user: SEED_USERS.requester, roles: 'appsec-engineer' };
  const approver = { user: SEED_USERS.approver, roles: 'asset-owner' };
  const web = `http://127.0.0.1:${WEB_PORT}`;
  const results = [];
  const check = async (name, fn) => {
    try {
      results.push({ ok: true, name, detail: (await fn()) ?? '' });
    } catch (error) {
      results.push({
        ok: false,
        name,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
    const last = results.at(-1);
    log(`${last.ok ? 'PASS' : 'FAIL'} ${name}${last.detail === '' ? '' : ` (${last.detail})`}`);
  };
  const expect = (cond, message) => {
    if (!cond) throw new Error(message);
  };
  const ctx = {};
  const target = process.env.DEMO_SMOKE_TARGET ?? '';
  if (target === '')
    fail('set DEMO_SMOKE_TARGET to an authorised target URL (e.g. the lab: http://127.0.0.1:3001)');
  const stopSmokeStack = startSmokeStack(local);
  try {
    await smokeChecks({ api, check, expect, ctx, target, web, smokeOrigin, requester, approver });
  } finally {
    stopSmokeStack();
  }
  const failed = results.filter((r) => !r.ok);
  log(`${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length > 0) {
    log(`FAILED: ${failed.map((f) => f.name).join('; ')}`);
    process.exit(1);
  }
  log(`console: ${CONSOLE_ORIGIN} (sign in with Google)`);
}

async function smokeChecks({ api, check, expect, ctx, target, web, smokeOrigin, requester, approver }) {
  await check('API answers /health/live', async () => {
    const r = await fetch(`${smokeOrigin}/health/live`);
    expect(r.status === 200, `HTTP ${r.status}`);
  });
  await check('web: / redirects to /login when signed out', async () => {
    const r = await fetch(`${web}/`, { redirect: 'manual' });
    expect(r.status >= 300 && r.status < 400, `HTTP ${r.status}`);
    expect(
      new URL(r.headers.get('location') ?? '', web).pathname === '/login',
      'no /login redirect',
    );
  });
  await check('web: /login renders', async () => {
    const r = await fetch(`${web}/login`);
    expect(r.status === 200, `HTTP ${r.status}`);
    expect((await r.text()).includes('Continue with Google'), 'no Google button');
  });
  await check('web: /api/auth/providers lists google', async () => {
    const r = await fetch(`${web}/api/auth/providers`);
    expect(r.status === 200, `HTTP ${r.status}`);
    const body = await r.json();
    expect(
      body.google?.callbackUrl === `${CONSOLE_ORIGIN}/api/auth/callback/google`,
      `callback ${body.google?.callbackUrl}`,
    );
  });
  await check('API refuses a call without the internal token', async () => {
    const r = await fetch(`${smokeOrigin}/v1/demo/dashboard`);
    expect(r.status === 401, `HTTP ${r.status}`);
  });
  await check('requester registers the target', async () => {
    const r = await api(
      requester.user,
      'POST',
      '/assets',
      { name: `Smoke target ${new URL(target).host}`, baseUrl: target },
      requester.roles,
    );
    expect(r.status === 201 || r.status === 200, `HTTP ${r.status} ${r.json.code ?? ''}`);
    ctx.assetId = r.json.id;
    // Registering an origin that is already an asset (an earlier smoke run) returns that asset.
    ctx.alreadyVerified = r.json.ownership?.status === 'verified';
    return ctx.alreadyVerified ? 'already registered and verified' : '';
  });
  await check('request refused while the target is unverified', async () => {
    if (ctx.alreadyVerified) return 'skipped: the target was verified earlier';
    const r = await api(
      requester.user,
      'POST',
      '/requests',
      smokeRequest(ctx.assetId),
      requester.roles,
    );
    expect(r.status >= 400, `HTTP ${r.status}`);
  });
  await check('asset owner attests ownership', async () => {
    if (ctx.alreadyVerified) return 'skipped: the target was verified earlier';
    const r = await api(
      approver.user,
      'POST',
      `/assets/${ctx.assetId}/verify`,
      { method: 'owner_attestation', statement: 'Smoke test: lab target owned by the team.' },
      approver.roles,
    );
    expect(r.status === 200, `HTTP ${r.status} ${r.json.code ?? ''}`);
  });
  await check('request created for Gate 1 (requester)', async () => {
    const r = await api(
      requester.user,
      'POST',
      '/requests',
      smokeRequest(ctx.assetId),
      requester.roles,
    );
    expect(r.status === 201 || r.status === 200, `HTTP ${r.status} ${r.json.code ?? ''}`);
    ctx.requestId = r.json.id;
  });
  await check('Gate 1 refuses the requester (separation of duties)', async () => {
    const r = await api(
      requester.user,
      'POST',
      `/requests/${ctx.requestId}/decision`,
      { decision: 'approve' },
      'appsec-engineer,asset-owner',
    );
    expect(r.status === 403 || r.status === 409, `HTTP ${r.status}`);
  });
  await check('Gate 1 approved by the asset owner', async () => {
    const r = await api(
      approver.user,
      'POST',
      `/requests/${ctx.requestId}/decision`,
      { decision: 'approve' },
      approver.roles,
    );
    expect(r.status === 200, `HTTP ${r.status} ${r.json.code ?? ''}`);
  });
  await check('run started by the requester', async () => {
    const r = await api(
      requester.user,
      'POST',
      `/requests/${ctx.requestId}/runs`,
      undefined,
      requester.roles,
    );
    expect(r.status === 201 || r.status === 200, `HTTP ${r.status} ${r.json.code ?? ''}`);
    ctx.runId = r.json.id;
  });
  await check('run reaches a terminal state with work from at least two agents', async () => {
    const deadline = Date.now() + 8 * 60_000;
    let runState;
    while (Date.now() < deadline) {
      runState = (
        await api(
          requester.user,
          'GET',
          `/runs/${ctx.runId}?afterSeq=0`,
          undefined,
          requester.roles,
        )
      ).json;
      if (['completed', 'failed', 'killed'].includes(runState.state)) break;
      await new Promise((r) => setTimeout(r, 5000));
    }
    expect(
      runState?.state === 'completed',
      `state ${runState?.state} ${JSON.stringify(runState?.events?.at(-1)?.data ?? {})}`,
    );
    const agents = new Set((runState.events ?? []).map((e) => e.data?.agent).filter(Boolean));
    expect(agents.size >= 2, `agents seen: ${[...agents].join(',')}`);
    return `${runState.stats?.httpSent ?? 0} requests, ${runState.findings?.length ?? 0} findings, $${runState.costUsd}`;
  });
}

function status() {
  const pids = loadPids();
  for (const name of ['api', 'worker', 'demo-runner', 'web']) {
    const pid = pids[name];
    log(`${name}: ${pid && alive(pid) ? `running (pid ${pid})` : 'not running'}`);
  }
  log(`lab: ${dockerRunning(LAB_CONTAINER) ? `running on 127.0.0.1:${LAB_PORT}` : 'not running'}`);
  log(`web answering: ${healthy(`http://127.0.0.1:${WEB_PORT}/login`) ? 'yes' : 'no'}`);
  log(`api answering: ${healthy(`${API_ORIGIN}/health/live`) ? 'yes' : 'no'}`);
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
  if (existsSync(STACK_FILE)) unlinkSync(STACK_FILE);
}

async function main() {
  const cmd = process.argv[2] ?? 'up';
  if (cmd === 'status') return status();
  if (cmd === 'stop') return stop();
  if (cmd === 'smoke') return smoke();
  if (cmd === 'lab') {
    if (!stepLab()) process.exit(1);
    return;
  }
  if (cmd !== 'up') fail(`unknown command ${cmd} (use up, status, smoke, stop or lab)`);

  const local = ensureEnvFile();
  const baseEnv = stackEnv(local);
  if (baseEnv.BW_DEV_POSTGRES_SUPERUSER === undefined)
    fail('.env is missing; run pnpm dev:deps first');
  stepDeps();
  stepDatabase(baseEnv, DB_NAME);
  stepMigrate(baseEnv);
  stepBootstrapTenant(baseEnv);
  const labUp = stepLab();
  // The API and the hunt engine run in the database's only workspace.
  const tenant = tenantId(baseEnv, DB_NAME);
  if (tenant === '') fail(`no active workspace in ${DB_NAME}`);
  const env = stackEnv({ ...local, BW_DEMO_TENANT_ID: tenant });
  stepServices(env);
  waitFor('API', `${API_ORIGIN}/health/live`, 60_000);
  waitFor('web', `http://127.0.0.1:${WEB_PORT}/login`, 120_000);
  printSummary(env, labUp);
}

await main();
