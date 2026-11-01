import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { parse } from 'yaml';

import { EVAL_COMPOSE, describeTarget, manifestFiles, upMetricLine } from './eval-targets.mjs';
import { TARGETS } from './targets.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * @param {string} rel
 * @returns {string}
 */
const readRepo = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

/**
 * @typedef {{ name: string, synthetic: boolean, service: string, baseUrl: string,
 *   source: { kind: string, image?: string, dockerfile?: string, baseImage?: string } }} Manifest
 * @typedef {{ image?: string, build?: { dockerfile?: string }, ports?: string[], networks?: string[],
 *   read_only?: boolean, cap_drop?: string[], privileged?: boolean }} Service
 * @typedef {{ name?: string, networks: Record<string, { external?: boolean }>,
 *   services: Record<string, Service> }} Compose
 */

/**
 * @param {string} dir
 * @returns {Manifest}
 */
const manifestOf = (dir) => {
  /** @type {unknown} */
  const doc = JSON.parse(readRepo(path.join('eval', 'targets', dir, 'target.json')));
  return /** @type {Manifest} */ (doc);
};

/**
 * Compose YAML with `<<` merge keys resolved (the labs share one hardening anchor).
 * @param {string} src
 * @returns {Compose}
 */
const parseCompose = (src) => {
  /** @type {unknown} */
  const doc = parse(src, { merge: true });
  return /** @type {Compose} */ (doc);
};

const PUBLIC = ['juice-shop', 'crapi', 'vampi', 'dvga', 'dvwa', 'webgoat'];
const SYNTHETIC = ['bola-api', 'ssrf-lab'];

describe('eval target bootstrap (EVAL-001)', () => {
  it('discovers every manifest under eval/targets in a stable order', () => {
    const files = manifestFiles(path.join(ROOT, 'eval', 'targets')).map((f) =>
      path.relative(ROOT, f),
    );
    assert.deepEqual(
      files,
      [...PUBLIC, `synthetic/${SYNTHETIC[0]}`, `synthetic/${SYNTHETIC[1]}`]
        .map((dir) => path.join('eval', 'targets', dir, 'target.json'))
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    );
  });

  it('records eval_targets_up as one JSON line counting every manifest it brings up', () => {
    const count = manifestFiles(path.join(ROOT, 'eval', 'targets')).length;
    assert.equal(count, PUBLIC.length + SYNTHETIC.length);
    assert.deepEqual(JSON.parse(upMetricLine(count)), { metric: 'eval_targets_up', value: count });
  });

  it('describes a registry target by its pinned image and a local lab by its base image', () => {
    const juice = describeTarget(path.join(ROOT, 'eval', 'targets', 'juice-shop', 'target.json'));
    assert.match(
      juice,
      /^juice-shop synthetic=false image=bkimminich\/juice-shop:v17\.1\.1@sha256:[0-9a-f]{64}$/,
    );
    const lab = describeTarget(
      path.join(ROOT, 'eval', 'targets', 'synthetic', 'bola-api', 'target.json'),
    );
    assert.match(
      lab,
      /^bola-api synthetic=true image=node:22\.23\.3-alpine@sha256:[0-9a-f]{64} \(built locally\)$/,
    );
  });

  it('every public target maps to a `targets` driver service on the same port and digest', () => {
    const dev = parseCompose(readRepo('infra/compose/docker-compose.dev.yml'));
    for (const name of PUBLIC) {
      const manifest = manifestOf(name);
      const driver = TARGETS.find((t) => t.service === manifest.service);
      assert.ok(
        driver,
        `${name}: service ${manifest.service} is not in scripts/targets.mjs TARGETS`,
      );
      assert.equal(new URL(manifest.baseUrl).port, String(driver.port), `${name}: port drift`);
      const composed = dev.services[manifest.service];
      assert.ok(composed, `${name}: ${manifest.service} missing from the dev compose`);
      assert.equal(composed.image, manifest.source.image, `${name}: digest drift vs infra/compose`);
    }
  });

  it('every synthetic lab is built from its Dockerfile on the pinned base recorded in its manifest', () => {
    const compose = parseCompose(readRepo(EVAL_COMPOSE));
    for (const name of SYNTHETIC) {
      const manifest = manifestOf(`synthetic/${name}`);
      assert.equal(manifest.source.kind, 'local');
      const service = compose.services[manifest.service];
      assert.ok(service, `${name}: ${manifest.service} missing from ${EVAL_COMPOSE}`);
      assert.equal(
        service.build?.dockerfile,
        manifest.source.dockerfile,
        `${name}: Dockerfile drift`,
      );
      const dockerfile = readRepo(manifest.source.dockerfile ?? '');
      assert.ok(
        dockerfile.includes(`ARG BASE_IMAGE=${manifest.source.baseImage}`),
        `${name}: Dockerfile base is not the digest in target.json`,
      );
    }
  });

  it('publishes each lab only on loopback with the port its manifest advertises', () => {
    const compose = parseCompose(readRepo(EVAL_COMPOSE));
    for (const name of SYNTHETIC) {
      const manifest = manifestOf(`synthetic/${name}`);
      const ports = compose.services[manifest.service]?.ports ?? [];
      assert.equal(ports.length, 1);
      const binding = String(ports[0]);
      assert.match(binding, /^127\.0\.0\.1:/, `${name} must publish on loopback only`);
      assert.match(
        binding,
        new RegExp(`:-${new URL(manifest.baseUrl).port}\\}:`),
        `${name}: port drift`,
      );
    }
  });

  it('keeps the labs on the shared target network only, never bw-dev, and hardened', () => {
    const compose = parseCompose(readRepo(EVAL_COMPOSE));
    assert.deepEqual(Object.keys(compose.networks), ['bw-targets']);
    assert.equal(compose.networks['bw-targets']?.external, true);
    for (const name of SYNTHETIC) {
      const service = compose.services[manifestOf(`synthetic/${name}`).service];
      assert.ok(service, name);
      assert.deepEqual(service.networks, ['bw-targets'], name);
      assert.equal(service.read_only, true, `${name} root filesystem must be read-only`);
      assert.deepEqual(service.cap_drop, ['ALL'], `${name} must drop all capabilities`);
      assert.equal(service.privileged, undefined, `${name} must not be privileged`);
    }
  });

  it('uses its own compose project so the targets driver and the dev stack never touch it', () => {
    const compose = parseCompose(readRepo(EVAL_COMPOSE));
    assert.equal(compose.name, 'bweval');
    assert.notEqual(compose.name, 'bwdev');
  });
});
