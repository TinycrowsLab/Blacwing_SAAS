#!/usr/bin/env node
// Assembles images.json (CI-007, #141): service -> ghcr.io/tinycrowslab/bw-<service>@sha256:...
// from the per-service digest files the build matrix uploads. Fails unless every service in the
// matrix has a well-formed digest, and never emits bw-sandbox (IMAGE-012 owns that image).
//
// Usage: node scripts/build-images-json.mjs --digests <dir> --out <file> [--summary <file>]

import { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { REGISTRY, SERVICES } from './check-images.mjs';

const DIGEST = /^sha256:[0-9a-f]{64}$/;

/**
 * @param {Record<string, string>} digests service -> digest
 * @returns {Record<string, string>} service -> pinned reference
 */
export function buildImagesJson(digests) {
  /** @type {Record<string, string>} */
  const images = {};
  for (const service of SERVICES) {
    const digest = (digests[service] ?? '').trim();
    if (!DIGEST.test(digest)) {
      throw new Error(`missing or malformed digest for ${service}`);
    }
    images[service] = `${REGISTRY}/bw-${service}@${digest}`;
  }
  const extra = Object.keys(digests).filter((s) => !SERVICES.includes(s));
  if (extra.length > 0) throw new Error(`unexpected service digest(s): ${extra.join(', ')}`);
  return images;
}

/** @param {Record<string, string>} images @returns {string} */
export function summaryTable(images) {
  const rows = Object.entries(images).map(([s, ref]) => `| ${s} | \`${ref}\` |`);
  return ['### Container images', '', '| Service | Reference |', '| --- | --- |', ...rows, ''].join(
    '\n',
  );
}

/** @param {string[]} argv */
export function main(argv) {
  const arg = (/** @type {string} */ name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const dir = arg('--digests');
  const out = arg('--out');
  if (dir === undefined || out === undefined || !existsSync(dir)) {
    process.stderr.write(
      'usage: build-images-json --digests <dir> --out <file> [--summary <file>]\n',
    );
    return 2;
  }
  /** @type {Record<string, string>} */
  const digests = {};
  for (const f of readdirSync(dir)) digests[f] = readFileSync(path.join(dir, f), 'utf8');
  try {
    const images = buildImagesJson(digests);
    writeFileSync(out, `${JSON.stringify(images, null, 2)}\n`);
    const summary = arg('--summary');
    if (summary !== undefined) appendFileSync(summary, summaryTable(images));
    return 0;
  } catch (e) {
    process.stderr.write(`build-images-json: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exitCode = main(process.argv.slice(2));
}
