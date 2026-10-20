import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { COMPOSE_FILE, PROJECT } from './dev-deps.mjs';
import {
  ALL_SERVICES,
  DEFAULT_SERVICES,
  TARGETS,
  TARGETS_NETWORK,
  TLS_EDGE_SERVICE,
  assertIsolated,
  networksOf,
  resolveEnv,
  selectTargets,
  targetUrl,
} from './targets.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');

const DUMMY_ENV = {
  BW_DEV_POSTGRES_SUPERUSER_PASSWORD: 'x-super',
  BW_DEV_POSTGRES_APP_PASSWORD: 'x-app',
  BW_DEV_POSTGRES_MIGRATOR_PASSWORD: 'x-migrator',
  BW_DEV_VALKEY_PASSWORD: 'x-valkey',
  BW_DEV_NEO4J_PASSWORD: 'x-neo4j-pass',
  BW_DEV_MINIO_ROOT_PASSWORD: 'x-minio-root',
  BW_DEV_MINIO_APP_PASSWORD: 'x-minio-app-secret',
  BW_DEV_INTERACTSH_TOKEN: 'x-interactsh-token',
};

/**
 * @typedef {{ host_ip?: string, published?: string }} Port
 * @typedef {{ image: string, container_name?: string, privileged?: boolean, volumes?: unknown[],
 *   ports?: Port[], networks?: Record<string, { aliases?: string[] } | null>,
 *   healthcheck?: { start_period?: string } }} Service
 * @typedef {{ services: Record<string, Service>,
 *   networks: Record<string, { name: string } | undefined> }} Compose
 */

/**
 * Renders the compose file with `docker compose config` (the canonical lint).
 * @param {string[]} profiles
 * @param {Record<string, string>} [extra]
 * @returns {Compose}
 */
function render(profiles, extra = {}) {
  const clean = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith('BW_')),
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
      ...profiles.flatMap((p) => ['--profile', p]),
      'config',
      '--format',
      'json',
    ],
    { encoding: 'utf8', env: { ...clean, ...DUMMY_ENV, ...extra } },
  );
  assert.equal(res.status, 0, res.stderr);
  /** @type {unknown} */
  const parsed = JSON.parse(res.stdout);
  return /** @type {Compose} */ (parsed);
}

describe('targets profile (DEVENV-012)', () => {
  const cfg = render(['targets']);
  const targetServices = Object.entries(cfg.services).filter(([name]) =>
    ALL_SERVICES.includes(name),
  );

  it('defines every required target and its sidecars', () => {
    for (const name of ['juice-shop', 'crapi', 'vampi', 'dvga', 'dvwa', 'webgoat']) {
      assert.ok(cfg.services[name], `${name} missing`);
    }
    assert.equal(targetServices.length, ALL_SERVICES.length);
  });

  it('is excluded from the default dev:deps stack', () => {
    const base = render([]);
    for (const name of ALL_SERVICES) assert.equal(base.services[name], undefined, name);
    assert.equal(base.networks[TARGETS_NETWORK], undefined);
  });

  it('pins every image by digest', () => {
    for (const [name, svc] of targetServices) {
      assert.match(svc.image, /@sha256:[0-9a-f]{64}$/, `${name}: ${svc.image}`);
    }
  });

  it('runs only on the dedicated bw-targets network, never bw-dev', () => {
    assert.equal(cfg.networks[TARGETS_NETWORK].name, 'bw-targets');
    for (const [name, svc] of targetServices) {
      assert.deepEqual(Object.keys(svc.networks ?? {}), [TARGETS_NETWORK], name);
    }
  });

  it('binds every published port to loopback only', () => {
    let published = 0;
    for (const [name, svc] of targetServices) {
      for (const p of svc.ports ?? []) {
        published += 1;
        assert.equal(p.host_ip, '127.0.0.1', `${name} exposes ${p.published}`);
      }
    }
    assert.equal(published, TARGETS.length);
  });

  it('uses the documented, distinct host ports and hostnames', () => {
    const ports = TARGETS.map((t) => t.port);
    assert.deepEqual(ports, [13000, 13010, 13020, 13030, 13040, 13050]);
    assert.equal(new Set(ports).size, ports.length);
    for (const t of TARGETS) {
      const svc = cfg.services[t.service];
      assert.equal(svc.ports?.[0]?.published, String(t.port), t.service);
      assert.ok(svc.networks?.[TARGETS_NETWORK]?.aliases?.includes(t.host), t.host);
      assert.ok(t.host.endsWith('.bw.localhost'));
    }
  });

  it('honours a port override (collision avoidance)', () => {
    const over = render(['targets'], { BW_TARGET_JUICE_SHOP_PORT: '23000' });
    assert.equal(over.services['juice-shop'].ports[0].published, '23000');
    assert.equal(
      targetUrl('juice-shop', { BW_TARGET_JUICE_SHOP_PORT: '23000' }),
      'http://127.0.0.1:23000',
    );
  });

  it('gives every published target a healthcheck (slow starts tolerated)', () => {
    for (const t of TARGETS) {
      const hc = cfg.services[t.service].healthcheck;
      assert.ok(hc, `${t.service} has no healthcheck`);
      assert.ok(hc.start_period, `${t.service} has no start_period`);
    }
  });

  it('lets only bw-targets members (targets and the TLS edge) on bw-targets: no bw-dev service bridges', () => {
    const full = render(['targets', 'targets-tls', 'tls', 'default']);
    const allowed = new Set([...ALL_SERVICES, TLS_EDGE_SERVICE]);
    for (const [name, svc] of Object.entries(full.services)) {
      const nets = Object.keys(svc.networks ?? { 'bw-dev': {} });
      if (nets.includes(TARGETS_NETWORK)) {
        assert.ok(allowed.has(name), `${name} joins bw-targets`);
        assert.deepEqual(nets, [TARGETS_NETWORK], `${name} must be on bw-targets only`);
      } else {
        assert.ok(!allowed.has(name), name);
      }
    }
    const edge = full.services[TLS_EDGE_SERVICE];
    assert.equal(
      edge.ports?.every((p) => p.host_ip === '127.0.0.1'),
      true,
    );
    assert.match(edge.image, /@sha256:[0-9a-f]{64}$/);
  });

  it('declares no container_name, privileged mode or docker socket', () => {
    for (const [name, svc] of targetServices) {
      assert.equal(svc.container_name, undefined, name);
      assert.notEqual(svc.privileged, true, name);
      assert.ok(!JSON.stringify(svc.volumes ?? []).includes('docker.sock'), name);
    }
  });

  it('maps each target to an asset type', () => {
    const types = Object.fromEntries(TARGETS.map((t) => [t.service, t.asset]));
    assert.deepEqual(types, {
      'juice-shop': 'web_app',
      crapi: 'api',
      vampi: 'api',
      dvga: 'graphql',
      dvwa: 'web_app',
      webgoat: 'web_app',
    });
  });
});

