#!/usr/bin/env node
// Keyless-signing helpers (CI-010, #144). The expected certificate identity and OIDC issuer live
// in infra/docker/signing-identity.json, shared with deploy-time verification (CI-011).
//
// Usage:
//   node scripts/signing.mjs identity [--github-output <file>]   validate config, print regexp/issuer
//   node scripts/signing.mjs provenance --image <ref@sha256:..> --out <file>   SLSA v1 predicate (env: GITHUB_*)
//   node scripts/signing.mjs summary --service <s> --image <ref> --verify <cosign-verify.json> [--summary <file>]

import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const IDENTITY_FILE = 'infra/docker/signing-identity.json';
export const FULCIO_ISSUER = 'https://token.actions.githubusercontent.com';
const DIGEST_REF = /^[a-z0-9./_-]+(?::[\w.-]+)?@sha256:[0-9a-f]{64}$/;

/** @param {string} s @returns {string} regexp-escaped literal */
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * @param {unknown} raw parsed identity config
 * @returns {{ issuer: string, repository: string, workflow: string, refs: string[], identityRegexp: string, errors: string[] }}
 */
export function loadIdentity(raw) {
  const o =
    typeof raw === 'object' && raw !== null ? /** @type {Record<string, unknown>} */ (raw) : {};
  const str = (/** @type {string} */ k) =>
    typeof o[k] === 'string' ? /** @type {string} */ (o[k]) : '';
  const issuer = str('issuer');
  const repository = str('repository');
  const workflow = str('workflow');
  const refs = Array.isArray(o.refs) ? o.refs.filter((r) => typeof r === 'string') : [];
  /** @type {string[]} */
  const errors = [];
  if (issuer !== FULCIO_ISSUER) errors.push(`issuer must be ${FULCIO_ISSUER}`);
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) errors.push('repository must be owner/name');
  if (!/^\.github\/workflows\/[\w.-]+\.ya?ml$/.test(workflow)) {
    errors.push('workflow must be a .github/workflows file');
  } else if (!existsSync(path.join(ROOT, workflow))) {
    errors.push(`workflow ${workflow} does not exist (identity drift)`);
  }
  if (refs.length === 0) errors.push('refs must list at least one trusted ref');
  // Pin repo + workflow file exactly; the ref part is limited to the trusted refs ("*" suffix = prefix match).
  const refAlt = refs.map((r) => (r.endsWith('*') ? `${esc(r.slice(0, -1))}.+` : esc(r))).join('|');
  const identityRegexp = `^https://github\\.com/${esc(repository)}/${esc(workflow)}@(${refAlt})$`;
  return { issuer, repository, workflow, refs, identityRegexp, errors };
}

/**
 * SLSA v1 build provenance predicate for one image.
 * @param {string} image digest-pinned image reference
 * @param {Record<string, string | undefined>} env GitHub Actions environment
 * @returns {Record<string, unknown>} predicate
 */
export function provenance(image, env) {
  if (!DIGEST_REF.test(image)) {
    throw new Error(`image must be pinned by sha256 digest, got "${image}"`);
  }
  for (const k of [
    'GITHUB_REPOSITORY',
    'GITHUB_SHA',
    'GITHUB_REF',
    'GITHUB_RUN_ID',
    'GITHUB_WORKFLOW_REF',
  ]) {
    if (!env[k]) throw new Error(`missing ${k}`);
  }
  const repoUrl = `${env.GITHUB_SERVER_URL ?? 'https://github.com'}/${env.GITHUB_REPOSITORY}`;
  return {
    buildDefinition: {
      buildType: 'https://actions.github.io/buildtypes/workflow/v1',
      externalParameters: {
        workflow: { ref: env.GITHUB_REF, repository: repoUrl, path: env.GITHUB_WORKFLOW_REF },
      },
      internalParameters: {
        github: {
          event_name: env.GITHUB_EVENT_NAME ?? '',
          runner_environment: env.RUNNER_ENVIRONMENT ?? '',
        },
      },
      resolvedDependencies: [
        { uri: `git+${repoUrl}@${env.GITHUB_REF}`, digest: { gitCommit: env.GITHUB_SHA } },
      ],
    },
    runDetails: {
      builder: { id: `${server(env)}/${env.GITHUB_WORKFLOW_REF}` },
      metadata: {
        invocationId: `${repoUrl}/actions/runs/${env.GITHUB_RUN_ID}/attempts/${env.GITHUB_RUN_ATTEMPT ?? '1'}`,
      },
    },
  };
}

