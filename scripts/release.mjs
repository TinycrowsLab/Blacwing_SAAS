#!/usr/bin/env node
// Release helpers (CI-016, #150).
//
//   plan    Computes the next semantic version from the Conventional Commits since the last v* tag,
//           with the same analyzer rules as release.config.mjs, and never tags or writes anything
//           except an optional step summary. Used by the pull-request dry run.
//   record  Joins a released version with images.json (service -> ghcr.io/...@sha256:...) into
//           release-record.json, failing unless every image is pinned by digest. This is the
//           versioning anchor for §8.9 (runs record exact versions).
//
// Usage:
//   node scripts/release.mjs plan   [--cwd <repo>] [--summary <file>] [--github-output <file>]
//   node scripts/release.mjs record --version <x.y.z> --commit <sha> --images <file> --out <file> [--summary <file>]

import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { analyzeCommits } from '@semantic-release/commit-analyzer';

import { ANALYZER } from '../release.config.mjs';

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const DIGEST_REF = /^[a-z0-9./_-]+@sha256:[0-9a-f]{64}$/;
const PARTS = 3; // major.minor.patch
const FIRST_RELEASE = '1.0.0';
const SEP = '\u001e';
const END = '\u001f';

/**
 * @param {string} version x.y.z
 * @param {'major' | 'minor' | 'patch'} type
 * @returns {string} next version
 */
