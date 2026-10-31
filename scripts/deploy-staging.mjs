#!/usr/bin/env node
// Staging deploy helper (CI-017, #151). Used by .github/workflows/deploy-staging.yml.
//
//   resolve  Reads the release record (release-record.json, written by release.yml) and the
//            images.json of one release tag, proves they agree (tag, version, commit and every
//            digest, recomputed with release.mjs buildRecord), and writes the deployment outputs
//            and the digest table for the run summary. Any mismatch fails closed: nothing deploys.
//
// Usage:
//   node scripts/deploy-staging.mjs resolve --tag <vX.Y.Z> --record <file> --images <file> \
//     [--github-output <file>] [--summary <file>]

import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { REGISTRY } from './check-images.mjs';
import { buildRecord, recordSummary } from './release.mjs';

const TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Proves that a release record and an images.json describe the same release, and returns the
 * canonical record (buildRecord re-checks the version, commit and digest pins).
 * @param {string} tag release tag, vX.Y.Z
 * @param {unknown} record parsed release-record.json
 * @param {unknown} images parsed images.json
 * @returns {{ version: string, tag: string, commit: string, images: Record<string, string> }}
 */
export function resolveDeployment(tag, record, images) {
  if (!TAG.test(tag)) throw new Error(`not a release tag (vX.Y.Z): ${tag}`);
  const version = tag.slice(1);
  if (!isRecord(record)) throw new Error('release-record.json must be a JSON object');
  if (record.tag !== tag)
    throw new Error(`release record is for ${String(record.tag)}, not ${tag}`);
  if (record.version !== version) throw new Error(`release record version is not ${version}`);
  if (typeof record.commit !== 'string') throw new Error('release record has no commit');
  if (!isRecord(record.images)) throw new Error('release record has no images');

  const expected = buildRecord(version, record.commit, images);
  for (const [service, ref] of Object.entries(expected.images)) {
    if (!ref.startsWith(`${REGISTRY}/bw-${service}@`)) {
      throw new Error(`image ${service} is not the bw-${service} image in ${REGISTRY}`);
    }
  }
  const recorded = record.images;
  const services = new Set([...Object.keys(expected.images), ...Object.keys(recorded)]);
  for (const service of services) {
    if (recorded[service] !== expected.images[service]) {
      throw new Error(`release record and images.json disagree on ${service}`);
    }
  }
  return expected;
}

/**
 * @param {string[]} argv
 * @returns {number} exit code
 */
function main(argv) {
  const [cmd, ...rest] = argv;
  try {
    if (cmd !== 'resolve') {
      throw new Error(
        'usage: deploy-staging.mjs resolve --tag <vX.Y.Z> --record <file> --images <file>',
      );
    }
    const { values } = parseArgs({
      args: rest,
      strict: true,
      options: {
        tag: { type: 'string' },
        record: { type: 'string' },
        images: { type: 'string' },
        'github-output': { type: 'string' },
        summary: { type: 'string' },
      },
    });
    const missing = [
      ['tag', values.tag],
      ['record', values.record],
      ['images', values.images],
    ]
      .filter(([, v]) => v === undefined)
      .map(([k]) => k);
    if (missing.length > 0) throw new Error(`missing --${missing.join(', --')}`);

    const tag = values.tag ?? '';
    const record = /** @type {unknown} */ (JSON.parse(readFileSync(values.record ?? '', 'utf8')));
    const images = /** @type {unknown} */ (JSON.parse(readFileSync(values.images ?? '', 'utf8')));
    const resolved = resolveDeployment(tag, record, images);

    if (values['github-output'] !== undefined) {
      appendFileSync(
        values['github-output'],
        `tag=${resolved.tag}\nversion=${resolved.version}\ncommit=${resolved.commit}\n`,
      );
    }
    if (values.summary !== undefined) appendFileSync(values.summary, recordSummary(resolved));
    return 0;
  } catch (error) {
    process.stderr.write(
      `deploy-staging: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exitCode = main(process.argv.slice(2));
}
