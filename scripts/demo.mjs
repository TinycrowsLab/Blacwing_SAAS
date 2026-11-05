#!/usr/bin/env node
// `pnpm demo`: one command to bring up a localhost demo of the Blackwing console (DEMO-001).
//
//   node scripts/demo.mjs            # start everything (idempotent)
//   node scripts/demo.mjs status     # show what is running
//   node scripts/demo.mjs smoke      # run the story end to end against the live stack (exit 1 on any failure)
//   node scripts/demo.mjs stop       # stop api, worker, demo runner and web started by this script
//   node scripts/demo.mjs google     # only the Google identity provider in Keycloak (scripts/keycloak-google-idp.mjs)
//
// Steps, in order (each one is safe to re-run):
//   1. dependency stack (`pnpm dev:deps` when Postgres or Keycloak is not healthy), then the Google identity
//      provider when BW_DEV_GOOGLE_CLIENT_ID/SECRET are set (optional: a warning otherwise, never a failure)
//   2. (no target is started: register any URL in the console; `node scripts/demo.mjs lab` starts an optional local lab)
//   3. demo database `blackwing_demo` (the shared dev database is migrated by other worktrees)
//   4. migrations, then the dev seed (`pnpm db:seed`, which skips tables that are not merged yet)
//   5. API (127.0.0.1:13400, BW_DEMO_MODE=1 mounts the demo story routes), worker, demo runner and web
//      (DEMO_HOST, default 127.0.0.1, port 3000). The demo API seeds the lab asset and one finished fallback run.
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

// Optional local lab for trying the tool (`node scripts/demo.mjs lab`). Never used by the platform itself.
const LAB_CONTAINER = 'bw-demo-lab';
const LAB_IMAGE = process.env.DEMO_LAB_IMAGE ?? 'bkimminich/juice-shop';
const LAB_PORT = Number(process.env.DEMO_LAB_PORT ?? 3001);
const LAB_CONTAINER_PORT = Number(process.env.DEMO_LAB_CONTAINER_PORT ?? 3000);
// Public origin for a hosted demo (e.g. http://<ec2-ip>:3000). Defaults to localhost.
const PUBLIC_ORIGIN = (process.env.DEMO_PUBLIC_ORIGIN ?? '').replace(/\/$/, '');
const DEMO_DB = 'blackwing_demo';
const WEB_PORT = Number(process.env.DEMO_WEB_PORT ?? 3000);
const API_PORT = Number(process.env.DEMO_API_PORT ?? 13400);
const WORKER_HEALTH_PORT = 13800;
const DEMO_API_ORIGIN = `http://127.0.0.1:${API_PORT}`;
const DEMO_USERS = {
  requester: 'appsec@acme.test',
  approver: 'owner@acme.test',
};

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
  const generated = {
    BW_WEB_SESSION_SECRET: existing.BW_WEB_SESSION_SECRET ?? randomBytes(48).toString('base64url'),
    BW_WEB_SESSION_SECRET_PREVIOUS: existing.BW_WEB_SESSION_SECRET_PREVIOUS ?? '',
    BW_CONSOLE_ORIGIN: PUBLIC_ORIGIN || (existing.BW_CONSOLE_ORIGIN ?? `http://localhost:${WEB_PORT}`),
    BW_DEMO_INTERNAL_TOKEN:
      existing.BW_DEMO_INTERNAL_TOKEN ?? randomBytes(32).toString('base64url'),
  };
  const changed = Object.keys(generated).some((k) => existing[k] !== generated[k]);
  if (!changed) return { ...existing, ...generated };
  const body = Object.entries(generated)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  writeFileSync(
    DEMO_ENV_FILE,
    `# Demo-only overrides written by scripts/demo.mjs. Gitignored. Dev only.\n${body}\n`,
    { mode: 0o600 },
  );
  log('wrote .env.demo (demo-only session secret and internal token)');
  return { ...existing, ...generated };
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
    WEB_ORIGIN: demo.BW_CONSOLE_ORIGIN,
    BW_CONSOLE_ORIGIN: demo.BW_CONSOLE_ORIGIN,
    // dev lets the hunt engine use the host's Claude login when no ANTHROPIC_API_KEY is set (local demo only).
    BW_ENV: process.env.BW_ENV ?? base.BW_ENV ?? 'dev',
    NEXT_PUBLIC_API_BASE_URL: '/v1',
    // DEMO-STORY: the demo story routes are mounted in the API only in demo mode.
    BW_DEMO_MODE: '1',
    BW_DEMO_INTERNAL_TOKEN: demo.BW_DEMO_INTERNAL_TOKEN,
    BW_DEMO_API_ORIGIN: DEMO_API_ORIGIN,
    BW_DEMO_TENANT_ID: demo.BW_DEMO_TENANT_ID ?? '',
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

/**
 * Upserts the Google identity provider in Keycloak. Exit 0 when the client is not configured (the script prints
 * the instructions). Returns the script's exit status; `up` treats a failure as a warning.
 */
function stepGoogle() {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'keycloak-google-idp.mjs')], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  return r.status ?? 1;
}

