#!/usr/bin/env node
// Smoke test for the core data services of the dev stack (DEVENV-002, #156).
//
//   node scripts/compose-smoke.mjs [--env-file .env] [--project bwdev] [--up]
//
// Asserts, against the running compose project:
//   1. postgres, valkey and neo4j are healthy;
//   2. the `vector` (pgvector) and `pgcrypto` extensions are installed;
//   3. the app role cannot BYPASSRLS (and is not a superuser); the migration owner is separate;
//   4. Neo4j rejects a node without tenantId, and rejects removing or changing a tenantId;
//   5. `valkey-cli ping` returns PONG;
//   6. MinIO is healthy, the buckets exist with object lock + versioning, the WORM and scoped-key
//      properties hold (infra/compose/minio/verify.sh, DEVENV-006);
//   7. Mailpit receives SMTP mail; interactsh rejects anonymous and accepts token-authenticated
//      registration + poll (DEVENV-008).
// Exits non-zero on the first failed check. Never prints credentials.

import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const COMPOSE_FILE = path.join(ROOT, 'infra/compose/docker-compose.dev.yml');
export const CORE_SERVICES = Object.freeze(['postgres', 'valkey', 'neo4j']);
export const OBJECT_STORE_SERVICES = Object.freeze(['minio', 'minio-init']);
export const OOB_MAIL_SERVICES = Object.freeze(['mailpit', 'interactsh']);

/**
 * @param {string[]} argv
 * @returns {{ envFile: string, project: string, up: boolean }}
 */
export function parseArgs(argv) {
  const opts = { envFile: path.join(ROOT, '.env'), project: 'bwdev', up: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--up') opts.up = true;
    else if (arg === '--env-file' && next) {
      opts.envFile = path.resolve(next);
      i += 1;
    } else if (arg === '--project' && next) {
      opts.project = next;
      i += 1;
    } else throw new Error(`unknown or incomplete argument: ${String(arg)}`);
  }
  return opts;
}

/**
 * @param {{ envFile: string, project: string }} opts
 * @param {string[]} args
 */
function compose(opts, args) {
  return execFileSync(
    'docker',
    ['compose', '-p', opts.project, '--env-file', opts.envFile, '-f', COMPOSE_FILE, ...args],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  ).trim();
}

/**
 * @param {{ envFile: string, project: string }} opts
 * @param {string} service
 * @param {string} script shell script run inside the container (env vars expanded there)
 */
function exec(opts, service, script) {
  return compose(opts, ['exec', '-T', service, 'sh', '-c', script]);
}

/**
 * Runs `fn`, expecting it to throw with output containing `needle`.
 * @param {() => unknown} fn
 * @param {string} needle
 */
function expectRejected(fn, needle) {
  try {
    fn();
  } catch (error) {
    const e = /** @type {{ stdout?: string, stderr?: string }} */ (error);
    const out = `${e.stdout ?? ''}${e.stderr ?? ''}`;
    if (out.includes(needle)) return;
    throw new Error(`rejected, but without ${needle}`, { cause: error });
  }
  throw new Error(`expected rejection (${needle}) but the write succeeded`);
}