/** @param {Record<string, string | undefined>} env @returns {string} server URL */
function server(env) {
  return env.GITHUB_SERVER_URL ?? 'https://github.com';
}

/**
 * Extracts Rekor log indexes from `cosign verify --output json` output.
 * @param {string} text cosign verify JSON
 * @returns {number[]} log indexes (empty when no transparency-log entry is present)
 */
export function rekorIndexes(text) {
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  /** @type {number[]} */
  const out = [];
  for (const e of /** @type {unknown[]} */ (Array.isArray(parsed) ? parsed : [])) {
    const idx =
      /** @type {{ optional?: { Bundle?: { Payload?: { logIndex?: unknown } } } } | null} */ (e)
        ?.optional?.Bundle?.Payload?.logIndex;
    if (typeof idx === 'number') out.push(idx);
  }
  return out;
}

/**
 * @param {string} service service name
 * @param {string} image digest-pinned ref
 * @param {number[]} idx Rekor log indexes
 * @param {string} issuer OIDC issuer
 * @param {string} identity certificate identity regexp
 * @returns {string} step-summary line
 */
export function summaryLine(service, image, idx, issuer, identity) {
  const rekor = idx.map((i) => `[${i}](https://search.sigstore.dev/?logIndex=${i})`).join(', ');
  return `- **${service}** \`${image}\` signed, SBOM + provenance attested; Rekor ${rekor}; issuer \`${issuer}\`; identity \`${identity}\`\n`;
}

/** @param {string[]} argv @param {string} name @returns {string | undefined} */
const flag = (argv, name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

/** @returns {ReturnType<typeof loadIdentity>} identity from the shared config */
const readIdentity = () =>
  loadIdentity(JSON.parse(readFileSync(path.join(ROOT, IDENTITY_FILE), 'utf8')));

/**
 * @param {string[]} argv CLI args
 * @param {Record<string, string | undefined>} [env] environment
 * @returns {number} exit code
 */
export function main(argv, env = process.env) {
  const [cmd] = argv;
  try {
    if (cmd === 'identity') {
      const id = readIdentity();
      if (id.errors.length > 0) {
        for (const e of id.errors) console.error(`::error::${IDENTITY_FILE}: ${e}`);
        return 1;
      }
      console.log(`identity-regexp=${id.identityRegexp}\nissuer=${id.issuer}`);
      const out = flag(argv, 'github-output');
      if (out) appendFileSync(out, `identity_regexp=${id.identityRegexp}\nissuer=${id.issuer}\n`);
      return 0;
    }
    if (cmd === 'provenance') {
      const image = flag(argv, 'image');
      const out = flag(argv, 'out');
      if (!image || !out) return 2;
      writeFileSync(out, `${JSON.stringify(provenance(image, env), null, 2)}\n`);
      return 0;
    }
    if (cmd === 'summary') {
      const service = flag(argv, 'service');
      const image = flag(argv, 'image');
      const verify = flag(argv, 'verify');
      if (!service || !image || !verify) return 2;
      const idx = rekorIndexes(readFileSync(verify, 'utf8'));
      if (idx.length === 0) {
        console.error(
          `::error::no Rekor entry for ${service}; refusing to ship an unlogged signature`,
        );
        return 1;
      }
      const id = readIdentity();
      const line = summaryLine(service, image, idx, id.issuer, id.identityRegexp);
      const sum = flag(argv, 'summary');
      if (sum) appendFileSync(sum, line);
      else process.stdout.write(line);
      return 0;
    }
    console.error('usage: signing.mjs identity|provenance|summary ...');
    return 2;
  } catch (e) {
    console.error(`::error::${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
