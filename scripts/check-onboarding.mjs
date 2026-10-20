#!/usr/bin/env node
// Guards the developer onboarding guide against drift (DEVENV-015, #169).
//
// Detects, for every Markdown file under docs/user/:
//   - relative links to missing files, and `#anchors` that match no heading in the target;
//   - `pnpm <script>` commands that are not scripts in the root package.json;
//   - dev login users that disagree with infra/compose/keycloak/realm-export.json (missing or unknown);
//   - Keycloak redirect origins of client `bw-console-bff` that the guide does not mention;
//   - endpoint ports that disagree with the defaults in .env.example.
//
// External (http/https/mailto) links are not fetched. Prints key names and URLs only.
//
// Usage: node scripts/check-onboarding.mjs [--root <dir>] [--quiet]
// Prints a JSON summary on stdout; exits non-zero when any check fails.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { extractLinks, headingAnchors } from './check-claude-md.mjs';

export const GUIDE_DIR = 'docs/user';
export const ONBOARDING = 'docs/user/onboarding.md';
export const REALM_EXPORT = 'infra/compose/keycloak/realm-export.json';
export const REDIRECT_CLIENT = 'bw-console-bff';

/** `pnpm <word>` words that are pnpm built-ins, not package scripts. */
export const PNPM_BUILTINS = Object.freeze(['install', 'i', 'add', 'dlx', 'exec', 'run', 'ls']);

/** [.env.example key, text the guide must contain with `{p}` replaced by the key's default]. */
export const ENDPOINT_PORTS = Object.freeze([
  ['BW_DEV_KEYCLOAK_PORT', 'http://localhost:{p}'],
  ['BW_DEV_TEMPORAL_UI_PORT', 'http://localhost:{p}'],
  ['BW_DEV_TEMPORAL_PORT', 'localhost:{p}'],
  ['BW_DEV_MINIO_CONSOLE_PORT', 'http://localhost:{p}'],
  ['BW_DEV_MINIO_PORT', 'http://localhost:{p}'],
  ['BW_DEV_MAILPIT_UI_PORT', 'http://localhost:{p}'],
  ['BW_DEV_MAILPIT_SMTP_PORT', 'localhost:{p}'],
  ['BW_DEV_OPENBAO_PORT', 'http://localhost:{p}'],
  ['BW_DEV_GRAFANA_PORT', 'http://localhost:{p}'],
  ['BW_DEV_TRAEFIK_HTTPS_PORT', 'app.bw.localhost:{p}'],
  ['BW_DEV_POSTGRES_PORT', '`{p}`'],
  ['BW_DEV_VALKEY_PORT', '`{p}`'],
]);

/**
 * Script names invoked as `pnpm <name>` in the Markdown (fenced blocks and inline code).
 * @param {string} markdown
 * @returns {string[]}
 */
export function pnpmCommands(markdown) {
  /** @type {Set<string>} */
  const names = new Set();
  for (const match of markdown.matchAll(/\bpnpm\s+([A-Za-z][\w:.-]*)/g)) {
    if (match[1] !== undefined) names.add(match[1]);
  }
  return [...names];
}

/**
 * @param {string} file
 * @returns {unknown}
 */
function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

/**
 * Parses KEY=value lines of a dotenv-style file.
 * @param {string} text
 * @returns {Map<string, string>}
 */
export function parseDotenv(text) {
  /** @type {Map<string, string>} */
  const out = new Map();
  for (const line of text.split('\n')) {
    const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (m?.[1] !== undefined) out.set(m[1], m[2] ?? '');
  }
  return out;
}

/**
 * @param {string} root repository root
 * @returns {{ ok: boolean, errors: string[], files: string[] }}
 */