function stepLab() {
  if (dockerRunning(LAB_CONTAINER)) {
    log(`lab already running on http://127.0.0.1:${LAB_PORT}`);
    return;
  }
  spawnSync('docker', ['rm', '-f', LAB_CONTAINER], { stdio: 'ignore' });
  log(`starting lab ${LAB_IMAGE} on http://127.0.0.1:${LAB_PORT}`);
  const r = spawnSync(
    'docker',
    ['run', '-d', '--name', LAB_CONTAINER, '-p', `127.0.0.1:${LAB_PORT}:${LAB_CONTAINER_PORT}`, LAB_IMAGE],
    { stdio: 'inherit' },
  );
  if (r.status !== 0) fail('could not start the lab container');
  log(`lab is up: register http://127.0.0.1:${LAB_PORT} as a target in the console`);
}

function psqlSuper(sql, env, database = 'blackwing') {
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
      database,
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

/** Returns the demo tenant id (the seeded `acme` tenant) from the demo database, or '' when not seeded yet. */
function demoTenantId(env) {
  const r = psqlSuper("select id from tenants where slug = 'acme'", env, DEMO_DB);
  return r.status === 0 ? r.stdout.trim() : '';
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
    // AI hunt engine: polls the demo database for queued runs and runs the Claude agent team against the run's scope.
    ['demo-runner', 'apps/worker', ['tsx', 'src/demo/main.ts']],
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

  Console        ${env.BW_CONSOLE_ORIGIN}   (bound to ${host}:${WEB_PORT})
  Keycloak redirect URI to allow: ${env.BW_CONSOLE_ORIGIN}/api/auth/callback
  API            http://127.0.0.1:${API_PORT}/health
  Keycloak       ${kc}/realms/blackwing-dev

Demo users (Keycloak realm blackwing-dev, password from .env BW_DEV_KEYCLOAK_TEST_USER_PASSWORD):
  requester (operator)   appsec@acme.test
  approver               owner@acme.test
  viewer                 auditor@acme.test
  password               ${pw.startsWith('(') ? pw : '<BW_DEV_KEYCLOAK_TEST_USER_PASSWORD from .env>'}

Story (click by click in docs/runbooks/demo.md):
  Start here     http://localhost:${WEB_PORT}/demo
  Assets         http://localhost:${WEB_PORT}/demo/assets
  New request    http://localhost:${WEB_PORT}/demo/requests/new
  Optional lab   node scripts/demo.mjs lab   (then register its URL as a target)
  Check it       node scripts/demo.mjs smoke

Logs: ${LOG_DIR}   Stop: node scripts/demo.mjs stop
`);
}

/**
 * `pnpm demo smoke`: runs the story end to end against the live stack and exits 1 on any failure. It calls the demo
 * API with the internal token and the two demo identities (the same identity the web sends after Keycloak login), and
 * checks the web gate, the SoD refusal, the run, the finding, the reports and the repro on the lab target.
 */
const smokeRequest = (assetId) => ({
  assetId,
  objective: 'Smoke test: short black-box web assessment (OWASP Top 10 indicators).',
  intrusiveness: 'active_safe',
  budgetRequests: 60,
  budgetSeconds: 300,
  costCapUsd: 2,
});

async function smoke() {
  const demoFile = parseEnvFile(DEMO_ENV_FILE);
  const token = demoFile.BW_DEMO_INTERNAL_TOKEN ?? '';
  if (token === '') fail('no demo token in .env.demo; run pnpm demo first');
  const api = async (user, method, route, body, roles) => {
    const headers = { accept: 'application/json', 'x-bw-demo-token': token };
    if (user !== undefined) headers['x-bw-demo-user'] = user;
    if (roles !== undefined) headers['x-bw-demo-roles'] = roles;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(`${DEMO_API_ORIGIN}/v1/demo${route}`, {
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
  };
  const requester = { user: DEMO_USERS.requester, roles: 'appsec-engineer' };
  const approver = { user: DEMO_USERS.approver, roles: 'asset-owner' };
  const results = [];
  const check = async (name, fn) => {
    try {
      const detail = await fn();
      results.push({ ok: true, name, detail: detail ?? '' });
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
  if (target === '') fail('set DEMO_SMOKE_TARGET to an authorised target URL (e.g. the optional lab: node scripts/demo.mjs lab)');

  await check('API answers /health/live', async () => {
    const r = await fetch(`${DEMO_API_ORIGIN}/health/live`);
    expect(r.status === 200, `HTTP ${r.status}`);
  });
  await check('web: /demo redirects to login when signed out', async () => {
    const r = await fetch(`http://127.0.0.1:${WEB_PORT}/demo`, { redirect: 'manual' });
    expect(r.status >= 300 && r.status < 400, `HTTP ${r.status}`);
    expect((r.headers.get('location') ?? '').includes('/login'), 'no /login redirect');
  });
  await check('demo API refuses a call without the internal token', async () => {
    const r = await fetch(`${DEMO_API_ORIGIN}/v1/demo/dashboard`);
    expect(r.status === 401, `HTTP ${r.status}`);
  });
  await check('requester registers the target', async () => {
    const r = await api(requester.user, 'POST', '/assets', { name: `Smoke target ${new URL(target).host}`, baseUrl: target }, requester.roles);
    expect(r.status === 201 || r.status === 200, `HTTP ${r.status} ${r.json.code ?? ''}`);
    ctx.assetId = r.json.id;
  });
  await check('request refused while the target is unverified', async () => {
    const r = await api(requester.user, 'POST', '/requests', smokeRequest(ctx.assetId), requester.roles);
    expect(r.status >= 400, `HTTP ${r.status}`);
  });
  await check('asset owner attests ownership', async () => {
    const r = await api(approver.user, 'POST', `/assets/${ctx.assetId}/verify`, { method: 'owner_attestation', statement: 'Smoke test: lab target owned by the demo team.' }, approver.roles);
    expect(r.status === 200, `HTTP ${r.status} ${r.json.code ?? ''}`);
  });
  await check('request created for Gate 1 (requester)', async () => {
    const r = await api(requester.user, 'POST', '/requests', smokeRequest(ctx.assetId), requester.roles);
    expect(r.status === 201 || r.status === 200, `HTTP ${r.status} ${r.json.code ?? ''}`);
    ctx.requestId = r.json.id;
  });
  await check('Gate 1 refuses the requester (separation of duties)', async () => {
    const r = await api(requester.user, 'POST', `/requests/${ctx.requestId}/decision`, { decision: 'approve' }, 'appsec-engineer,asset-owner');
    expect(r.status === 403 || r.status === 409, `HTTP ${r.status}`);
  });
  await check('Gate 1 approved by the asset owner', async () => {
    const r = await api(approver.user, 'POST', `/requests/${ctx.requestId}/decision`, { decision: 'approve' }, approver.roles);
    expect(r.status === 200, `HTTP ${r.status} ${r.json.code ?? ''}`);
  });
  await check('run started by the requester', async () => {
    const r = await api(requester.user, 'POST', `/requests/${ctx.requestId}/runs`, undefined, requester.roles);
    expect(r.status === 201 || r.status === 200, `HTTP ${r.status} ${r.json.code ?? ''}`);
    ctx.runId = r.json.id;
  });
  await check('run reaches a terminal state with work from at least two agents', async () => {
    const deadline = Date.now() + 8 * 60_000;
    let run;
    while (Date.now() < deadline) {
      run = (await api(requester.user, 'GET', `/runs/${ctx.runId}?afterSeq=0`, undefined, requester.roles)).json;
      if (['completed', 'failed', 'killed'].includes(run.state)) break;
      await new Promise((r) => setTimeout(r, 5000));
    }
    expect(run?.state === 'completed', `state ${run?.state} ${JSON.stringify(run?.events?.at(-1)?.data ?? {})}`);
    const agents = new Set((run.events ?? []).map((e) => e.data?.agent).filter(Boolean));
    expect(agents.size >= 2, `agents seen: ${[...agents].join(',')}`);
    return `${run.stats?.httpSent ?? 0} requests, ${run.findings?.length ?? 0} findings, $${run.costUsd}`;
  });

  const failed = results.filter((r) => !r.ok);
  log(`${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length > 0) {
    log(`FAILED: ${failed.map((f) => f.name).join('; ')}`);
    process.exit(1);
  }
  log(
    `story URLs: http://localhost:${WEB_PORT}/demo  (sign in as ${DEMO_USERS.requester}, then ${DEMO_USERS.approver})`,
  );
}

