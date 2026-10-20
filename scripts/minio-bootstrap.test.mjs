import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { COMPOSE_FILE, PROJECT, renderEnv } from './dev-deps.mjs';

const MINIO_DIR = path.join(path.dirname(COMPOSE_FILE), 'minio');
const BOOTSTRAP = path.join(MINIO_DIR, 'bootstrap.sh');
const VERIFY = path.join(MINIO_DIR, 'verify.sh');
const read = (/** @type {string} */ f) => readFileSync(f, 'utf8');
const parseJson = (/** @type {string} */ t) => /** @type {unknown} */ (JSON.parse(t));

/**
 * @typedef {{ image: string, ports?: { host_ip?: string, published?: string, target: number }[],
 *   healthcheck?: { test: string[] }, environment?: Record<string, string>,
 *   depends_on?: Record<string, { condition: string }>, volumes?: { source: string, target: string, read_only?: boolean }[] }} Service
 */

/** @returns {Record<string, Service>} */
function services() {
  const clean = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith('BW_DEV_')),
  );
  const res = spawnSync(
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
    {
      encoding: 'utf8',
      env: {
        ...clean,
        BW_DEV_POSTGRES_SUPERUSER_PASSWORD: 'x',
        BW_DEV_POSTGRES_APP_PASSWORD: 'x',
        BW_DEV_POSTGRES_MIGRATOR_PASSWORD: 'x',
        BW_DEV_VALKEY_PASSWORD: 'x',
        BW_DEV_NEO4J_PASSWORD: 'x-neo4j-pass',
        BW_DEV_INTERACTSH_TOKEN: 'x-interactsh-token',
        BW_DEV_KEYCLOAK_ADMIN_PASSWORD: 'x-kc-admin',
        BW_DEV_KEYCLOAK_DB_PASSWORD: 'x-kc-db',
        BW_DEV_KEYCLOAK_TEST_USER_PASSWORD: 'x-kc-users',
        BW_DEV_KEYCLOAK_BFF_SECRET: 'x-kc-bff',
        BW_DEV_KEYCLOAK_API_SECRET: 'x-kc-api',
        BW_DEV_KEYCLOAK_CI_SECRET: 'x-kc-ci',
        BW_DEV_MINIO_ROOT_PASSWORD: 'x-minio-root',
        BW_DEV_MINIO_APP_PASSWORD: 'x-minio-app-secret',
      },
    },
  );
  assert.equal(res.status, 0, res.stderr);
  return /** @type {{ services: Record<string, Service> }} */ (parseJson(res.stdout)).services;
}