/** @param {{ envFile: string, project: string, up: boolean }} opts */
export function smoke(opts) {
  /** @type {string[]} */
  const passed = [];
  /** @param {string} name @param {boolean} ok */
  const check = (name, ok) => {
    if (!ok) throw new Error(`FAIL: ${name}`);
    passed.push(name);
    process.stdout.write(`ok - ${name}\n`);
  };

  if (opts.up)
    compose(opts, [
      'up',
      '-d',
      '--wait',
      '--wait-timeout',
      '300',
      ...CORE_SERVICES,
      ...OBJECT_STORE_SERVICES,
      ...OOB_MAIL_SERVICES,
    ]);

  for (const svc of [...CORE_SERVICES, ...OBJECT_STORE_SERVICES, ...OOB_MAIL_SERVICES]) {
    const id = compose(opts, ['ps', '-q', svc]);
    const health = execFileSync('docker', ['inspect', '-f', '{{.State.Health.Status}}', id], {
      encoding: 'utf8',
    }).trim();
    check(`${svc} is healthy`, health === 'healthy');
  }

  const psql = (/** @type {string} */ sql) =>
    exec(opts, 'postgres', `psql -XtA -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "${sql}"`);
  const ext = psql(`SELECT string_agg(extname, ',' ORDER BY extname) FROM pg_extension`).split(',');
  check('postgres has pgvector (vector) extension', ext.includes('vector'));
  check('postgres has pgcrypto extension', ext.includes('pgcrypto'));
  const roles = psql(
    `SELECT rolname || ':' || rolbypassrls || ':' || rolsuper FROM pg_roles WHERE rolname IN ('$BW_APP_ROLE', '$BW_MIGRATOR_ROLE') ORDER BY rolname`,
  ).split('\n');
  check('app and migration-owner roles both exist', roles.length === 2);
  check(
    'no app/migrator role can BYPASSRLS or is superuser',
    roles.every((r) => r.endsWith(':false:false')),
  );
  const owner = psql(
    `SELECT pg_get_userbyid(datdba) = '$BW_MIGRATOR_ROLE' FROM pg_database WHERE datname = current_database()`,
  );
  check('database is owned by the migration owner, not the app role', owner === 't');
  const appBypass = exec(
    opts,
    'postgres',
    `PGPASSWORD="$BW_APP_PASSWORD" psql -XtA -h 127.0.0.1 -U "$BW_APP_ROLE" -d "$POSTGRES_DB" -c "SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user"`,
  );
  check('app role (logged in as itself) reports rolbypassrls = false', appBypass === 'f');
  expectRejected(
    () =>
      exec(
        opts,
        'postgres',
        `PGPASSWORD="$BW_APP_PASSWORD" psql -XtA -v ON_ERROR_STOP=1 -h 127.0.0.1 -U "$BW_APP_ROLE" -d "$POSTGRES_DB" -c "ALTER ROLE $BW_APP_ROLE BYPASSRLS"`,
      ),
    'permission denied',
  );
  check('app role cannot grant itself BYPASSRLS', true);

  const cypher = (/** @type {string} */ q) =>
    exec(opts, 'neo4j', `cypher-shell -u neo4j -p "$BW_NEO4J_PASSWORD" -d neo4j "${q}"`);
  expectRejected(() => cypher('CREATE (n:Asset {id: \\"smoke-1\\"})'), 'BW_TENANT_REQUIRED');
  check('neo4j rejects a node without tenantId', true);
  expectRejected(
    () => cypher('CREATE (n:Asset {id: \\"smoke-2\\", tenantId: \\"  \\"})'),
    'BW_TENANT_REQUIRED',
  );
  check('neo4j rejects a blank tenantId', true);
  cypher('MERGE (n:BwSmoke {id: \\"smoke-3\\", tenantId: \\"t-smoke\\"})');
  expectRejected(
    () => cypher('MATCH (n:BwSmoke {id: \\"smoke-3\\"}) REMOVE n.tenantId'),
    'BW_TENANT_IMMUTABLE',
  );
  check('neo4j rejects removing tenantId', true);
  expectRejected(
    () => cypher('MATCH (n:BwSmoke {id: \\"smoke-3\\"}) SET n.tenantId = \\"t-other\\"'),
    'BW_TENANT_IMMUTABLE',
  );
  check('neo4j rejects changing tenantId', true);
  cypher('MATCH (n:BwSmoke {id: \\"smoke-3\\"}) DETACH DELETE n');
  check('neo4j allows deleting a tenant-scoped node', true);
  const idx = cypher(
    'SHOW INDEXES YIELD name, properties WHERE \\"tenantId\\" IN properties RETURN count(*) AS c',
  );
  check('neo4j has tenantId indexes', Number(idx.split('\n').at(-1)) >= 1);

  const pong = exec(opts, 'valkey', 'REDISCLI_AUTH="$BW_VALKEY_PASSWORD" valkey-cli ping');
  check('valkey-cli ping returns PONG', pong === 'PONG');
  const aof = exec(
    opts,
    'valkey',
    'REDISCLI_AUTH="$BW_VALKEY_PASSWORD" valkey-cli config get appendonly',
  );
  check('valkey appendonly persistence is on', aof.split('\n').at(-1) === 'yes');
  const anon = exec(opts, 'valkey', 'valkey-cli ping 2>&1 || true');
  check('valkey requires a password', anon.includes('NOAUTH'));

  const verify = compose(opts, ['exec', '-T', 'minio-init', '/bin/bash', '/bw/minio/verify.sh']);
  check('minio WORM, versioning and scoped-key checks pass', verify.includes('all checks passed'));

  // DEVENV-008: mail sent over SMTP shows up in the Mailpit API; interactsh accepts a token-authenticated
  // registration from a client. Both run inside the containers, so no host tools are needed.
  const subject = `bw-smoke-${String(Date.now())}`;
  // The Mailpit image is scratch (no shell): feed `mailpit sendmail` over stdin, read the API from the host.
  execFileSync(
    'docker',
    [
      'compose',
      '-p',
      opts.project,
      '--env-file',
      opts.envFile,
      '-f',
      COMPOSE_FILE,
      'exec',
      '-T',
      'mailpit',
      '/mailpit',
      'sendmail',
      '-S',
      '127.0.0.1:1025',
      '-f',
      'a@bw.test',
      'b@bw.test',
    ],
    {
      input: `From: a@bw.test\r\nTo: b@bw.test\r\nSubject: ${subject}\r\n\r\nhi\r\n`,
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  const uiPort = compose(opts, ['port', 'mailpit', '8025']).split(':').at(-1);
  const mails = execFileSync(
    'curl',
    ['-fsS', `http://127.0.0.1:${String(uiPort)}/api/v1/messages`],
    { encoding: 'utf8' },
  );
  check('mailpit receives an SMTP message and lists it via its API', mails.includes(subject));

  const unauth = exec(
    opts,
    'interactsh',
    `wget -S -qO- --post-data '{}' http://127.0.0.1:80/register 2>&1 | head -1 || true`,
  );
  check('interactsh rejects an unauthenticated registration', /401|403/.test(unauth));

  // A client registers with the token and polls its correlation id (what packages/oob will do).
  const token =
    /^BW_DEV_INTERACTSH_TOKEN=(.+)$/m.exec(readFileSync(opts.envFile, 'utf8'))?.[1] ?? '';
  const ishPort = compose(opts, ['port', 'interactsh', '80']).split(':').at(-1);
  const ishUrl = `http://127.0.0.1:${String(ishPort)}`;
  const { publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const cid = randomBytes(10).toString('hex');
  const secret = randomUUID();
  // The token goes in over stdin (`-H @-`) so it never shows up in the process list.
  const ish = (/** @type {string[]} */ args) =>
    execFileSync('curl', ['-fsS', '-H', '@-', ...args], {
      encoding: 'utf8',
      input: `Authorization: ${token}\n`,
    });
  const reg = ish([
    '-H',
    'Content-Type: application/json',
    '--data',
    JSON.stringify({
      'public-key': Buffer.from(publicKey).toString('base64'),
      'secret-key': secret,
      'correlation-id': cid,
    }),
    `${ishUrl}/register`,
  ]);
  check(
    'interactsh accepts a token-authenticated registration',
    reg.includes('registration successful'),
  );
  const poll = ish([`${ishUrl}/poll?id=${cid}&secret=${secret}`]);
  check('interactsh answers a poll for the registered correlation id', poll.includes('"data"'));

  return passed;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const passed = smoke(parseArgs(process.argv.slice(2)));
    process.stdout.write(`\n${String(passed.length)} checks passed\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
