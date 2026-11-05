#!/usr/bin/env node
// `pnpm start:local`: one command to run Blackwing on this machine (console, API, worker, AI hunt engine).
//
//   node scripts/blackwing.mjs            # start everything (idempotent)
//   node scripts/blackwing.mjs status     # show what is running
//   node scripts/blackwing.mjs smoke      # run the assessment flow end to end against the live stack (exit 1 on failure)
//   node scripts/blackwing.mjs stop       # stop the api, worker, hunt engine and web started by this script
//   node scripts/blackwing.mjs lab        # only the Juice Shop lab container
//
// Steps, in order (each one is safe to re-run):
//   1. dependency stack (`pnpm dev:deps` when Postgres is not running)
//   2. the Juice Shop lab when Docker is available; skipped otherwise
//   3. database `blackwing_demo` (the shared dev database is migrated by other worktrees)
//   4. migrations, then the seed (`pnpm db:seed`: the `acme` tenant and its directory users)
//   5. API (127.0.0.1:13400, BW_DEMO_MODE=1 mounts the console routes), worker, hunt engine, then the web console as a
//      production build (`next build`, then `next start` on 127.0.0.1:3000). Once the API is healthy the lab is
//      registered and verified as an asset.
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
const DB_NAME = 'blackwing_demo';
const WEB_PORT = Number(process.env.DEMO_WEB_PORT ?? 3000);
// The console's public origin; Google must allow `<origin>/api/auth/callback/google` as a redirect URI.
const CONSOLE_ORIGIN = (process.env.DEMO_PUBLIC_ORIGIN ?? `http://localhost:${WEB_PORT}`).replace(
  /\/$/,
  '',
);
const API_PORT = Number(process.env.DEMO_API_PORT ?? 13400);
const WORKER_HEALTH_PORT = 13800;
const API_ORIGIN = `http://127.0.0.1:${API_PORT}`;
// Seeded directory users of the `acme` tenant, used by `up` and `smoke` on the internal API hop only.
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
function stackEnv(local) {
  const base = parseEnvFile(path.join(ROOT, '.env'));
  const dbUrl = (url) => (url ?? '').replace(/\/blackwing(\?|$)/, `/${DB_NAME}$1`);
  return {
    ...process.env,
    ...base,
    ...local,
    NODE_ENV: 'development',
    DATABASE_URL: dbUrl(base.DATABASE_URL),
    MIGRATION_DATABASE_URL: dbUrl(base.MIGRATION_DATABASE_URL),
    PGDATABASE: DB_NAME,
    API_PORT: String(API_PORT),
    WORKER_HEALTH_PORT: String(WORKER_HEALTH_PORT),
    WEB_ORIGIN: CONSOLE_ORIGIN,
    BW_CONSOLE_ORIGIN: CONSOLE_ORIGIN,
    // dev lets the hunt engine use the host's Claude login when no ANTHROPIC_API_KEY is set (local runs only).
    BW_ENV: process.env.BW_ENV ?? base.BW_ENV ?? 'dev',
    // The console routes are mounted in the API only with BW_DEMO_MODE=1.
    BW_DEMO_MODE: '1',
    BW_DEMO_API_ORIGIN: API_ORIGIN,
    BW_DEMO_TENANT_ID: local.BW_DEMO_TENANT_ID ?? '',
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

function stepDatabase(env) {
  const exists = psqlSuper(`select 1 from pg_database where datname='${DB_NAME}'`, env);
  if (exists.status !== 0) fail('cannot reach postgres to create the database');
  if (exists.stdout.trim() === '1') {
    log(`database ${DB_NAME} exists`);
    return;
  }
  const create = psqlSuper(
    `create database ${DB_NAME} owner ${env.BW_DEV_POSTGRES_MIGRATOR_USER}`,
    env,
  );
  if (create.status !== 0) fail(`could not create database ${DB_NAME}: ${create.stderr}`);
  log(`created database ${DB_NAME}`);
}

/** Returns the tenant id (the seeded `acme` tenant), or '' when not seeded yet. */
function tenantId(env) {
  const r = psqlSuper("select id from tenants where slug = 'acme'", env, DB_NAME);
  return r.status === 0 ? r.stdout.trim() : '';
}

function stepMigrateAndSeed(env) {
  log('running migrations');
  if (
    run(PNPM, ['--filter', '@blackwing/db', 'run', 'db:migrate'], { env, heavy: true }).status !== 0
  )
    fail('migrations failed; see the output above');
  log('seeding the acme tenant');
  if (run(PNPM, ['--filter', '@blackwing/db', 'run', 'db:seed'], { env, heavy: true }).status !== 0)
    log('WARNING: db:seed exited non-zero; see the output above');
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

function printSummary(env, labRegistered) {
  const admins = (env.BW_ADMIN_EMAILS ?? '').split(',').filter((e) => e.trim() !== '');
  process.stdout.write(`
Blackwing is up.

  Console        ${CONSOLE_ORIGIN}   (bound to ${env.DEMO_HOST ?? '127.0.0.1'}:${WEB_PORT})
  Sign in        Continue with Google as ${admins.length === 0 ? '(set BW_ADMIN_EMAILS in .env.demo)' : admins.join(', ')}
  Google client  redirect URI ${CONSOLE_ORIGIN}/api/auth/callback/google
  API            ${API_ORIGIN}/health/live
  Lab            ${labRegistered ? `http://127.0.0.1:${LAB_PORT} (registered as Juice Shop lab)` : 'not running (node scripts/blackwing.mjs lab starts it)'}
  Check it       DEMO_SMOKE_TARGET=http://127.0.0.1:${LAB_PORT} node scripts/blackwing.mjs smoke

Logs: ${LOG_DIR}   Stop: pnpm stop:local
`);
}

/** Calls the API's console routes with the internal token and a seeded identity (what the web sends after sign-in). */
async function apiCall(token, user, method, route, body, roles) {
  const headers = { accept: 'application/json', 'x-bw-demo-token': token };
  if (user !== undefined) headers['x-bw-demo-user'] = user;
  if (roles !== undefined) headers['x-bw-demo-roles'] = roles;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${API_ORIGIN}/v1/demo${route}`, {
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

/** Registers the lab as an asset and has the owner verify it. Idempotent (the API reuses an asset for the same origin). */
async function registerLab(local) {
  const token = local.BW_DEMO_INTERNAL_TOKEN ?? '';
  try {
    const baseUrl = `http://127.0.0.1:${LAB_PORT}`;
    const created = await apiCall(
      token,
      SEED_USERS.requester,
      'POST',
      '/assets',
      { name: 'Juice Shop lab', baseUrl },
      'appsec-engineer',
    );
    if (created.status !== 200 && created.status !== 201)
      throw new Error(`register HTTP ${created.status}`);
    if (created.json.ownership?.status !== 'verified') {
      const verified = await apiCall(
        token,
        SEED_USERS.approver,
        'POST',
        `/assets/${created.json.id}/verify`,
        {
          method: 'owner_attestation',
          statement: 'Local lab (OWASP Juice Shop) started by scripts/blackwing.mjs.',
        },
        'asset-owner',
      );
      if (verified.status !== 200) throw new Error(`verify HTTP ${verified.status}`);
    }
    log('lab registered and verified as an asset: Juice Shop lab');
    return true;
  } catch (error) {
    log(
      `WARNING: could not register the lab as an asset (${error instanceof Error ? error.message : String(error)})`,
    );
    return false;
  }
}

const smokeRequest = (assetId) => ({
  assetId,
  objective: 'Smoke test: short black-box web assessment (OWASP Top 10 indicators).',
  intrusiveness: 'active_safe',
  budgetRequests: 60,
  budgetSeconds: 300,
  costCapUsd: 2,
});

/**
 * `smoke`: checks the web sign-in wiring, then runs the assessment flow end to end on the internal API hop with two
 * seeded identities (separation of duties), and exits 1 on any failure.
 */
async function smoke() {
  const token = parseEnvFile(ENV_FILE).BW_DEMO_INTERNAL_TOKEN ?? '';
  if (token === '') fail('no internal token in .env.demo; run node scripts/blackwing.mjs first');
  const api = (user, method, route, body, roles) =>
    apiCall(token, user, method, route, body, roles);
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

  await check('API answers /health/live', async () => {
    const r = await fetch(`${API_ORIGIN}/health/live`);
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
    const r = await fetch(`${API_ORIGIN}/v1/demo/dashboard`);
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
    // Registering an origin that is already an asset (the lab registered by `up`) returns that asset.
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

  const failed = results.filter((r) => !r.ok);
  log(`${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length > 0) {
    log(`FAILED: ${failed.map((f) => f.name).join('; ')}`);
    process.exit(1);
  }
  log(`console: ${CONSOLE_ORIGIN} (sign in with Google)`);
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
  stepDatabase(baseEnv);
  stepMigrateAndSeed(baseEnv);
  const labUp = stepLab();
  // The tenant id is known only after the seed; the API and the hunt engine need it.
  const tenant = tenantId(baseEnv);
  if (tenant === '') fail(`the acme tenant is not in ${DB_NAME}; see the seed output above`);
  const env = stackEnv({ ...local, BW_DEMO_TENANT_ID: tenant });
  stepServices(env);
  const apiUp = waitFor('API', `${API_ORIGIN}/health/live`, 60_000);
  let labRegistered = false;
  if (labUp && apiUp && waitFor('lab', `http://127.0.0.1:${LAB_PORT}`, 120_000)) {
    labRegistered = await registerLab(local);
  }
  waitFor('web', `http://127.0.0.1:${WEB_PORT}/login`, 120_000);
  printSummary(env, labRegistered);
}

await main();
