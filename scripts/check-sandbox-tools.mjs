// Static guard for the pinned sandbox toolchain (IMAGE-002, #601): infra/docker/sandbox/scanners.pin.json.
// Pure checks over the parsed pin file, no network and no Docker. The build-time installer verifies the
// downloaded bytes; this guard keeps the pins complete, licensed and free of forbidden tools.

const DIGEST_HEX = /^[0-9a-f]{64}$/;
const GO_ZIP_HASH = /^h1:[A-Za-z0-9+/]+=*$/;
const KINDS = Object.freeze(['binary', 'archive', 'tree', 'go']);
const ARCHES = Object.freeze(['amd64', 'arm64']);

/**
 * Tools the image must ship, with the SPDX licence each must declare. Changing a licence here is a
 * licence-review decision (IMAGE-009), so the expectation lives in code, not only in the pin file.
 */
export const REQUIRED_SCANNERS = Object.freeze({
  ffuf: 'MIT',
  fingerprintx: 'Apache-2.0',
  'testssl.sh': 'GPL-2.0-only',
  gitleaks: 'MIT',
  opengrep: 'LGPL-2.1-only',
  trivy: 'Apache-2.0',
  sqlmap: 'GPL-2.0-only',
  jq: 'MIT',
});

/** Tools that must never be in the image (CONTEXT_PACK §5 license review gate). */
export const FORBIDDEN_TOOLS = Object.freeze(['nmap', 'semgrep']);

/** Tools that run from lib/ and are reached only through an entry point (never a raw binary on PATH). */
const WRAPPED_ONLY = Object.freeze({ sqlmap: 'bw-sqlmap' });

/**
 * System packages the image installs: python3 for sqlmap; bash, openssl, hexdump (bsdextrautils) and xxd
 * for testssl.sh.
 */
const REQUIRED_SYSTEM = Object.freeze(['python3', 'bash', 'openssl', 'bsdextrautils', 'xxd']);

/**
 * @param {unknown} v
 * @returns {v is Record<string, unknown>}
 */
const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * @param {unknown} pins parsed scanners.pin.json
 * @returns {string[]} error messages (empty when the pins are complete and compliant)
 */
export function checkToolPins(pins) {
  const errors = [];
  if (!isObject(pins)) return ['scanners.pin.json must be a JSON object'];
  if (pins.schema !== 1) errors.push('scanners.pin.json: schema must be 1');
  if (pins.binDir !== '/opt/bw/tools/bin')
    errors.push('scanners.pin.json: binDir must be /opt/bw/tools/bin');
  if (pins.libDir !== '/opt/bw/tools/lib')
    errors.push('scanners.pin.json: libDir must be /opt/bw/tools/lib');
  if (!Array.isArray(pins.tools)) return [...errors, 'scanners.pin.json: tools must be an array'];

  /** @type {Set<string>} */
  const names = new Set();
  for (const tool of pins.tools) {
    if (!isObject(tool)) {
      errors.push('scanners.pin.json: every tool must be an object');
      continue;
    }
    const name = typeof tool.name === 'string' ? tool.name : '';
    const label = name || '(unnamed tool)';
    if (!name) errors.push(`${label}: name is required`);
    if (names.has(name)) errors.push(`${label}: duplicate tool name`);
    names.add(name);
    if (FORBIDDEN_TOOLS.includes(name))
      errors.push(`${label}: forbidden tool (licence review gate)`);

    const expectedLicence = Object.hasOwn(REQUIRED_SCANNERS, name)
      ? REQUIRED_SCANNERS[/** @type {keyof typeof REQUIRED_SCANNERS} */ (name)]
      : undefined;
    if (expectedLicence === undefined) {
      errors.push(`${label}: not a required sandbox tool`);
    } else if (tool.licence !== expectedLicence) {
      errors.push(`${label}: licence must be ${expectedLicence}, got ${String(tool.licence)}`);
    }
    if (typeof tool.version !== 'string' || tool.version.length === 0) {
      errors.push(`${label}: version is required`);
    }
    if (typeof tool.source !== 'string' || !tool.source.startsWith('https://')) {
      errors.push(`${label}: source must be an https URL`);
    }
    if (typeof tool.entrypoint !== 'string' || tool.entrypoint.length === 0) {
      errors.push(`${label}: entrypoint is required`);
    }
    if (!Array.isArray(tool.versionArgs) || !tool.versionArgs.every((a) => typeof a === 'string')) {
      errors.push(`${label}: versionArgs must be a string array`);
    }
    errors.push(...checkInstall(label, tool));
    errors.push(...checkArtifacts(label, tool));
    if (Object.hasOwn(WRAPPED_ONLY, name)) {
      const wrapper = WRAPPED_ONLY[/** @type {keyof typeof WRAPPED_ONLY} */ (name)];
      if (tool.entrypoint !== wrapper)
        errors.push(`${label}: must be reached only through ${wrapper}`);
    }
  }

  for (const required of Object.keys(REQUIRED_SCANNERS)) {
    if (!names.has(required)) errors.push(`scanners.pin.json: missing required tool ${required}`);
  }
  errors.push(...checkSystem(pins.system));
  return errors;
}

