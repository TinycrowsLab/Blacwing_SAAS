// Static guard for the bundled wordlists (IMAGE-006, #604). Pure file checks, no Docker: every list in
// infra/docker/sandbox/wordlists.pin.json must exist with its pinned sha256, be UTF-8 and carry an allowlisted
// licence with its licence text; the total must fit IMAGE_WORDLISTS_MAX_MIB; no unlisted file may sit under
// infra/docker/sandbox/wordlists; and the Dockerfile must build the lists in the tools stage and copy them root-owned.
// The validation itself lives in tools/install-wordlists.mjs so the build and this check cannot disagree.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  checkWordlistPin,
  DEFAULT_MAX_MIB,
} from '../infra/docker/sandbox/tools/install-wordlists.mjs';

export const WORDLIST_PIN = 'infra/docker/sandbox/wordlists.pin.json';
export const WORDLIST_DIR = 'infra/docker/sandbox/wordlists';
const DOCKERFILE = 'infra/docker/sandbox/Dockerfile';

/**
 * @param {unknown} pin parsed wordlists.pin.json
 * @returns {string[]} every file path the pin names (lists and licence texts)
 */
function pinnedFiles(pin) {
  /** @type {string[]} */
  const out = [];
  if (typeof pin !== 'object' || pin === null) return out;
  for (const key of ['lists', 'licences']) {
    const entries = /** @type {Record<string, unknown>} */ (pin)[key];
    if (!Array.isArray(entries)) continue;
    for (const e of /** @type {unknown[]} */ (entries)) {
      const file =
        typeof e === 'object' && e !== null
          ? /** @type {Record<string, unknown>} */ (e).file
          : undefined;
      if (typeof file === 'string') out.push(path.posix.normalize(file));
    }
  }
  return out;
}

/**
 * @param {string} root repository root
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string[]} error messages (empty when compliant)
 */
export function checkWordlistsRepo(root, env = process.env) {
  const sandboxDir = path.join(root, 'infra/docker/sandbox');
  /** @type {unknown} */
  let pin;
  try {
    pin = JSON.parse(readFileSync(path.join(root, WORDLIST_PIN), 'utf8'));
  } catch {
    return [`${WORDLIST_PIN} is missing or not valid JSON`];
  }
  const maxMib = Number(env.IMAGE_WORDLISTS_MAX_MIB ?? DEFAULT_MAX_MIB);
  if (!Number.isInteger(maxMib) || maxMib <= 0) {
    return ['IMAGE_WORDLISTS_MAX_MIB must be a positive integer'];
  }
  /** @param {string} rel */
  const readBytes = (rel) => {
    const abs = path.join(sandboxDir, rel);
    return existsSync(abs) ? readFileSync(abs) : undefined;
  };
  const { errors } = checkWordlistPin(pin, readBytes, maxMib);

  // Every file under the wordlist tree must be a pinned list or a pinned licence text.
  const listed = new Set(pinnedFiles(pin));
  const wordlistRoot = path.join(root, WORDLIST_DIR);
  for (const entry of readdirSync(wordlistRoot, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const rel = path
      .relative(wordlistRoot, path.join(entry.parentPath, entry.name))
      .split(path.sep)
      .join('/');
    if (!listed.has(path.posix.join('wordlists', rel))) {
      errors.push(`${WORDLIST_DIR}/${rel} is not listed in ${WORDLIST_PIN}`);
    }
  }

  const dockerfile = readFileSync(path.join(root, DOCKERFILE), 'utf8');
  for (const need of [
    /^COPY infra\/docker\/sandbox\/wordlists\.pin\.json \/build\/wordlists\.pin\.json$/m,
    /^COPY infra\/docker\/sandbox\/wordlists \/build\/wordlists$/m,
    /^COPY infra\/docker\/sandbox\/tools\/install-wordlists\.mjs \/build\/install-wordlists\.mjs$/m,
    /^RUN IMAGE_WORDLISTS_MAX_MIB=\$\{IMAGE_WORDLISTS_MAX_MIB\} node \/build\/install-wordlists\.mjs \/build\/wordlists\.pin\.json \/opt\/bw\/wordlists$/m,
    /^COPY --from=tools --chown=root:root \/opt\/bw\/wordlists \/opt\/bw\/wordlists$/m,
  ]) {
    if (!need.test(dockerfile))
      errors.push(`Dockerfile must wire the wordlists (missing ${need.source})`);
  }
  if (!/^ARG IMAGE_WORDLISTS_MAX_MIB=\d+$/m.test(dockerfile)) {
    errors.push('Dockerfile must declare ARG IMAGE_WORDLISTS_MAX_MIB=<default>');
  }
  if (/chown -R [^&]*\/opt\/bw\/wordlists/.test(dockerfile)) {
    errors.push('/opt/bw/wordlists must stay root-owned (bw must not edit the lists)');
  }
  return errors;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const errors = checkWordlistsRepo(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
  );
  for (const e of errors) console.error(`check-sandbox-wordlists: ${e}`);
  process.exit(errors.length ? 1 : 0);
}