describe('port override from .env (compose parity)', () => {
  it('reads BW_TARGET_<NAME>_PORT from the .env file, shell wins', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'bw-targets-'));
    try {
      const file = path.join(dir, '.env');
      writeFileSync(file, 'BW_TARGET_JUICE_SHOP_PORT=23456\n# c\nBW_TARGET_DVWA_PORT="23457"\n');
      assert.equal(targetUrl('juice-shop', resolveEnv(file, {})), 'http://127.0.0.1:23456');
      assert.equal(targetUrl('dvwa', resolveEnv(file, {})), 'http://127.0.0.1:23457');
      const shell = { BW_TARGET_JUICE_SHOP_PORT: '24000' };
      assert.equal(targetUrl('juice-shop', resolveEnv(file, shell)), 'http://127.0.0.1:24000');
      assert.equal(targetUrl('vampi', resolveEnv(file, {})), 'http://127.0.0.1:13020');
      assert.equal(
        targetUrl('juice-shop', resolveEnv(path.join(dir, 'none'), {})),
        'http://127.0.0.1:13000',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('network isolation helpers', () => {
  const doc = (/** @type {string[]} */ nets) => [
    { NetworkSettings: { Networks: Object.fromEntries(nets.map((n) => [n, {}])) } },
  ];
  it('accepts exactly [bw-targets]', () => {
    assert.deepEqual(networksOf(doc(['bw-targets'])), ['bw-targets']);
    assertIsolated(networksOf(doc(['bw-targets'])));
  });
  it('rejects bw-dev membership or extra networks', () => {
    assert.throws(() => {
      assertIsolated(networksOf(doc(['bw-targets', 'bw-dev'])));
    });
    assert.throws(() => {
      assertIsolated(networksOf(doc(['bw-dev'])));
    });
    assert.throws(() => {
      assertIsolated(networksOf(doc([])));
    });
  });
});

describe('selectTargets', () => {
  it('defaults to Juice Shop only', () => {
    assert.deepEqual(selectTargets([]), [...DEFAULT_SERVICES]);
    assert.deepEqual(DEFAULT_SERVICES, ['juice-shop']);
  });
  it('--all selects every target', () => {
    assert.equal(selectTargets(['--all']).length, TARGETS.length);
  });
  it('rejects unknown targets (fail closed)', () => {
    assert.throws(() => selectTargets(['nope']), /unknown target/);
  });
});

describe('wiring', () => {
  it('exposes pnpm targets:up/down/reset and keeps them out of dev:deps', () => {
    /** @type {unknown} */
    const raw = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const pkg = /** @type {{ scripts: Record<string, string> }} */ (raw);
    assert.match(pkg.scripts['targets:up'], /targets\.mjs up/);
    assert.match(pkg.scripts['targets:down'], /targets\.mjs down/);
    assert.match(pkg.scripts['targets:reset'], /targets\.mjs reset/);
    assert.doesNotMatch(pkg.scripts['dev:deps'], /targets/);
  });
  it('documents ports in .env.example', () => {
    const env = readFileSync(path.join(ROOT, '.env.example'), 'utf8');
    for (const t of TARGETS) assert.match(env, new RegExp(`${t.portEnv}=${t.port}`));
  });
});