export function checkOnboarding(root) {
  /** @type {string[]} */
  const errors = [];
  const dir = path.join(root, GUIDE_DIR);
  const files = existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith('.md'))
        .sort()
    : [];
  if (!files.includes(path.basename(ONBOARDING))) errors.push(`${ONBOARDING}: missing`);

  const pkgPath = path.join(root, 'package.json');
  /** @type {Set<string>} */
  const scripts = new Set();
  if (existsSync(pkgPath)) {
    const pkg = /** @type {{ scripts?: Record<string, string> }} */ (readJson(pkgPath));
    for (const name of Object.keys(pkg.scripts ?? {})) scripts.add(name);
  }

  for (const file of files) {
    const rel = `${GUIDE_DIR}/${file}`;
    const text = readFileSync(path.join(dir, file), 'utf8');
    const own = headingAnchors(text);
    for (const link of extractLinks(text)) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(link)) continue;
      const [target = '', anchor] = link.split('#');
      /** @type {Set<string>} */
      let anchors = own;
      if (target !== '') {
        const abs = path.resolve(dir, target);
        if (!abs.startsWith(root) || !existsSync(abs)) {
          errors.push(`${rel}: broken link ${link}`);
          continue;
        }
        if (anchor === undefined || !abs.endsWith('.md')) continue;
        anchors = headingAnchors(readFileSync(abs, 'utf8'));
      }
      if (anchor !== undefined && anchor !== '' && !anchors.has(anchor)) {
        errors.push(`${rel}: link ${link} matches no heading`);
      }
    }
    for (const name of pnpmCommands(text)) {
      if (!scripts.has(name) && !PNPM_BUILTINS.includes(name)) {
        errors.push(`${rel}: \`pnpm ${name}\` is not a script in package.json`);
      }
    }
  }

  const guidePath = path.join(root, ONBOARDING);
  if (!existsSync(guidePath)) return { ok: errors.length === 0, errors, files };
  const guide = readFileSync(guidePath, 'utf8');

  const realmPath = path.join(root, REALM_EXPORT);
  if (existsSync(realmPath)) {
    const realm =
      /** @type {{ users?: { username: string }[], clients?: { clientId: string, redirectUris?: string[] }[] }} */ (
        readJson(realmPath)
      );
    const humans = (realm.users ?? []).map((u) => u.username).filter((u) => u.includes('@'));
    for (const user of humans) {
      if (!guide.includes(`\`${user}\``)) {
        errors.push(`${ONBOARDING}: realm user ${user} is not documented`);
      }
    }
    for (const mention of new Set(guide.match(/[\w.-]+@[\w-]+\.test/g) ?? [])) {
      if (!humans.includes(mention)) {
        errors.push(`${ONBOARDING}: ${mention} is not a user in ${REALM_EXPORT}`);
      }
    }
    const client = (realm.clients ?? []).find((c) => c.clientId === REDIRECT_CLIENT);
    for (const uri of client?.redirectUris ?? []) {
      const origin = uri.replace(/\/auth\/callback$/, '');
      if (!guide.includes(origin)) {
        errors.push(
          `${ONBOARDING}: redirect origin ${origin} of ${REDIRECT_CLIENT} is not mentioned`,
        );
      }
    }
  } else {
    errors.push(`${REALM_EXPORT}: missing`);
  }

  const envPath = path.join(root, '.env.example');
  if (existsSync(envPath)) {
    const env = parseDotenv(readFileSync(envPath, 'utf8'));
    for (const [key, template] of ENDPOINT_PORTS) {
      const port = env.get(key ?? '');
      if (port === undefined || port === '') {
        errors.push(`.env.example: ${key ?? ''} has no default`);
      } else if (!guide.includes((template ?? '').replace('{p}', port))) {
        errors.push(
          `${ONBOARDING}: ${key ?? ''}=${port} not shown as "${(template ?? '').replace('{p}', port)}"`,
        );
      }
    }
  } else {
    errors.push('.env.example: missing');
  }
  return { ok: errors.length === 0, errors, files };
}

/**
 * @param {string[]} argv
 * @returns {number}
 */
export function main(argv) {
  let root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  let quiet = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--quiet') quiet = true;
    else if (argv[i] === '--root' && argv[i + 1] !== undefined) {
      i += 1;
      root = path.resolve(argv[i] ?? '');
    } else {
      process.stderr.write(`check-onboarding: unknown argument ${argv[i] ?? ''}\n`);
      return 2;
    }
  }
  const result = checkOnboarding(root);
  if (!quiet) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) {
    process.stderr.write(
      `check-onboarding: ${String(result.errors.length)} problem(s) found:\n` +
        result.errors.map((e) => `  - ${e}`).join('\n') +
        '\n',
    );
    return 1;
  }
  return 0;
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exitCode = main(process.argv.slice(2));
}
