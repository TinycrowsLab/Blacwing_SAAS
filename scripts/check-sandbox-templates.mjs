// Static guard for the vendored nuclei-templates (IMAGE-004, #602): the pin in tools.pin.json, the default nuclei
// profile in infra/docker/sandbox/templates/nuclei.yaml and the image wiring in the Dockerfile. Pure checks, no network
// and no Docker. The build-time installer (tools/install-templates.mjs) verifies the downloaded bytes; this guard keeps
// the safe-only policy and the runtime update lock from drifting.

import { parse } from 'yaml';

import { templatesPin } from '../infra/docker/sandbox/tools/install-templates.mjs';

export const NUCLEI_PROFILE = 'infra/docker/sandbox/templates/nuclei.yaml';
export const NUCLEI_OFFICIAL_DIR = '/opt/bw/templates/official';
export const NUCLEI_BLACKWING_DIR = '/opt/bw/templates/blackwing';
export const NUCLEI_CONFIG_PATH = '/etc/bw/nuclei.yaml';

/** Template categories that must never ship in the kept tree (intrusive, brute-force, honeypot, OSINT). */
export const EXCLUDED_CATEGORIES = Object.freeze([
  'http/credential-stuffing',
  'http/default-logins',
  'http/fuzzing',
  'http/honeypot',
  'http/osint',
  'http/token-spray',
]);

/** The only tags the default profile may select. */
export const SAFE_TAGS = Object.freeze([
  'tech',
  'detect',
  'exposure',
  'misconfig',
  'ssl',
  'dns',
  'panel',
]);

/** Tags the default profile must always exclude, even when a template also carries a safe tag. */
export const INTRUSIVE_TAGS = Object.freeze([
  'intrusive',
  'dos',
  'fuzz',
  'fuzzing',
  'brute-force',
  'bruteforce',
  'default-login',
  'default-logins',
  'credential-stuffing',
  'token-spray',
  'sqli',
  'xss',
  'rce',
  'lfi',
  'ssrf',
  'injection',
  'exploit',
  'oast',
  'oob',
  'dast',
  'ssti',
  'xxe',
  'crlf',
  'file-upload',
  'auth-bypass',
  'unauth',
  'redirect',
  'open-redirect',
  'prototype-pollution',
  'osint',
  'honeypot',
  'headless',
  'code',
  'local',
  'txt-service',
]);

/** Severities the default profile may select. */
export const SAFE_SEVERITIES = Object.freeze(['info', 'low']);

/**
 * @param {unknown} v
 * @returns {v is Record<string, unknown>}
 */
const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * @param {unknown} v
 * @returns {string[] | undefined} the list when it is an array of strings
 */
const stringList = (v) =>
  Array.isArray(v) && v.every((s) => typeof s === 'string')
    ? /** @type {string[]} */ (v)
    : undefined;

/**
 * The pinned nuclei-templates entry must pass the installer's own checks and must exclude every non-safe category.
 * @param {string} text tools.pin.json
 * @returns {string[]} error messages
 */
export function checkTemplatesPin(text) {
  /** @type {unknown} */
  let pins;
  try {
    pins = JSON.parse(text);
  } catch {
    return ['tools.pin.json is not valid JSON'];
  }
  let pin;
  try {
    pin = templatesPin(pins);
  } catch (err) {
    return [err instanceof Error ? err.message : String(err)];
  }
  const errors = [];
  for (const category of EXCLUDED_CATEGORIES) {
    if (!pin.exclude.includes(category)) {
      errors.push(`tools.pin.json: nuclei-templates must exclude ${category}`);
    }
  }
  return errors;
}

/**
 * The default nuclei profile: safe tags and severities only, intrusive tags excluded, out-of-band callbacks off,
 * template updates off, and both the pinned official and the Blackwing directories selected.
 * @param {string} text nuclei.yaml
 * @returns {string[]} error messages
 */
