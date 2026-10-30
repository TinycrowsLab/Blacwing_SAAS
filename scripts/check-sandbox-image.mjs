// Static guard for the bw-sandbox Dockerfile (IMAGE-001, #599) and its pinned ProjectDiscovery
// tools (IMAGE-002, #600). Pure text checks, no Docker. Asserts: digest-pinned base, builder/tools/runtime
// stages, fixed uid 10001 `bw` user, the final USER is `bw`, the standard /opt/bw + /etc/bw directories,
// root-owned tools, safe env defaults, a HEALTHCHECK, no secrets, OCI labels, and a complete
// tools.pin.json (exact versions, release URLs, sha256, MIT licence). Runtime behaviour is covered by
// check-sandbox-image.int.mjs.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkToolPins } from './check-sandbox-tools.mjs';

export const SANDBOX_DOCKERFILE = 'infra/docker/sandbox/Dockerfile';
export const SANDBOX_DOCKERIGNORE = 'infra/docker/sandbox/Dockerfile.dockerignore';
export const SANDBOX_TOOLS_PIN = 'infra/docker/sandbox/tools.pin.json';
export const SANDBOX_SCANNER_PINS = 'infra/docker/sandbox/scanners.pin.json';
export const REQUIRED_TOOLS = ['subfinder', 'dnsx', 'httpx', 'naabu', 'katana', 'nuclei'];
const SEMVER = /^\d+\.\d+\.\d+$/;
const SHA256 = /^[0-9a-f]{64}$/;
const DIGEST = /@sha256:[0-9a-f]{64}/;
const EXPECTED_STAGES = 4; // builder, gotool, tools, runtime
const ARG_PREFIX_LENGTH = 4; // "ARG "
const USER_PREFIX_LENGTH = 5; // "USER "

/** @param {string} text */
const instructions = (text) =>
  text
    .replace(/\\\n/g, ' ')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));

/**
 * @param {string} dockerfile
 * @param {string} dockerignore
 * @returns {string[]} error messages (empty when compliant)
 */
export function checkSandboxDockerfile(dockerfile, dockerignore) {
  const errors = [];
  const lines = instructions(dockerfile);
  /** @type {Map<string, string>} */
  const args = new Map();
  for (const l of lines.filter((x) => x.startsWith('ARG '))) {
    const [k = '', ...v] = l.slice(ARG_PREFIX_LENGTH).split('=');
    if (v.length > 0) args.set(k, v.join('='));
  }

  const nodeImage = args.get('NODE_IMAGE') ?? '';
  if (!DIGEST.test(nodeImage)) errors.push('NODE_IMAGE must be pinned by @sha256: digest');

  const froms = lines.filter((l) => l.startsWith('FROM '));
  if (froms.length !== EXPECTED_STAGES)
    errors.push('expected exactly four stages (builder, gotool, tools, runtime)');
  for (const f of froms) {
    const ref = f.split(/\s+/)[1] ?? '';
    const resolved = ref.replace(/\$\{(\w+)\}/g, (_, /** @type {string} */ k) => args.get(k) ?? '');
    if (!DIGEST.test(resolved)) errors.push(`FROM ${ref} is not digest-pinned`);
    if (/:latest\b/.test(resolved)) errors.push(`FROM ${ref} uses a floating tag`);
  }
  if (!/^FROM \S+ AS builder$/m.test(dockerfile)) errors.push('missing builder stage');
  if (!/^FROM \S+ AS runtime$/m.test(dockerfile)) errors.push('missing runtime stage');
  if (!/^FROM \S+ AS tools$/m.test(dockerfile)) errors.push('missing tools stage');
  if (!/^FROM \S+ AS gotool$/m.test(dockerfile)) errors.push('missing gotool stage');
  if (!/^ARG GO_IMAGE=\S+@sha256:[0-9a-f]{64}$/m.test(dockerfile)) {
    errors.push('GO_IMAGE must be pinned by @sha256: digest');
  }
  if (!lines.some((l) => l.startsWith('RUN sh /pin/install-tools.sh /pin/tools.pin.json')))
    errors.push('tools stage must run install-tools.sh against tools.pin.json');
  if (!lines.some((l) => /^COPY --from=tools\b.* \/opt\/bw\/tools \/opt\/bw\/tools$/.test(l)))
    errors.push('runtime stage must copy the pinned toolchain (bin and lib) from the tools stage');
  if (
    !lines.some(
      (l) =>
        l.startsWith('RUN ') &&
        l.includes('node /build/install-tools.mjs /build/scanners.pin.json'),
    )
  )
    errors.push('tools stage must run tools/install-tools.mjs against scanners.pin.json');
  if (lines.some((l) => /chown -R [^&]*\/opt\/bw\/tools/.test(l)))
    errors.push('/opt/bw/tools must stay root-owned (bw must not replace pinned binaries)');

  const users = lines.filter((l) => l.startsWith('USER '));
  const finalUser = users.at(-1)?.slice(USER_PREFIX_LENGTH).trim() ?? '';
  if (!/^bw(:bw)?$/.test(finalUser)) errors.push(`final USER must be bw, got "${finalUser}"`);
  const lastFrom = Math.max(
    lines.findLastIndex((l) => l.startsWith('FROM ')),
    0,
  );
  if (!lines.slice(lastFrom).some((l) => l.startsWith('USER ')))
    errors.push('runtime stage has no USER');

  if (!/--uid 10001\b/.test(dockerfile) || !/--gid 10001\b/.test(dockerfile)) {
    errors.push('bw user/group must use fixed uid/gid 10001');
  }
  if (!lines.some((l) => l.startsWith('WORKDIR /workspace')))
    errors.push('WORKDIR must be /workspace');
  for (const dir of ['/opt/bw/tools', '/opt/bw/templates', '/opt/bw/wordlists', '/etc/bw']) {
    if (!dockerfile.includes(dir)) errors.push(`missing directory ${dir}`);
  }
  const env = lines.filter((l) => l.startsWith('ENV ')).join(' ');
  for (const need of ['BW_SANDBOX=1', 'NODE_ENV=production', '/opt/bw/tools/bin']) {
    if (!env.includes(need)) errors.push(`ENV must include ${need}`);
  }
  if (/(?:KEY|TOKEN|SECRET|PASSWORD)\w*=/i.test(env)) errors.push('ENV must not carry secrets');
  if (!lines.some((l) => l.startsWith('HEALTHCHECK '))) errors.push('missing HEALTHCHECK');
  for (const label of ['revision', 'created', 'source']) {
    if (!dockerfile.includes(`org.opencontainers.image.${label}`))
      errors.push(`missing OCI label ${label}`);
  }
  if (!/^\*$/m.test(dockerignore) || !/^!apps\/agent-runtime$/m.test(dockerignore)) {
    errors.push('Dockerfile.dockerignore must exclude everything then allow-list the build inputs');
  }
  for (const input of [
    'install-tools.sh',
    'tools.pin.json',
    'scanners.pin.json',
    'tools/install-tools.mjs',
    'tools/bw-sqlmap.mjs',
  ]) {
    if (
      !new RegExp(`^!infra/docker/sandbox/${input.replaceAll('.', '\\.')}$`, 'm').test(dockerignore)
    )
      errors.push(`Dockerfile.dockerignore must allow-list ${input}`);
  }
  return errors;
}

