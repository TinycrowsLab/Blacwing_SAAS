import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { parseArgs, CORE_SERVICES } from './compose-smoke.mjs';
import { COMPOSE_FILE, PROJECT, ensureEnv, main, renderEnv } from './dev-deps.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const COMPOSE_DIR = path.dirname(COMPOSE_FILE);

const DUMMY_ENV = {
  BW_DEV_POSTGRES_SUPERUSER_PASSWORD: 'x-super',
  BW_DEV_POSTGRES_APP_PASSWORD: 'x-app',
  BW_DEV_POSTGRES_MIGRATOR_PASSWORD: 'x-migrator',
  BW_DEV_VALKEY_PASSWORD: 'x-valkey',
  BW_DEV_NEO4J_PASSWORD: 'x-neo4j-pass',
  BW_DEV_MINIO_ROOT_PASSWORD: 'x-minio-root',
  BW_DEV_MINIO_APP_PASSWORD: 'x-minio-app-secret',
};

/**
 * Renders the compose file with `docker compose config` (the canonical lint).
 * @param {Record<string, string>} env
 */
function renderCompose(env) {
  const clean = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith('BW_DEV_')),
  );
  return spawnSync(
    'docker',
    [
      'compose',
      '-p',
      PROJECT,
      '--env-file',
      '/dev/null',
      '-f',
      COMPOSE_FILE,
      'config',
      '--format',
      'json',
    ],
    { encoding: 'utf8', env: { ...clean, ...env } },
  );
}

/**
 * @typedef {{ host_ip?: string, published?: string, target: number }} Port
 * @typedef {{ image: string, restart?: string, container_name?: string, ports?: Port[],
 *   networks?: Record<string, unknown>, environment?: Record<string, string>,
 *   healthcheck?: { test: string[], start_period?: string } }} Service
 * @typedef {{ name: string, services: Record<string, Service>,
 *   networks: Record<string, { name: string, driver: string } | undefined>, volumes: Record<string, unknown> }} Compose
 */

/** @param {Record<string, string>} [extra] @returns {Compose} */
function config(extra = {}) {
  const res = renderCompose({ ...DUMMY_ENV, ...extra });
  assert.equal(res.status, 0, res.stderr);
  /** @type {unknown} */
  const parsed = JSON.parse(res.stdout);
  return /** @type {Compose} */ (parsed);
}

/** @param {string | undefined} d e.g. "1m0s", "20s" */
function seconds(d) {
  const m = /^(?:(\d+)m)?(?:(\d+)s)?$/.exec(d ?? '');
  return m ? Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0) : 0;
}

