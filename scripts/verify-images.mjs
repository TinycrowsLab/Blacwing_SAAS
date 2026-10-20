#!/usr/bin/env node
// Deploy-time image verification gate (CI-011, #145). Before any rollout, every digest in
// images.json must carry a keyless cosign signature from the exact identity in
// infra/docker/signing-identity.json (shared with the CI-010 sign job), logged in Rekor, plus a
// CycloneDX SBOM attestation and a SLSA v1 provenance attestation for that same digest. Anything
// else (unsigned, foreign identity or issuer, missing attestation, Rekor/registry lookup error,
// timeout, missing cosign) fails closed: the deploy must not proceed.
//
// Usage:
//   node scripts/verify-images.mjs --images images.json [--services api,web] [--summary <file>]
//   env COSIGN_BIN (default "cosign"), VERIFY_TIMEOUT_MS (default 120000)

import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { IDENTITY_FILE, loadIdentity, rekorIndexes } from './signing.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAX_OUTPUT_BYTES = 67_108_864; // 64 MiB of cosign output
const DEFAULT_TIMEOUT_MS = 120_000;
const DIGEST_REF = /^[a-z0-9./_-]+(?::[\w.-]+)?@(sha256:[0-9a-f]{64})$/;

/** cosign `--type` -> in-toto predicateType the attestation must carry. */
export const ATTESTATIONS = Object.freeze({
  cyclonedx: 'https://cyclonedx.org/bom',
  slsaprovenance1: 'https://slsa.dev/provenance/v1',
});

/** Flags that would weaken verification; the gate never passes them. */
export const FORBIDDEN_FLAGS = Object.freeze([
  '--insecure-ignore-tlog',
  '--insecure-ignore-sct',
  '--allow-insecure-registry',
  '--allow-http-registry',
]);

/** @param {unknown} v @returns {v is Record<string, unknown>} */
const isRecord = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Selects the digest-pinned targets to verify from images.json.
 * @param {unknown} images parsed images.json (service -> ref@sha256:...)
 * @param {string[]} [services] subset to deploy; all entries when empty
 * @returns {{ targets: { service: string, ref: string, digest: string }[], errors: string[] }}
 */
export function planTargets(images, services = []) {
  /** @type {string[]} */
  const errors = [];
  /** @type {{ service: string, ref: string, digest: string }[]} */
  const targets = [];
  if (!isRecord(images)) return { targets, errors: ['images.json must be an object'] };
  const names = services.length > 0 ? services : Object.keys(images);
  if (names.length === 0) errors.push('no images to verify');
  for (const service of names) {
    const ref = images[service];
    if (typeof ref !== 'string') {
      errors.push(`${service}: not in images.json`);
      continue;
    }
    const m = DIGEST_REF.exec(ref);
    if (!m?.[1]) {
      errors.push(`${service}: "${ref}" is not pinned by sha256 digest`);
      continue;
    }
    targets.push({ service, ref, digest: m[1] });
  }
  return { targets, errors };
}

/**
 * Re-checks `cosign verify --output json` output so a loose regexp or a cosign quirk can never
 * pass a foreign signature: every entry must be for this digest, from the exact issuer, with a
 * subject matching the pinned identity, and at least one must be logged in Rekor.
 * @param {string} text cosign verify JSON
 * @param {{ issuer: string, identityRegexp: string }} id expected identity
 * @param {string} digest sha256:... being deployed
 * @returns {{ errors: string[], subjects: string[], rekor: number[] }}
 */
export function checkSignature(text, id, digest) {
  /** @type {string[]} */
  const errors = [];
  /** @type {string[]} */
  const subjects = [];
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { errors: ['cosign verify output is not JSON'], subjects, rekor: [] };
  }
  const entries = Array.isArray(parsed) ? parsed : [];
  if (entries.length === 0) errors.push('no signatures');
  const re = new RegExp(id.identityRegexp);
  for (const e of entries) {
    const crit = isRecord(e) && isRecord(e.critical) ? e.critical : {};
    const img = isRecord(crit.image) ? crit.image : {};
    const opt = isRecord(e) && isRecord(e.optional) ? e.optional : {};
    if (img['docker-manifest-digest'] !== digest) errors.push('signature is for another digest');
    if (opt.Issuer !== id.issuer) errors.push(`unexpected issuer "${String(opt.Issuer)}"`);
    const subject = typeof opt.Subject === 'string' ? opt.Subject : '';
    if (!re.test(subject)) errors.push(`unexpected identity "${subject}"`);
    else subjects.push(subject);
  }
  const rekor = rekorIndexes(text);
  if (entries.length > 0 && rekor.length === 0) errors.push('signature has no Rekor entry');
  return { errors, subjects: [...new Set(subjects)], rekor };
}

/**
 * Re-checks `cosign verify-attestation` output: at least one in-toto statement of the expected
 * predicate type whose subject is this digest.
 * @param {string} text newline-delimited DSSE envelopes
 * @param {string} predicateType expected in-toto predicateType
 * @param {string} digest sha256:...
 * @returns {string[]} errors (empty when valid)
 */
