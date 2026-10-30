#!/usr/bin/env node
// Build-time installer for the bw-sandbox toolchain (IMAGE-002, #601). Runs once in the image's `tools`
// stage: `node install-tools.mjs <scanners.pin.json> <dir-with-wrappers>`. Every download is fetched,
// checked against its pinned sha256 (or the Go module zip hash) and only then unpacked. Any mismatch,
// HTTP error or failing version probe throws, so the build fails. Node built-ins only; no npm install.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EXEC_MODE = 0o755;
const EX_USAGE = 64;
const FETCH_ATTEMPTS = 3;
const FETCH_RETRY_DELAY_MS = 500;
// A stalled connection must not hang the build: each attempt is aborted after this long, then retried.
const FETCH_TIMEOUT_MS = 300_000;
const PROBE_TIMEOUT_MS = 120_000;
const DIGEST_HEX = /^[0-9a-f]{64}$/;
const GO_ZIP_HASH = /^h1:[A-Za-z0-9+/]+=*$/;
/**
 * Parses JSON text. The result is `unknown`, so callers must narrow it with a cast before use.
 * @param {string} text
 * @returns {unknown}
 */
const parseJson = (text) => JSON.parse(text);

/** @type {Readonly<Record<string, string | undefined>>} */
const ARCH_BY_PLATFORM = Object.freeze({ x64: 'amd64', arm64: 'arm64' });

/**
 * @param {Uint8Array} bytes
 * @returns {string} lowercase hex sha256
 */
export function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Fails closed when the downloaded bytes do not match the pinned digest.
 * @param {Uint8Array} bytes
 * @param {string} expected
 * @param {string} label
 */
export function assertDigest(bytes, expected, label) {
  if (!DIGEST_HEX.test(expected)) throw new Error(`${label}: pinned sha256 is malformed`);
  const actual = sha256Hex(bytes);
  if (actual !== expected) {
    throw new Error(`${label}: sha256 mismatch (pinned ${expected}, downloaded ${actual})`);
  }
}

/**
 * Retries transient network failures (connection resets, DNS blips) with a short linear backoff. HTTP
 * status errors are not retried here: the caller turns them into a failed build.
 * @param {string} url
 * @param {(url: string) => Promise<Response>} fetchImpl
 * @returns {Promise<Response>}
 */
async function fetchWithRetry(url, fetchImpl) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fetchImpl(url);
    } catch (err) {
      if (attempt >= FETCH_ATTEMPTS) throw err;
      await new Promise((resolve) => setTimeout(resolve, FETCH_RETRY_DELAY_MS * attempt));
    }
  }
}

/**
 * @param {string} url
 * @param {string} expected
 * @param {string} label
 * @param {(url: string) => Promise<Response>} [fetchImpl]
 * @returns {Promise<Uint8Array>}
 */