export function bump(version, type) {
  const m = SEMVER.exec(version);
  if (m === null) throw new Error(`not a semantic version: ${version}`);
  const [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (type === 'major') return `${String(major + 1)}.0.0`;
  if (type === 'minor') return `${String(major)}.${String(minor + 1)}.0`;
  return `${String(major)}.${String(minor)}.${String(patch + 1)}`;
}

/**
 * @param {string} cwd repository
 * @param {string[]} args version-control arguments
 * @returns {string} stdout
 */
function vcs(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/**
 * Highest v<semver> tag reachable from HEAD, or null before the first release.
 * @param {string} cwd
 * @returns {string | null} tag name
 */
export function lastReleaseTag(cwd) {
  const tags = vcs(cwd, ['tag', '--merged', 'HEAD', '--list', 'v*'])
    .split('\n')
    .map((t) => t.trim())
    .filter((t) => TAG.test(t));
  /** @param {string} t */
  const key = (t) => (TAG.exec(t) ?? []).slice(1).map(Number);
  tags.sort((a, b) => {
    const [ka, kb] = [key(a), key(b)];
    for (let i = 0; i < PARTS; i++) if (ka[i] !== kb[i]) return (ka[i] ?? 0) - (kb[i] ?? 0);
    return 0;
  });
  return tags.at(-1) ?? null;
}

/**
 * @typedef {{ current: string | null, next: string | null, type: string | null, commits: number }} Plan
 */

/**
 * Computes the next version for the commits since the last release tag.
 * @param {string} cwd repository
 * @returns {Promise<Plan>} plan; next is null when no commit is releasable
 */
export async function plan(cwd) {
  const tag = lastReleaseTag(cwd);
  const range = tag === null ? 'HEAD' : `${tag}..HEAD`;
  const raw = vcs(cwd, ['log', range, `--format=%H${SEP}%B${END}`]);
  const commits = raw
    .split(END)
    .map((c) => c.trim())
    .filter((c) => c !== '')
    .map((c) => {
      const [hash, message] = c.split(SEP);
      return { hash: hash ?? '', message: message ?? '' };
    });
  const type = await analyzeCommits(
    { ...ANALYZER },
    { cwd, commits, logger: { log: () => undefined } },
  );
  const current = tag === null ? null : tag.slice(1);
  if (type === null || type === undefined) {
    return { current, next: null, type: null, commits: commits.length };
  }
  const level = /** @type {'major' | 'minor' | 'patch'} */ (type);
  const next = current === null ? FIRST_RELEASE : bump(current, level);
  return { current, next, type, commits: commits.length };
}

/**
 * @param {Plan} p
 * @returns {string} markdown for the step summary
 */
export function planSummary(p) {
  const head = '### Release dry run\n\n';
  const since = p.current === null ? 'the start of history' : `v${p.current}`;
  if (p.next === null) {
    return `${head}No releasable commits (feat, fix, perf, revert or breaking) since ${since}. Merging releases nothing; no tag is created.\n`;
  }
  return `${head}Merging would release **v${p.next}** (${p.type ?? ''} bump since ${since}, ${String(p.commits)} commits). This is a dry run: no tag, changelog commit or GitHub Release is created.\n`;
}

/**
 * @param {string} version x.y.z
 * @param {string} commit sha
 * @param {unknown} images parsed images.json
 * @returns {{ version: string, tag: string, commit: string, images: Record<string, string> }} record
 */
export function buildRecord(version, commit, images) {
  if (!SEMVER.test(version)) throw new Error(`not a semantic version: ${version}`);
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error('commit must be a full 40-character sha');
  if (typeof images !== 'object' || images === null || Array.isArray(images)) {
    throw new Error('images.json must be an object of service -> reference');
  }
  /** @type {Record<string, string>} */
  const pinned = {};
  for (const [service, ref] of Object.entries(images)) {
    if (typeof ref !== 'string' || !DIGEST_REF.test(ref)) {
      throw new Error(`image ${service} is not pinned by sha256 digest`);
    }
    pinned[service] = ref;
  }
  if (Object.keys(pinned).length === 0) throw new Error('images.json lists no images');
  return { version, tag: `v${version}`, commit, images: pinned };
}

/**
 * @param {{ version: string, tag: string, commit: string, images: Record<string, string> }} r
 * @returns {string} markdown
 */
export function recordSummary(r) {
  const rows = Object.entries(r.images).map(([s, ref]) => `| ${s} | \`${ref}\` |`);
  return [
    `### Release ${r.tag}`,
    '',
    `Commit \`${r.commit}\``,
    '',
    '| Service | Image (digest-pinned) |',
    '| --- | --- |',
    ...rows,
    '',
  ].join('\n');
}

/**
 * @param {string[]} argv
 * @returns {Record<string, string>} flags
 */
function flags(argv) {
  /** @type {Record<string, string>} */
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i] ?? '';
    const v = argv[i + 1];
    if (!k.startsWith('--') || v === undefined) throw new Error(`bad argument: ${k}`);
    out[k.slice(2)] = v;
  }
  return out;
}

/**
 * @param {string[]} argv
 * @returns {Promise<number>} exit code
 */
export async function main(argv) {
  const [cmd, ...rest] = argv;
  try {
    const f = flags(rest);
    if (cmd === 'plan') {
      const p = await plan(f.cwd ?? process.cwd());
      const text = planSummary(p);
      process.stdout.write(text);
      if (f.summary !== undefined) appendFileSync(f.summary, text);
      if (f['github-output'] !== undefined) {
        appendFileSync(
          f['github-output'],
          `next=${p.next ?? ''}\nreleasable=${String(p.next !== null)}\n`,
        );
      }
      return 0;
    }
    if (cmd === 'record') {
      const missing = ['version', 'commit', 'images', 'out'].filter((k) => f[k] === undefined);
      if (missing.length > 0) throw new Error(`missing --${missing.join(', --')}`);
      const images = /** @type {unknown} */ (JSON.parse(readFileSync(f.images ?? '', 'utf8')));
      const rec = buildRecord(f.version ?? '', f.commit ?? '', images);
      writeFileSync(f.out ?? '', `${JSON.stringify(rec, null, 2)}\n`);
      if (f.summary !== undefined) appendFileSync(f.summary, recordSummary(rec));
      return 0;
    }
    throw new Error('usage: release.mjs plan | record');
  } catch (error) {
    process.stderr.write(`release: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