/**
 * @param {string} label
 * @param {Record<string, unknown>} tool
 * @returns {string[]}
 */
function checkInstall(label, tool) {
  const install = tool.install;
  if (!isObject(install)) return [`${label}: install is required`];
  const kind = install.kind;
  if (typeof kind !== 'string' || !KINDS.includes(kind)) {
    return [`${label}: install.kind must be one of ${KINDS.join(', ')}`];
  }
  const errors = [];
  if (kind === 'archive' && typeof install.member !== 'string') {
    errors.push(`${label}: archive install needs install.member`);
  }
  if (kind === 'tree') {
    if (typeof install.entry !== 'string')
      errors.push(`${label}: tree install needs install.entry`);
    if (typeof install.shim !== 'boolean')
      errors.push(`${label}: tree install needs install.shim (boolean)`);
    if (tool.name === 'sqlmap' && install.shim !== false) {
      errors.push(`${label}: sqlmap must not get a PATH shim (raw sqlmap is never on PATH)`);
    }
  }
  if (kind === 'go') {
    if (typeof install.module !== 'string' || typeof install.package !== 'string') {
      errors.push(`${label}: go install needs install.module and install.package`);
    }
    if (typeof install.zipHash !== 'string' || !GO_ZIP_HASH.test(install.zipHash)) {
      errors.push(`${label}: go install needs an h1: install.zipHash`);
    }
  }
  return errors;
}

/**
 * Binary and archive tools need a pinned sha256 for both production arches (amd64 and arm64). A source
 * archive (`all`) is one digest for every arch. Go tools are pinned by zipHash and have no artifact.
 * @param {string} label
 * @param {Record<string, unknown>} tool
 * @returns {string[]}
 */
function checkArtifacts(label, tool) {
  const install = isObject(tool.install) ? tool.install : {};
  if (install.kind === 'go') {
    return tool.artifacts === undefined ? [] : [`${label}: go install must not declare artifacts`];
  }
  if (!isObject(tool.artifacts)) return [`${label}: artifacts are required`];
  const keys = Object.keys(tool.artifacts);
  const errors = [];
  if (keys.includes('all')) {
    if (keys.length !== 1)
      errors.push(`${label}: artifacts.all cannot be combined with per-arch artifacts`);
  } else {
    for (const arch of ARCHES) {
      if (!keys.includes(arch)) errors.push(`${label}: missing artifacts.${arch}`);
    }
  }
  for (const key of keys) {
    if (key !== 'all' && !ARCHES.includes(key))
      errors.push(`${label}: unknown artifact key ${key}`);
    const artifact = tool.artifacts[/** @type {string} */ (key)];
    if (!isObject(artifact)) {
      errors.push(`${label}: artifacts.${key} must be an object`);
      continue;
    }
    if (typeof artifact.url !== 'string' || !artifact.url.startsWith('https://')) {
      errors.push(`${label}: artifacts.${key}.url must be https`);
    }
    if (typeof artifact.sha256 !== 'string' || !DIGEST_HEX.test(artifact.sha256)) {
      errors.push(`${label}: artifacts.${key}.sha256 must be 64 lowercase hex characters`);
    }
  }
  return errors;
}

/**
 * @param {unknown} system
 * @returns {string[]}
 */
function checkSystem(system) {
  if (!Array.isArray(system)) return ['scanners.pin.json: system must be an array'];
  /** @type {unknown[]} */
  const entries = system;
  const errors = [];
  for (const need of REQUIRED_SYSTEM) {
    const entry = entries.find((s) => isObject(s) && s.name === need);
    if (!isObject(entry)) {
      errors.push(`scanners.pin.json: system package ${need} is not recorded`);
      continue;
    }
    if (typeof entry.version !== 'string' || entry.version.length === 0) {
      errors.push(`scanners.pin.json: system ${need} needs a recorded version`);
    }
    if (typeof entry.licence !== 'string' || entry.licence.length === 0) {
      errors.push(`scanners.pin.json: system ${need} needs a licence`);
    }
  }
  return errors;
}