export async function fetchVerified(
  url,
  expected,
  label,
  fetchImpl = (u) => fetch(u, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }),
) {
  let res;
  try {
    res = await fetchWithRetry(url, fetchImpl);
  } catch (err) {
    const cause =
      err instanceof Error && err.cause instanceof Error ? `: ${err.cause.message}` : '';
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`${label}: network error fetching ${url} (${reason}${cause})`, { cause: err });
  }
  if (!res.ok) throw new Error(`${label}: HTTP ${res.status} fetching ${url}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  assertDigest(bytes, expected, label);
  return bytes;
}

/**
 * @param {string} name
 * @param {string[]} args
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv }} [opts]
 * @returns {string} stdout + stderr
 */
function run(name, args, opts = {}) {
  // stdin is closed (empty input) and every child is time-boxed, so a tool that waits for input or a
  // network peer fails the build instead of hanging it (testssl.sh --version reaches for openssl s_client).
  const r = spawnSync(name, args, {
    encoding: 'utf8',
    input: '',
    timeout: PROBE_TIMEOUT_MS,
    ...opts,
  });
  const out = [r.stdout, r.stderr].join('');
  if (r.status !== 0)
    throw new Error(`${name} ${args.join(' ')} failed (${r.status}): ${out.trim()}`);
  return out;
}

/**
 * @param {{ name: string, artifacts?: Record<string, { url: string, sha256: string }> }} tool
 * @param {string} arch amd64 | arm64
 */
export function selectArtifact(tool, arch) {
  const artifact = tool.artifacts?.[arch] ?? tool.artifacts?.all;
  if (!artifact) throw new Error(`${tool.name}: no pinned artifact for ${arch}`);
  return artifact;
}

/**
 * Classifies a downloaded file by its name: `tar.gz` and `zip` archives are unpacked, anything else is a raw file.
 * @param {string} archiveName basename of the downloaded file
 * @returns {'tar.gz' | 'zip' | 'raw'}
 */
export function archiveFormat(archiveName) {
  if (archiveName.endsWith('.tar.gz')) return 'tar.gz';
  if (archiveName.endsWith('.zip')) return 'zip';
  return 'raw';
}

/**
 * @typedef {{
 *   name: string, version: string, licence: string, source: string, entrypoint: string,
 *   versionArgs: string[],
 *   install: { kind: string, member?: string, entry?: string, shim?: boolean, module?: string, package?: string, zipHash?: string },
 *   artifacts?: Record<string, { url: string, sha256: string }>
 * }} PinnedTool
 */

/**
 * @param {{ tools: PinnedTool[], binDir: string, libDir: string }} pins
 * @param {{ arch: string, workDir: string, srcDir: string, fetchImpl?: (u: string) => Promise<Response> }} ctx
 */
async function installAll(pins, ctx) {
  const binDir = pins.binDir;
  const libDir = pins.libDir;
  mkdirSync(binDir, { recursive: true });
  mkdirSync(libDir, { recursive: true });
  const manifest = [];
  for (const tool of pins.tools) {
    const entry = await installTool(tool, { ...ctx, binDir, libDir });
    manifest.push(entry);
  }
  // The wrapper that is the only way to reach sqlmap (raw sqlmap stays under lib/, never on PATH).
  const wrapper = path.join(ctx.srcDir, 'bw-sqlmap.mjs');
  const wrapperDst = path.join(binDir, 'bw-sqlmap');
  copyFileSync(wrapper, wrapperDst);
  chmodSync(wrapperDst, EXEC_MODE);
  manifest.push({ name: 'bw-sqlmap', kind: 'wrapper', version: 'source', licence: 'GPL-2.0-only' });
  return manifest;
}

/**
 * @param {PinnedTool} tool
 * @param {{ arch: string, workDir: string, binDir: string, libDir: string, fetchImpl?: (u: string) => Promise<Response> }} ctx
 */
export async function installTool(tool, ctx) {
  const kind = tool.install.kind;
  if (kind === 'go') return installGo(tool, ctx);
  const artifact = selectArtifact(tool, ctx.arch);
  const label = `${tool.name} ${tool.version}`;
  const bytes = await fetchVerified(artifact.url, artifact.sha256, label, ctx.fetchImpl);
  const work = mkdtempSync(path.join(ctx.workDir, `${tool.name}-`));
  const archive = path.join(work, path.basename(new URL(artifact.url).pathname));
  writeFileSync(archive, bytes);
  const format = archiveFormat(archive);

  if (kind === 'binary') {
    if (format !== 'raw') throw new Error(`${label}: binary artifact must not be an archive`);
    installExecutable(archive, path.join(ctx.binDir, tool.entrypoint));
  } else if (kind === 'archive') {
    if (format !== 'tar.gz' && format !== 'zip') {
      throw new Error(`${label}: archive kind needs a tar.gz or zip artifact`);
    }
    const member = tool.install.member;
    if (!member) throw new Error(`${label}: archive kind needs install.member`);
    const dst = path.join(work, 'x');
    mkdirSync(dst);
    if (format === 'zip') {
      run('unzip', ['-q', '-o', '-j', archive, member, '-d', dst]);
    } else {
      run('tar', ['-xzf', archive, '-C', dst]);
    }
    installExecutable(path.join(dst, member), path.join(ctx.binDir, tool.entrypoint));
  } else if (kind === 'tree') {
    if (format !== 'tar.gz') throw new Error(`${label}: tree kind needs a tar.gz artifact`);
    const entry = tool.install.entry;
    if (!entry) throw new Error(`${label}: tree kind needs install.entry`);
    const dst = path.join(ctx.libDir, tool.name);
    mkdirSync(dst, { recursive: true });
    run('tar', ['-xzf', archive, '-C', dst, '--strip-components=1']);
    const target = path.join(dst, entry);
    chmodSync(target, EXEC_MODE);
    // Only tools with a shim get a PATH entry; a tree without one is reached through its wrapper (sqlmap).
    if (tool.install.shim) {
      const shim = path.join(ctx.binDir, tool.entrypoint);
      writeFileSync(shim, `#!/bin/sh\nexec "${target}" "$@"\n`);
      chmodSync(shim, EXEC_MODE);
    }
  } else {
    throw new Error(`${label}: unknown install kind ${kind}`);
  }
  const probe = probeVersion(tool, ctx.binDir);
  return {
    name: tool.name,
    version: tool.version,
    licence: tool.licence,
    kind,
    arch: ctx.arch,
    sha256: artifact.sha256,
    probe,
  };
}

/**
 * Go tools are built from the module proxy with `go install`, after the module zip hash is checked against
 * the pinned h1 value. The Go checksum database (GOSUMDB) also verifies the module; the pin is the second check.
 * @param {PinnedTool} tool
 * @param {{ workDir: string, binDir: string }} ctx
 */