/**
 * Shape of tools.pin.json once parsed. checkToolsPin re-checks every field before trusting it.
 * @typedef {{ name: string, version: string, url: string, sha256: string, licence: string }} PinnedTool
 * @typedef {{ tools: PinnedTool[] }} ToolsPin
 */

/**
 * Guards tools.pin.json: every required tool pinned to an exact version, its immutable linux/amd64
 * release asset URL, a sha256 digest and the MIT licence.
 * @param {string} text
 * @returns {string[]} error messages (empty when compliant)
 */
export function checkToolsPin(text) {
  /** @type {unknown} */
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return ['tools.pin.json is not valid JSON'];
  }
  const pin = /** @type {ToolsPin | null} */ (raw);
  const tools = Array.isArray(pin?.tools) ? pin.tools : [];
  if (tools.length === 0) return ['tools.pin.json must list a "tools" array'];
  const errors = [];
  const names = tools.map((t) => t.name);
  for (const need of REQUIRED_TOOLS) {
    if (!names.includes(need)) errors.push(`tools.pin.json is missing ${need}`);
  }
  if (new Set(names).size !== names.length) errors.push('tools.pin.json lists a tool twice');
  for (const t of tools) {
    const { name, version, url, sha256, licence } = t;
    if (typeof name !== 'string' || !REQUIRED_TOOLS.includes(name)) {
      errors.push(`tools.pin.json has an unknown tool "${JSON.stringify(name)}"`);
      continue;
    }
    if (typeof version !== 'string' || !SEMVER.test(version))
      errors.push(`${name}: version must be an exact semver, got ${JSON.stringify(version)}`);
    const expected = `https://github.com/projectdiscovery/${name}/releases/download/v${version}/${name}_${version}_linux_amd64.zip`;
    if (url !== expected)
      errors.push(`${name}: url must be the pinned linux/amd64 release asset ${expected}`);
    if (typeof sha256 !== 'string' || !SHA256.test(sha256))
      errors.push(`${name}: sha256 must be 64 lowercase hex characters`);
    if (licence !== 'MIT') errors.push(`${name}: licence must be MIT`);
  }
  return errors;
}

/** @param {string} root */
export function checkRepo(root) {
  /** @param {string} p */
  const read = (p) => readFileSync(path.join(root, p), 'utf8');
  return [
    ...checkSandboxDockerfile(read(SANDBOX_DOCKERFILE), read(SANDBOX_DOCKERIGNORE)),
    ...checkToolsPin(read(SANDBOX_TOOLS_PIN)),
    ...checkToolPins(JSON.parse(read(SANDBOX_SCANNER_PINS))),
  ];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const errors = checkRepo(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
  for (const e of errors) console.error(`check-sandbox-image: ${e}`);
  process.exit(errors.length ? 1 : 0);
}