function status() {
  const pids = loadPids();
  for (const name of ['api', 'worker', 'demo-runner', 'web']) {
    const pid = pids[name];
    log(`${name}: ${pid && alive(pid) ? `running (pid ${pid})` : 'not running'}`);
  }
  log(`lab: ${dockerRunning(LAB_CONTAINER) ? `running on 127.0.0.1:${LAB_PORT}` : 'not running'}`);
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
  if (cmd === 'smoke') return smoke();
  if (cmd === 'google') process.exit(stepGoogle());
  if (cmd === 'lab') return stepLab();
  if (cmd !== 'up') fail(`unknown command ${cmd} (use up, status, smoke, stop, lab or google)`);

  const demo = ensureDemoEnv();
  const baseEnv = demoEnv(demo);
  if (baseEnv.BW_DEV_POSTGRES_SUPERUSER === undefined)
    fail('.env is missing; run pnpm dev:deps first');
  stepDeps(baseEnv);
  if (stepGoogle() !== 0)
    log('Google sign-in is not set up (see the message above); the normal sign-in still works');
  stepDatabase(baseEnv);
  stepMigrateAndSeed(baseEnv);
  // The tenant id is known only after the seed; the demo API and runner need it.
  const tenantId = demoTenantId(baseEnv);
  if (tenantId === '')
    fail('the demo tenant acme is not in blackwing_demo; see the seed output above');
  const env = demoEnv({ ...demo, BW_DEMO_TENANT_ID: tenantId });
  stepServices(env);
  waitFor('API', `http://127.0.0.1:${API_PORT}/health/live`, 60_000);
  waitFor('web', `http://127.0.0.1:${WEB_PORT}/login`, 120_000);
  printSummary(env);
}

await main();