describe('DEVENV-006 MinIO dev buckets', () => {
  const s = services();
  const minio = /** @type {Service} */ (s.minio);
  const init = /** @type {Service} */ (s['minio-init']);

  it('runs MinIO pinned by digest on loopback 19000/19001 with a readiness healthcheck', () => {
    assert.match(minio.image, /@sha256:[0-9a-f]{64}$/);
    assert.match(init.image, /@sha256:[0-9a-f]{64}$/);
    const ports = Object.fromEntries((minio.ports ?? []).map((p) => [p.target, p]));
    assert.equal(ports[9000]?.published, '19000');
    assert.equal(ports[9001]?.published, '19001');
    assert.ok((minio.ports ?? []).every((p) => p.host_ip === '127.0.0.1'));
    assert.match((minio.healthcheck?.test ?? []).join(' '), /mc ready local/);
  });

  it('refuses to start without a root password (no default credentials)', () => {
    const res = spawnSync(
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
        '--quiet',
      ],
      {
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH ?? '',
          BW_DEV_POSTGRES_SUPERUSER_PASSWORD: 'x',
          BW_DEV_POSTGRES_APP_PASSWORD: 'x',
          BW_DEV_POSTGRES_MIGRATOR_PASSWORD: 'x',
          BW_DEV_VALKEY_PASSWORD: 'x',
          BW_DEV_NEO4J_PASSWORD: 'x-neo4j-pass',
          BW_DEV_INTERACTSH_TOKEN: 'x-interactsh-token',
          BW_DEV_KEYCLOAK_ADMIN_PASSWORD: 'x-kc-admin',
          BW_DEV_KEYCLOAK_DB_PASSWORD: 'x-kc-db',
          BW_DEV_KEYCLOAK_TEST_USER_PASSWORD: 'x-kc-users',
          BW_DEV_KEYCLOAK_BFF_SECRET: 'x-kc-bff',
          BW_DEV_KEYCLOAK_API_SECRET: 'x-kc-api',
          BW_DEV_KEYCLOAK_CI_SECRET: 'x-kc-ci',
        },
      },
    );
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /BW_DEV_MINIO_ROOT_PASSWORD|BW_DEV_MINIO_APP_PASSWORD/);
  });

  it('runs the bootstrap after MinIO is healthy and mounts the scripts read-only', () => {
    assert.equal(init.depends_on?.minio?.condition, 'service_healthy');
    const mount = init.volumes?.find((v) => v.target === '/bw/minio');
    assert.equal(mount?.read_only, true);
    assert.match((init.healthcheck?.test ?? []).join(' '), /bw-minio-bootstrap\.ok/);
  });

  it('generates dev credentials into .env without committing them', () => {
    const { text, added } = renderEnv(read(path.join(MINIO_DIR, '../../../.env.example')));
    assert.ok(added.includes('BW_DEV_MINIO_ROOT_PASSWORD'));
    assert.ok(added.includes('BW_DEV_MINIO_APP_PASSWORD'));
    assert.match(text, /^BW_DEV_MINIO_ROOT_PASSWORD=[0-9a-f]{32}$/m);
    assert.match(text, /^BW_DEV_MINIO_APP_PASSWORD=[0-9a-f]{32}$/m);
    const example = read(path.join(MINIO_DIR, '../../../.env.example'));
    assert.match(example, /^BW_DEV_MINIO_ROOT_PASSWORD=$/m);
    assert.match(example, /^BW_DEV_MINIO_APP_PASSWORD=$/m);
  });

  it('bootstrap creates the three buckets WITH object lock and enables versioning', () => {
    const src = read(BOOTSTRAP);
    assert.match(src, /BUCKETS=\(bw-evidence bw-reports bw-transcripts\)/);
    assert.match(src, /mb --with-lock/);
    assert.match(src, /version enable/);
    assert.match(src, /retention set --default/);
  });

  it('edge case: a bucket without object lock fails the run (lock cannot be added later)', () => {
    const src = read(BOOTSTRAP);
    assert.match(src, /FATAL: bucket \$b has no object lock/);
    assert.match(src, /exit 1/);
  });

  it('is idempotent: existing buckets and the policy attachment are skipped', () => {
    const src = read(BOOTSTRAP);
    assert.match(src, /exists \(skipped\)/);
    assert.match(src, /already attached \(skipped\)/);
  });

  it('rejects an invalid retention mode or period before touching MinIO', () => {
    const env = {
      PATH: process.env.PATH ?? '',
      MINIO_ROOT_USER: 'u',
      MINIO_ROOT_PASSWORD: 'p',
      BW_APP_ACCESS_KEY: 'a',
      BW_APP_SECRET_KEY: 's',
    };
    const mode = spawnSync('bash', [BOOTSTRAP], {
      encoding: 'utf8',
      env: { ...env, BW_RETENTION_MODE: 'NONE' },
    });
    assert.equal(mode.status, 2);
    const days = spawnSync('bash', [BOOTSTRAP], {
      encoding: 'utf8',
      env: { ...env, BW_RETENTION_DAYS: '0' },
    });
    assert.equal(days.status, 2);
    const creds = spawnSync('bash', [BOOTSTRAP], { encoding: 'utf8', env: { PATH: env.PATH } });
    assert.notEqual(creds.status, 0);
  });

  it('scoped app policy: object read/write on the three buckets only, never admin or version delete', () => {
    const policy =
      /** @type {{ Statement: { Effect: string, Action: string[], Resource: string[] }[] }} */ (
        parseJson(read(path.join(MINIO_DIR, 'policy-app.json')))
      );
    const allow = policy.Statement.filter((st) => st.Effect === 'Allow');
    const deny = policy.Statement.filter((st) => st.Effect === 'Deny');
    const allowed = allow.flatMap((st) => st.Action);
    assert.ok(allowed.includes('s3:GetObject') && allowed.includes('s3:PutObject'));
    assert.ok(!allowed.some((a) => a === 's3:*' || a.startsWith('admin:') || a.includes('Bypass')));
    assert.ok(!allowed.includes('s3:DeleteObjectVersion'));
    for (const st of allow) {
      assert.ok(
        st.Resource.every((r) => /^arn:aws:s3:::bw-(evidence|reports|transcripts)(\/\*)?$/.test(r)),
      );
    }
    const denied = deny.flatMap((st) => st.Action);
    for (const a of [
      's3:DeleteObjectVersion',
      's3:BypassGovernanceRetention',
      's3:PutBucketObjectLockConfiguration',
    ]) {
      assert.ok(denied.includes(a), a);
    }
  });

  it('shell scripts pass shellcheck', () => {
    const res = spawnSync('shellcheck', [BOOTSTRAP, VERIFY], { encoding: 'utf8' });
    if (res.error) return; // shellcheck not installed here; CI installs it
    assert.equal(res.status, 0, res.stdout);
  });

  it('verify.sh proves WORM, legal hold and least privilege', () => {
    const src = read(VERIFY);
    for (const needle of [
      'app key cannot delete a version',
      'root cannot delete a retained version',
      'held version even with governance bypass',
      'original version unchanged after overwrite',
      'app key cannot list users',
      'app key cannot change default retention',
    ]) {
      assert.ok(src.includes(needle), needle);
    }
  });
});