describe('docker-compose.dev.yml (DEVENV-002)', () => {
  const c = config();

  it('is one shared project with the bw-dev network and named volumes', () => {
    assert.equal(c.name, 'bwdev');
    const net = c.networks['bw-dev'];
    assert.ok(net, 'bw-dev network');
    assert.equal(net.name, 'bw-dev');
    assert.equal(net.driver, 'bridge');
    for (const v of ['pgdata', 'valkeydata', 'neo4jdata']) assert.ok(v in c.volumes, v);
  });

  it('defines the core data services', () => {
    for (const s of CORE_SERVICES) assert.ok(c.services[s], s);
  });

  it('pins every image by tag and digest, restarts unless-stopped, no container_name', () => {
    for (const [name, s] of Object.entries(c.services)) {
      assert.match(s.image, /^[\w./-]+:[\w.-]+@sha256:[0-9a-f]{64}$/, `${name} image not pinned`);
      assert.equal(s.restart, name === 'minio-init' ? 'no' : 'unless-stopped', name);
      assert.equal(s.container_name, undefined, `${name} must not set container_name`);
      assert.ok(s.networks && 'bw-dev' in s.networks, `${name} not on bw-dev`);
    }
  });

  it('uses the fixed host-port map, bound to 127.0.0.1 only', () => {
    /** @type {Record<string, Record<number, string>>} */
    const expected = {
      postgres: { 5432: '15432' },
      valkey: { 6379: '16379' },
      minio: { 9000: '19000', 9001: '19001' },
      neo4j: { 7474: '17474', 7687: '17687' },
    };
    for (const [svc, map] of Object.entries(expected)) {
      const ports = c.services[svc]?.ports ?? [];
      assert.equal(ports.length, Object.keys(map).length, svc);
      for (const p of ports) {
        assert.equal(p.host_ip, '127.0.0.1', `${svc}:${String(p.target)} must bind loopback`);
        assert.equal(p.published, map[p.target], `${svc}:${String(p.target)}`);
      }
    }
  });

  it('edge case: port already in use -> host ports are overridable via env', () => {
    const o = config({
      BW_DEV_POSTGRES_PORT: '25432',
      BW_DEV_VALKEY_PORT: '26379',
      BW_DEV_NEO4J_HTTP_PORT: '27474',
      BW_DEV_NEO4J_BOLT_PORT: '27687',
      BW_DEV_MINIO_PORT: '29000',
      BW_DEV_MINIO_CONSOLE_PORT: '29001',
    });
    const published = Object.values(o.services).flatMap((s) =>
      (s.ports ?? []).map((p) => p.published),
    );
    assert.deepEqual(published.sort(), ['25432', '26379', '27474', '27687', '29000', '29001']);
  });

  it('has healthchecks with generous start_period (slow hosts)', () => {
    /** @type {Record<string, RegExp>} */
    const probe = { postgres: /pg_isready/, valkey: /valkey-cli .*ping/, neo4j: /cypher-shell/ };
    for (const [svc, re] of Object.entries(probe)) {
      const hc = c.services[svc]?.healthcheck;
      assert.ok(hc, `${svc} healthcheck`);
      assert.match(hc.test.join(' '), re);
      assert.ok(seconds(hc.start_period) >= 20, `${svc} start_period ${String(hc.start_period)}`);
    }
  });

  it('edge case: Neo4j memory pressure -> heap and pagecache are bounded', () => {
    const env = c.services.neo4j?.environment ?? {};
    assert.equal(env.NEO4J_server_memory_heap_max__size, '1g');
    assert.ok(env.NEO4J_server_memory_pagecache_size);
  });

  it('refuses to start without dev credentials (never a default password)', () => {
    for (const key of Object.keys(DUMMY_ENV)) {
      const env = Object.fromEntries(Object.entries(DUMMY_ENV).filter(([k]) => k !== key));
      const res = renderCompose(env);
      assert.notEqual(res.status, 0, `${key} missing should fail`);
      assert.match(res.stderr, new RegExp(key));
    }
  });

  it('edge case: extension missing in base image -> image bundles pgvector; init creates both', () => {
    assert.match(c.services.postgres?.image ?? '', /^pgvector\/pgvector:[\w.-]*pg16@/);
    const init = readFileSync(
      path.join(COMPOSE_DIR, 'postgres/init/01-extensions-and-roles.sh'),
      'utf8',
    );
    assert.match(init, /CREATE EXTENSION IF NOT EXISTS vector;/);
    assert.match(init, /CREATE EXTENSION IF NOT EXISTS pgcrypto;/);
  });

  it('creates an app role and a separate migration owner, neither with BYPASSRLS', () => {
    const init = readFileSync(
      path.join(COMPOSE_DIR, 'postgres/init/01-extensions-and-roles.sh'),
      'utf8',
    );
    const roles = init.match(/CREATE ROLE [^;]+;/g) ?? [];
    assert.equal(roles.length, 2);
    for (const r of roles) {
      assert.match(r, /NOBYPASSRLS/);
      assert.match(r, /NOSUPERUSER/);
    }
    const code = init.replace(/^\s*(#|--).*$/gm, '').replace(/NOBYPASSRLS/g, '');
    assert.doesNotMatch(code, /BYPASSRLS/, 'nothing may grant BYPASSRLS');
    assert.match(init, /OWNER TO :"migrator_role"/);
  });

  it('installs a Neo4j tenantId guard and gates health on its verification', () => {
    const guard = readFileSync(
      path.join(COMPOSE_DIR, 'neo4j/bootstrap/tenant-guard.cypher'),
      'utf8',
    );
    assert.match(guard, /n\.tenantId IS NULL/);
    assert.match(guard, /BW_TENANT_REQUIRED/);
    assert.match(guard, /BW_TENANT_IMMUTABLE/);
    assert.match(guard, /phase: 'before'/);
    const idx = readFileSync(
      path.join(COMPOSE_DIR, 'neo4j/bootstrap/tenant-indexes.cypher'),
      'utf8',
    );
    assert.match(idx, /CREATE INDEX \w+ IF NOT EXISTS FOR \(n:\w+\) ON \(n\.tenantId\)/);
    assert.match((c.services.neo4j?.healthcheck?.test ?? []).join(' '), /bw-tenant-guard\.ok/);
    const start = readFileSync(path.join(COMPOSE_DIR, 'neo4j/bootstrap/start.sh'), 'utf8');
    // `RETURN 1` is rejected by the system database: readiness must probe a user database.
    assert.match(start, /cs -d neo4j 'RETURN 1'/);
    assert.doesNotMatch(start, /cs -d system 'RETURN/);
    assert.match(start, /BW_TENANT_REQUIRED/);
  });
});

describe('.env handling', () => {
  it('fills empty passwords with random values and keeps other defaults', () => {
    let n = 0;
    const { text, added } = renderEnv(
      '# c\nA_PORT=1\nB_PASSWORD=\nC_PASSWORD=keep\nD=\n',
      '',
      () => `r${String((n += 1))}`,
    );
    assert.deepEqual(added, ['A_PORT', 'B_PASSWORD', 'C_PASSWORD', 'D']);
    assert.match(text, /^A_PORT=1$/m);
    assert.match(text, /^B_PASSWORD=r1$/m);
    assert.match(text, /^C_PASSWORD=keep$/m);
    assert.match(text, /^D=$/m);
  });

  it('never overwrites existing values and only appends missing keys', () => {
    const { text, added } = renderEnv('A=1\nB_PASSWORD=\n', 'B_PASSWORD=mine', () => 'new');
    assert.deepEqual(added, ['A']);
    assert.equal(text, 'B_PASSWORD=mine\nA=1\n');
    assert.deepEqual(renderEnv('A=1\n', 'A=2\n').added, []);
  });

  it('generates distinct 32-hex passwords', () => {
    const { text } = renderEnv('X_PASSWORD=\nY_PASSWORD=\n');
    const vals = [...text.matchAll(/_PASSWORD=([0-9a-f]+)$/gm)].map((m) => m[1]);
    assert.equal(vals.length, 2);
    assert.notEqual(vals[0], vals[1]);
    for (const v of vals) assert.equal(v?.length, 32);
  });

  it('.env.example covers every variable the compose file requires, with empty secrets', () => {
    const example = readFileSync(path.join(ROOT, '.env.example'), 'utf8');
    const compose = readFileSync(COMPOSE_FILE, 'utf8');
    const used = new Set([...compose.matchAll(/\$\{(BW_DEV_[A-Z0-9_]+)/g)].map((m) => m[1]));
    for (const v of used) assert.match(example, new RegExp(`^${String(v)}=`, 'm'), String(v));
    for (const m of example.matchAll(/^(BW_DEV_\w+_PASSWORD)=(.*)$/gm))
      assert.equal(m[2], '', `${String(m[1])} must be empty`);
  });

  it('writes a missing .env with mode 0600', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'bw-env-'));
    try {
      const file = path.join(dir, '.env');
      assert.ok(ensureEnv(file).includes('BW_DEV_POSTGRES_APP_PASSWORD'));
      assert.equal(statSync(file).mode & 0o777, 0o600);
      writeFileSync(file, readFileSync(file, 'utf8'));
      assert.deepEqual(ensureEnv(file), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('dev-deps CLI', () => {
  it('edge case: volume from an older schema -> reset needs explicit --yes', () => {
    assert.equal(main(['reset']), 2);
  });

  it('rejects unknown commands', () => {
    assert.equal(main(['explode']), 2);
  });

  it('compose-smoke parses its arguments', () => {
    assert.deepEqual(parseArgs(['--project', 'p', '--env-file', '/tmp/e', '--up']), {
      envFile: '/tmp/e',
      project: 'p',
      up: true,
    });
    assert.throws(() => parseArgs(['--bogus']), /unknown/);
  });
});