export function checkAttestation(text, predicateType, digest) {
  const hex = digest.replace(/^sha256:/, '');
  let found = false;
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      /** @type {unknown} */
      const env = JSON.parse(line);
      const payload = isRecord(env) && typeof env.payload === 'string' ? env.payload : '';
      /** @type {unknown} */
      const st = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
      if (!isRecord(st) || st.predicateType !== predicateType) continue;
      const subj = Array.isArray(st.subject) ? st.subject : [];
      if (subj.some((s) => isRecord(s) && isRecord(s.digest) && s.digest.sha256 === hex)) {
        found = true;
      }
    } catch {
      // Unparseable envelope: ignored, so it can never count as a valid attestation.
    }
  }
  return found ? [] : [`no ${predicateType} attestation for ${digest}`];
}

/**
 * @typedef {(args: string[]) => { status: number | null, stdout: string, stderr: string, error?: Error }} Exec
 */

/**
 * @param {string} bin cosign binary
 * @param {number} timeout per-call timeout in ms
 * @param {Record<string, string | undefined>} env environment for cosign
 * @returns {Exec} runner
 */
export function cosignExec(bin, timeout, env) {
  return (args) => {
    const r = spawnSync(bin, args, { encoding: 'utf8', timeout, env, maxBuffer: MAX_OUTPUT_BYTES });
    return {
      status: r.status,
      stdout: r.stdout,
      stderr: r.stderr,
      ...(r.error ? { error: r.error } : {}),
    };
  };
}

/** @param {ReturnType<Exec>} r @returns {string} one-line failure reason */
const why = (r) => {
  if (r.error) return r.error.message;
  const last = r.stderr.trim().split('\n').pop() ?? '';
  return `cosign exited ${String(r.status)}${last ? `: ${last}` : ''}`;
};

/**
 * Verifies one image: signature then both attestations. Any cosign error (unsigned, wrong
 * identity, Rekor or registry lookup failure, timeout) is a failure, never a skip.
 * @param {{ service: string, ref: string, digest: string }} t target
 * @param {{ issuer: string, identityRegexp: string }} id expected identity
 * @param {Exec} exec cosign runner
 * @returns {{ ok: boolean, errors: string[], subjects: string[], rekor: number[] }}
 */
export function verifyImage(t, id, exec) {
  const idFlags = [
    '--certificate-identity-regexp',
    id.identityRegexp,
    '--certificate-oidc-issuer',
    id.issuer,
  ];
  const sig = exec(['verify', ...idFlags, '--output', 'json', t.ref]);
  if (sig.status !== 0 || sig.error) {
    return { ok: false, errors: [`signature: ${why(sig)}`], subjects: [], rekor: [] };
  }
  const s = checkSignature(sig.stdout, id, t.digest);
  const errors = s.errors.map((e) => `signature: ${e}`);
  for (const [type, predicateType] of Object.entries(ATTESTATIONS)) {
    const att = exec(['verify-attestation', '--type', type, ...idFlags, t.ref]);
    if (att.status !== 0 || att.error) errors.push(`${type}: ${why(att)}`);
    else errors.push(...checkAttestation(att.stdout, predicateType, t.digest));
  }
  return { ok: errors.length === 0, errors, subjects: s.subjects, rekor: s.rekor };
}

/** @param {string[]} argv @param {string} name @returns {string | undefined} */
const flag = (argv, name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

/**
 * @param {string[]} argv CLI args
 * @param {Record<string, string | undefined>} [env] environment
 * @param {Exec} [exec] cosign runner (tests inject one)
 * @returns {number} exit code (0 only when every target verified)
 */
export function main(argv, env = process.env, exec) {
  const imagesPath = flag(argv, 'images');
  if (!imagesPath) {
    console.error('usage: verify-images.mjs --images <images.json> [--services a,b] [--summary f]');
    return 2;
  }
  const summary = flag(argv, 'summary');
  const write = (/** @type {string} */ s) => {
    if (summary) appendFileSync(summary, s);
    else process.stdout.write(s);
  };
  try {
    const id = loadIdentity(JSON.parse(readFileSync(path.join(ROOT, IDENTITY_FILE), 'utf8')));
    if (id.errors.length > 0) {
      for (const e of id.errors) console.error(`::error::${IDENTITY_FILE}: ${e}`);
      return 1;
    }
    const services = (flag(argv, 'services') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const plan = planTargets(JSON.parse(readFileSync(imagesPath, 'utf8')), services);
    if (plan.errors.length > 0) {
      for (const e of plan.errors) console.error(`::error::verify-images: ${e}`);
      return 1;
    }
    const timeout = Number(env.VERIFY_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
    const run =
      exec ??
      cosignExec(env.COSIGN_BIN ?? 'cosign', timeout > 0 ? timeout : DEFAULT_TIMEOUT_MS, env);
    let failed = 0;
    write(`### Image verification (issuer \`${id.issuer}\`)\n\n`);
    for (const t of plan.targets) {
      const r = verifyImage(t, id, run);
      if (r.ok) {
        const rekor = r.rekor.map((i) => `[${i}](https://search.sigstore.dev/?logIndex=${i})`);
        write(
          `- verified **${t.service}** \`${t.ref}\`; identity \`${r.subjects.join(', ')}\`; SBOM + SLSA provenance; Rekor ${rekor.join(', ')}\n`,
        );
      } else {
        failed += 1;
        write(`- FAILED **${t.service}** \`${t.ref}\`: ${r.errors.join('; ')}\n`);
        for (const e of r.errors) console.error(`::error::${t.service} ${t.ref}: ${e}`);
      }
    }
    if (failed > 0) {
      console.error(`::error::${failed} image(s) failed verification; refusing to deploy`);
      return 1;
    }
    return 0;
  } catch (e) {
    console.error(`::error::verify-images: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