export function checkNucleiProfile(text) {
  /** @type {unknown} */
  let profile;
  try {
    profile = parse(text);
  } catch (err) {
    return [
      `${NUCLEI_PROFILE}: not valid YAML (${err instanceof Error ? err.message : String(err)})`,
    ];
  }
  if (!isObject(profile)) return [`${NUCLEI_PROFILE}: must be a YAML mapping`];
  const errors = [];

  if (profile['update-templates'] !== undefined && profile['update-templates'] !== false) {
    errors.push(`${NUCLEI_PROFILE}: update-templates must be false`);
  }
  if (profile['disable-update-check'] !== true) {
    errors.push(`${NUCLEI_PROFILE}: disable-update-check must be true`);
  }
  if (profile['no-interactsh'] !== true) {
    errors.push(`${NUCLEI_PROFILE}: no-interactsh must be true`);
  }

  const templates = stringList(profile.templates) ?? [];
  if (!templates.includes(NUCLEI_OFFICIAL_DIR)) {
    errors.push(`${NUCLEI_PROFILE}: templates must select ${NUCLEI_OFFICIAL_DIR}`);
  }
  if (!templates.includes(NUCLEI_BLACKWING_DIR)) {
    errors.push(`${NUCLEI_PROFILE}: templates must select ${NUCLEI_BLACKWING_DIR}`);
  }

  const severity = stringList(profile.severity);
  if (!severity || severity.length === 0) {
    errors.push(`${NUCLEI_PROFILE}: severity must list info and/or low`);
  } else {
    for (const s of severity) {
      if (!SAFE_SEVERITIES.includes(s))
        errors.push(`${NUCLEI_PROFILE}: severity ${s} is not allowed`);
    }
  }

  const tags = stringList(profile.tags);
  if (!tags || tags.length === 0) {
    errors.push(`${NUCLEI_PROFILE}: tags must list the safe detection tags`);
  } else {
    for (const tag of tags) {
      if (!SAFE_TAGS.includes(tag)) errors.push(`${NUCLEI_PROFILE}: tag ${tag} is not a safe tag`);
    }
  }

  for (const key of ['code', 'dast', 'headless']) {
    if (profile[key] !== false) errors.push(`${NUCLEI_PROFILE}: ${key} must be false`);
  }
  if (profile['include-tags'] !== undefined || profile['include-templates'] !== undefined) {
    errors.push(
      `${NUCLEI_PROFILE}: include-tags and include-templates must not re-enable excluded templates`,
    );
  }

  const exclude = stringList(profile['exclude-tags']) ?? [];
  for (const tag of INTRUSIVE_TAGS) {
    if (!exclude.includes(tag)) errors.push(`${NUCLEI_PROFILE}: exclude-tags must exclude ${tag}`);
  }
  return errors;
}

/**
 * The Dockerfile must install the pinned templates at build time from the pin, copy the profile to /etc/bw, and keep
 * /opt/bw/templates root-owned so the runtime user cannot rewrite them.
 * @param {string} dockerfile
 * @param {string} dockerignore
 * @returns {string[]} error messages
 */
export function checkTemplatesDockerfile(dockerfile, dockerignore) {
  // Join backslash continuations so a multi-line RUN is checked as one instruction.
  const lines = dockerfile
    .replace(/\\\n/g, ' ')
    .split('\n')
    .map((l) => l.trim());
  const errors = [];
  if (!lines.includes('COPY infra/docker/sandbox/tools/install-templates.mjs /build/')) {
    errors.push('tools stage must copy tools/install-templates.mjs');
  }
  if (
    !lines.some(
      (l) =>
        l.startsWith('RUN ') &&
        l.includes(`node /build/install-templates.mjs /pin/tools.pin.json ${NUCLEI_OFFICIAL_DIR}`),
    )
  ) {
    errors.push('tools stage must install the pinned templates into /opt/bw/templates/official');
  }
  if (
    !lines.some((l) => /^COPY --from=tools\b.* \/opt\/bw\/templates \/opt\/bw\/templates$/.test(l))
  ) {
    errors.push('runtime stage must copy the pinned templates from the tools stage');
  }
  if (
    !lines.some(
      (l) =>
        l.includes(NUCLEI_CONFIG_PATH) && l.includes('infra/docker/sandbox/templates/nuclei.yaml'),
    )
  ) {
    errors.push(`runtime stage must install the default profile at ${NUCLEI_CONFIG_PATH}`);
  }
  if (lines.some((l) => /chown -R [^&]*\/opt\/bw\/templates/.test(l))) {
    errors.push(
      '/opt/bw/templates must stay root-owned (bw must not rewrite the pinned templates)',
    );
  }
  for (const input of [
    'infra/docker/sandbox/tools/install-templates.mjs',
    'infra/docker/sandbox/templates/nuclei.yaml',
    'infra/docker/sandbox/templates/blackwing/README.md',
  ]) {
    if (!dockerignore.split('\n').includes(`!${input}`)) {
      errors.push(`Dockerfile.dockerignore must allow-list ${input}`);
    }
  }
  return errors;
}
