// Static guard for the bw-sandbox base Dockerfile (IMAGE-001, #599). Pure text checks, no Docker.
// Asserts: digest-pinned base, builder/runtime stages, fixed uid 10001 `bw` user, the final USER is
// `bw`, the standard /opt/bw + /etc/bw directories, safe env defaults, a HEALTHCHECK, no secrets and
// OCI labels. Runtime behaviour is covered by check-sandbox-image.int.mjs.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SANDBOX_DOCKERFILE = 'infra/docker/sandbox/Dockerfile';
export const SANDBOX_DOCKERIGNORE = 'infra/docker/sandbox/Dockerfile.dockerignore';
const DIGEST = /@sha256:[0-9a-f]{64}/;
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
  if (froms.length !== 2) errors.push('expected exactly two stages (builder, runtime)');
  for (const f of froms) {
    const ref = f.split(/\s+/)[1] ?? '';
    const resolved = ref.replace(/\$\{(\w+)\}/g, (_, /** @type {string} */ k) => args.get(k) ?? '');
    if (!DIGEST.test(resolved)) errors.push(`FROM ${ref} is not digest-pinned`);
    if (/:latest\b/.test(resolved)) errors.push(`FROM ${ref} uses a floating tag`);
  }
  if (!/^FROM \S+ AS builder$/m.test(dockerfile)) errors.push('missing builder stage');
  if (!/^FROM \S+ AS runtime$/m.test(dockerfile)) errors.push('missing runtime stage');

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
  return errors;
}

/** @param {string} root */
export function checkRepo(root) {
  /** @param {string} p */
  const read = (p) => readFileSync(path.join(root, p), 'utf8');
  return checkSandboxDockerfile(read(SANDBOX_DOCKERFILE), read(SANDBOX_DOCKERIGNORE));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const errors = checkRepo(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
  for (const e of errors) console.error(`check-sandbox-image: ${e}`);
  process.exit(errors.length ? 1 : 0);
}