function installGo(tool, ctx) {
  const { module, package: pkg, zipHash } = tool.install;
  const label = `${tool.name} ${tool.version}`;
  if (!module || !pkg || !zipHash)
    throw new Error(`${label}: go kind needs module, package and zipHash`);
  if (!GO_ZIP_HASH.test(zipHash)) throw new Error(`${label}: pinned zipHash is malformed`);
  const env = {
    ...process.env,
    CGO_ENABLED: '0',
    GOTOOLCHAIN: 'local',
    GOBIN: ctx.binDir,
    GOPATH: path.join(ctx.workDir, 'gopath'),
    GOCACHE: path.join(ctx.workDir, 'gocache'),
    GOFLAGS: '-mod=readonly',
  };
  const spec = `${module}@${tool.version.startsWith('v') ? tool.version : `v${tool.version}`}`;
  const info = /** @type {{ Sum?: string }} */ (
    parseJson(run('go', ['mod', 'download', '-json', spec], { env, cwd: ctx.workDir }))
  );
  if (info.Sum !== zipHash) {
    throw new Error(
      `${label}: module zip hash mismatch (pinned ${zipHash}, downloaded ${String(info.Sum)})`,
    );
  }
  run('go', ['install', '-trimpath', `${pkg}@${spec.slice(module.length + 1)}`], {
    env,
    cwd: ctx.workDir,
  });
  const built = path.join(ctx.binDir, path.basename(pkg));
  const renamed = path.join(ctx.binDir, tool.entrypoint);
  if (built !== renamed) renameSync(built, renamed);
  const modInfo = run('go', ['version', '-m', renamed], { env });
  if (!modInfo.includes(`mod\t${module}\tv${tool.version.replace(/^v/, '')}`)) {
    throw new Error(`${label}: built binary does not report module ${module} v${tool.version}`);
  }
  return {
    name: tool.name,
    version: tool.version,
    licence: tool.licence,
    kind: 'go',
    arch: undefined,
    sha256: zipHash,
    probe: 'go version -m',
  };
}

/**
 * @param {string} src
 * @param {string} dst
 */
function installExecutable(src, dst) {
  copyFileSync(src, dst);
  chmodSync(dst, EXEC_MODE);
}

/**
 * Each tool must answer its version probe after install, so a broken or wrong binary fails the build.
 * @param {PinnedTool} tool
 * @param {string} binDir
 */
function probeVersion(tool, binDir) {
  if (tool.install.kind === 'tree' && !tool.install.shim) return 'wrapper-only';
  const exe = path.join(binDir, tool.entrypoint);
  if (tool.versionArgs.length === 0) return 'none';
  const out = run(exe, tool.versionArgs);
  if (!out.includes(tool.version)) {
    throw new Error(`${tool.name}: version probe did not report ${tool.version}: ${out.trim()}`);
  }
  return out.trim().split('\n')[0] ?? '';
}

/**
 * @param {string} pinFile
 * @param {string} srcDir
 * @param {{ arch?: string, fetchImpl?: (u: string) => Promise<Response> }} [opts]
 */
async function main(pinFile, srcDir, opts = {}) {
  const pins = /** @type {{ binDir: string, tools: PinnedTool[], libDir: string }} */ (
    parseJson(readFileSync(pinFile, 'utf8'))
  );
  const arch = opts.arch ?? ARCH_BY_PLATFORM[process.arch];
  if (!arch) throw new Error(`unsupported platform ${process.arch}`);
  const workDir = mkdtempSync(path.join(tmpdir(), 'bw-tools-'));
  const manifest = await installAll(pins, {
    arch,
    workDir,
    srcDir,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });
  const root = path.dirname(pins.binDir);
  writeFileSync(
    path.join(root, 'manifest.json'),
    `${JSON.stringify({ arch, tools: manifest }, null, 2)}\n`,
  );
  return manifest;
}

/** @param {Array<unknown>} installed */
function onInstalled(installed) {
  process.stdout.write(`installed ${installed.length} tools\n`);
}

/** @param {unknown} err */
function onFailed(err) {
  const message = err instanceof Error ? err.message : String(err);
  const cause =
    err instanceof Error && err.cause instanceof Error ? ` (cause: ${err.cause.message})` : '';
  process.stderr.write(`install-tools: ${message}${cause}\n`);
  process.exit(1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const [pinFile, srcDir] = process.argv.slice(2);
  if (!pinFile || !srcDir) {
    process.stderr.write('usage: install-tools.mjs <scanners.pin.json> <srcDir>\n');
    process.exit(EX_USAGE);
  }
  main(pinFile, srcDir).then(onInstalled, onFailed);
}
