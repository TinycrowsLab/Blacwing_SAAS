// Static guard for the bw-sandbox Dockerfile (IMAGE-001, #599), its pinned ProjectDiscovery
// tools (IMAGE-002, #600), its pinned scanners (IMAGE-002, #601) and the pinned headless browser and fonts
// (IMAGE-005, #603). Pure text checks, no Docker. Asserts: digest-pinned base, builder/tools/runtime stages,
// fixed uid 10001 `bw` user, the final USER is `bw`, the standard /opt/bw + /etc/bw directories, root-owned
// tools, safe env defaults, a HEALTHCHECK, no secrets, OCI labels, a complete tools.pin.json (exact versions,
// release URLs, sha256, MIT licence), the browser install step with its env, and that the browser pin matches
// the workspace's Playwright catalog pins. Runtime behaviour is covered by check-sandbox-image.int.mjs.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  checkNucleiProfile,
  checkTemplatesDockerfile,
  checkTemplatesPin,
  NUCLEI_PROFILE,
} from './check-sandbox-templates.mjs';
import { checkToolPins } from './check-sandbox-tools.mjs';
import { checkWordlistsRepo } from './check-sandbox-wordlists.mjs';

export const SANDBOX_DOCKERFILE = 'infra/docker/sandbox/Dockerfile';
export const SANDBOX_DOCKERIGNORE = 'infra/docker/sandbox/Dockerfile.dockerignore';
export const SANDBOX_TOOLS_PIN = 'infra/docker/sandbox/tools.pin.json';
export const SANDBOX_SCANNER_PINS = 'infra/docker/sandbox/scanners.pin.json';
export const WORKSPACE_MANIFEST = 'pnpm-workspace.yaml';
export const REQUIRED_TOOLS = ['subfinder', 'dnsx', 'httpx', 'naabu', 'katana', 'nuclei'];
const REQUIRED_FONTS = ['fonts-noto-core', 'fonts-noto-cjk', 'fonts-noto-color-emoji'];
const SEMVER = /^\d+\.\d+\.\d+$/;
const SHA256 = /^[0-9a-f]{64}$/;
const CHROMIUM_VERSION = /^\d+\.\d+\.\d+\.\d+$/;
const CHROMIUM_REVISION = /^\d+$/;
const DEBIAN_VERSION = /^(\d+:)?\d[0-9A-Za-z.+~-]*$/;
const PACKAGE_NAME = /^[a-z0-9][a-z0-9.+-]*$/;
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
  const runtimeStart = lines.findLastIndex((l) => /^FROM \S+ AS runtime$/.test(l));
  const browserStep = lines.findIndex((l) =>
    l.startsWith('RUN sh /pin/install-browser.sh /pin/tools.pin.json'),
  );
  if (browserStep < 0 || browserStep < runtimeStart)
    errors.push('runtime stage must install the pinned browser with install-browser.sh');

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
  for (const need of [
    'BW_SANDBOX=1',
    'NODE_ENV=production',
    '/opt/bw/tools/bin',
    'PLAYWRIGHT_BROWSERS_PATH=/opt/bw/browsers',
  ]) {
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
    'install-browser.sh',
    'tools.pin.json',
    'scanners.pin.json',
    'tools/install-tools.mjs',
    'tools/bw-sqlmap.mjs',
    'tools/install-wordlists.mjs',
    'wordlists.pin.json',
    'wordlists',
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

/**
 * Guards the browser and font pins in tools.pin.json: an exact Playwright pair, a Chromium build (exact version
 * and Playwright revision), and the Debian font packages with exact versions. The Playwright pair must equal the
 * workspace catalog (`pnpm-workspace.yaml`), so the image never bakes a browser the runtime does not expect.
 * @param {string} text tools.pin.json
 * @param {string} workspace pnpm-workspace.yaml
 * @returns {string[]} error messages (empty when compliant)
 */
export function checkBrowserPin(text, workspace) {
  /** @type {unknown} */
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return ['tools.pin.json is not valid JSON'];
  }
  const pin = /** @type {{ browser?: unknown, fonts?: unknown } | null} */ (raw);
  const browser =
    /** @type {{ playwright?: unknown, playwrightMcp?: unknown, licence?: unknown, chromium?: { version?: unknown, revision?: unknown } } | null | undefined} */ (
      pin?.browser
    );
  if (typeof browser !== 'object' || browser === null) {
    return ['tools.pin.json must pin a "browser" object'];
  }
  const errors = [];
  const { playwright, playwrightMcp, chromium, licence } = browser;
  if (typeof playwright !== 'string' || !SEMVER.test(playwright))
    errors.push(`browser: playwright must be an exact semver, got ${JSON.stringify(playwright)}`);
  if (typeof playwrightMcp !== 'string' || !SEMVER.test(playwrightMcp))
    errors.push(
      `browser: playwrightMcp must be an exact semver, got ${JSON.stringify(playwrightMcp)}`,
    );
  if (typeof chromium?.version !== 'string' || !CHROMIUM_VERSION.test(chromium.version))
    errors.push('browser: chromium.version must be an exact four-part Chromium version');
  if (typeof chromium?.revision !== 'string' || !CHROMIUM_REVISION.test(chromium.revision))
    errors.push('browser: chromium.revision must be the numeric Playwright revision');
  if (licence !== 'Apache-2.0') errors.push('browser: licence must be Apache-2.0');

  const catalog = (/** @type {string} */ name) => {
    const escaped = name.replaceAll(/[/.@]/g, (c) => `\\${c}`);
    return new RegExp(`^\\s+'?${escaped}'?:\\s*(\\S+)\\s*$`, 'm').exec(workspace)?.[1];
  };
  if (typeof playwright === 'string' && catalog('playwright-core') !== playwright)
    errors.push(
      `browser: playwright must equal the catalog playwright-core pin in ${WORKSPACE_MANIFEST}`,
    );
  if (typeof playwrightMcp === 'string' && catalog('@playwright/mcp') !== playwrightMcp)
    errors.push(
      `browser: playwrightMcp must equal the catalog @playwright/mcp pin in ${WORKSPACE_MANIFEST}`,
    );

  const fonts = Array.isArray(pin?.fonts) ? /** @type {unknown[]} */ (pin.fonts) : [];
  if (fonts.length === 0) return [...errors, 'tools.pin.json must list a "fonts" array'];
  const packages = fonts.map((f) => /** @type {{ package?: unknown }} */ (f).package);
  for (const need of REQUIRED_FONTS) {
    if (!packages.includes(need)) errors.push(`tools.pin.json is missing font ${need}`);
  }
  for (const f of fonts) {
    const { package: name, version } = /** @type {{ package?: unknown, version?: unknown }} */ (f);
    if (typeof name !== 'string' || !PACKAGE_NAME.test(name))
      errors.push(`font package name is invalid: ${JSON.stringify(name)}`);
    if (typeof version !== 'string' || !DEBIAN_VERSION.test(version))
      errors.push(`${String(name)}: font version must be an exact Debian version`);
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
    ...checkBrowserPin(read(SANDBOX_TOOLS_PIN), read(WORKSPACE_MANIFEST)),
    ...checkWordlistsRepo(root),
    ...checkTemplatesPin(read(SANDBOX_TOOLS_PIN)),
    ...checkNucleiProfile(read(NUCLEI_PROFILE)),
    ...checkTemplatesDockerfile(read(SANDBOX_DOCKERFILE), read(SANDBOX_DOCKERIGNORE)),
  ];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const errors = checkRepo(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
  for (const e of errors) console.error(`check-sandbox-image: ${e}`);
  process.exit(errors.length ? 1 : 0);
}
