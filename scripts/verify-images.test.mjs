// Tests for the deploy-time verification gate (CI-011, #145). A fake `cosign` binary stands in
// for Sigstore so every failure mode (unsigned, foreign identity, missing attestation, Rekor
// outage, timeout) is exercised offline against a dummy image digest.

import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { parse } from 'yaml';

import { IDENTITY_FILE, loadIdentity } from './signing.mjs';
import { REPO_ROOT } from './test-fixtures.mjs';
import {
  ATTESTATIONS,
  FORBIDDEN_FLAGS,
  checkAttestation,
  checkSignature,
  cosignExec,
  main,
  planTargets,
  verifyImage,
} from './verify-images.mjs';

const DIGEST = `sha256:${'a'.repeat(64)}`;
const OTHER = `sha256:${'b'.repeat(64)}`;
const REF = `ghcr.io/tinycrowslab/bw-api@${DIGEST}`;
const id = loadIdentity(JSON.parse(readFileSync(path.join(REPO_ROOT, IDENTITY_FILE), 'utf8')));
const GOOD_SUBJECT =
  'https://github.com/TinycrowsLab/Blacwing_SAAS/.github/workflows/build-images.yml@refs/heads/main';
const target = { service: 'api', ref: REF, digest: DIGEST };

/**
 * @param {{ subject?: string, issuer?: string, digest?: string, logIndex?: number | null }} [o]
 * @returns {string} cosign verify --output json
 */
const sigJson = (o = {}) =>
  JSON.stringify([
    {
      critical: { image: { 'docker-manifest-digest': o.digest ?? DIGEST }, type: 'cosign' },
      optional: {
        Issuer: o.issuer ?? id.issuer,
        Subject: o.subject ?? GOOD_SUBJECT,
        ...(o.logIndex === null ? {} : { Bundle: { Payload: { logIndex: o.logIndex ?? 99 } } }),
      },
    },
  ]);

/** @param {string} predicateType @param {string} [digest] @returns {string} DSSE envelope line */
const attLine = (predicateType, digest = DIGEST) =>
  JSON.stringify({
    payloadType: 'application/vnd.in-toto+json',
    payload: Buffer.from(
      JSON.stringify({
        _type: 'https://in-toto.io/Statement/v1',
        predicateType,
        subject: [{ name: 'ghcr.io/tinycrowslab/bw-api', digest: { sha256: digest.slice(7) } }],
        predicate: {},
      }),
    ).toString('base64'),
  });

/**
 * In-process fake cosign: `sig`/`att` override the per-command result.
 * @param {{ sig?: { status: number, stdout?: string, stderr?: string },
 *   att?: Record<string, { status: number, stdout?: string, stderr?: string }> }} [o]
 * @returns {{ exec: import('./verify-images.mjs').Exec, calls: string[][] }}
 */
const fake = (o = {}) => {
  /** @type {string[][]} */
  const calls = [];
  return {
    calls,
    exec: (args) => {
      calls.push(args);
      if (args[0] === 'verify') {
        const r = o.sig ?? { status: 0, stdout: sigJson() };
        return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
      }
      const type = args[args.indexOf('--type') + 1] ?? '';
      const pt = /** @type {Record<string, string>} */ (ATTESTATIONS)[type] ?? '';
      const r = o.att?.[type] ?? { status: 0, stdout: `${attLine(pt)}\n` };
      return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
    },
  };
};

describe('planTargets', () => {
  it('takes every digest-pinned entry, or the requested subset', () => {
    const imgs = { api: REF, web: REF.replace('bw-api', 'bw-web') };
    assert.equal(planTargets(imgs).targets.length, 2);
    assert.deepEqual(
      planTargets(imgs, ['web']).targets.map((t) => t.service),
      ['web'],
    );
  });

  it('rejects tags, unknown services, empty and malformed input', () => {
    assert.match(planTargets({ api: 'ghcr.io/x/bw-api:latest' }).errors[0] ?? '', /digest/);
    assert.match(planTargets({ api: REF }, ['worker']).errors[0] ?? '', /not in images/);
    assert.match(planTargets({}).errors[0] ?? '', /no images/);
    assert.ok(planTargets([]).errors.length > 0);
  });
});

describe('verifyImage', () => {
  it('passes an image signed and attested by the CI-010 identity', () => {
    const f = fake();
    const r = verifyImage(target, id, f.exec);
    assert.deepEqual(r.errors, []);
    assert.ok(r.ok);
    assert.deepEqual(r.subjects, [GOOD_SUBJECT]);
    assert.deepEqual(r.rekor, [99]);
    // Exact identity + issuer on every call, and both attestation types are checked.
    assert.equal(f.calls.length, 3);
    for (const c of f.calls) {
      assert.equal(c[c.indexOf('--certificate-identity-regexp') + 1], id.identityRegexp);
      assert.equal(c[c.indexOf('--certificate-oidc-issuer') + 1], id.issuer);
      assert.equal(c.at(-1), REF);
      for (const bad of FORBIDDEN_FLAGS) assert.ok(!c.includes(bad), bad);
    }
    assert.deepEqual(
      f.calls.slice(1).map((c) => c[c.indexOf('--type') + 1]),
      ['cyclonedx', 'slsaprovenance1'],
    );
  });

  it('fails an unsigned image', () => {
    const r = verifyImage(
      target,
      id,
      fake({ sig: { status: 1, stderr: 'Error: no signatures found' } }).exec,
    );
    assert.ok(!r.ok);
    assert.match(r.errors.join(), /no signatures found/);
  });

  it('fails a wrong-identity or wrong-issuer signature even if cosign accepted it', () => {
    for (const subject of [
      GOOD_SUBJECT.replace('Blacwing_SAAS', 'Evil'),
      GOOD_SUBJECT.replace('build-images', 'other'),
      GOOD_SUBJECT.replace('refs/heads/main', 'refs/heads/feature'),
    ]) {
      const r = verifyImage(
        target,
        id,
        fake({ sig: { status: 0, stdout: sigJson({ subject }) } }).exec,
      );
      assert.match(r.errors.join(), /unexpected identity/, subject);
    }
    const iss = verifyImage(
      target,
      id,
      fake({ sig: { status: 0, stdout: sigJson({ issuer: 'https://accounts.google.com' }) } }).exec,
    );
    assert.match(iss.errors.join(), /unexpected issuer/);
  });

  it('fails a signature for another digest or without a Rekor entry', () => {
    const d = verifyImage(
      target,
      id,
      fake({ sig: { status: 0, stdout: sigJson({ digest: OTHER }) } }).exec,
    );
    assert.match(d.errors.join(), /another digest/);
    const n = verifyImage(
      target,
      id,
      fake({ sig: { status: 0, stdout: sigJson({ logIndex: null }) } }).exec,
    );
    assert.match(n.errors.join(), /no Rekor entry/);
  });

  it('fails when the signature is present but an attestation is missing', () => {
    for (const type of Object.keys(ATTESTATIONS)) {
      const r = verifyImage(
        target,
        id,
        fake({ att: { [type]: { status: 1, stderr: 'none of the attestations matched' } } }).exec,
      );
      assert.ok(!r.ok, type);
      assert.match(r.errors.join(), new RegExp(type));
    }
  });

  it('fails an attestation of the wrong predicate type or for another digest', () => {
    const wrongType = fake({
      att: { slsaprovenance1: { status: 0, stdout: attLine('https://slsa.dev/provenance/v0.2') } },
    });
    assert.match(verifyImage(target, id, wrongType.exec).errors.join(), /provenance\/v1/);
    const wrongDigest = fake({
      att: { cyclonedx: { status: 0, stdout: attLine(ATTESTATIONS.cyclonedx, OTHER) } },
    });
    assert.match(verifyImage(target, id, wrongDigest.exec).errors.join(), /cyclonedx\.org/);
  });

  it('fails closed on a Rekor or registry lookup error', () => {
    const r = verifyImage(
      target,
      id,
      fake({ sig: { status: 1, stderr: 'Error: getting Rekor public keys: connection refused' } })
        .exec,
    );
    assert.ok(!r.ok);
    assert.match(r.errors.join(), /Rekor/);
    const a = verifyImage(
      target,
      id,
      fake({ att: { cyclonedx: { status: 1, stderr: 'GET https://ghcr.io: 503' } } }).exec,
    );
    assert.ok(!a.ok);
  });
});

describe('output re-checks', () => {
  it('reject junk and empty output', () => {
    assert.match(checkSignature('nope', id, DIGEST).errors.join(), /not JSON/);
    assert.match(checkSignature('[]', id, DIGEST).errors.join(), /no signatures/);
    assert.equal(checkAttestation('garbage\n{}', ATTESTATIONS.cyclonedx, DIGEST).length, 1);
    assert.deepEqual(
      checkAttestation(attLine(ATTESTATIONS.cyclonedx), ATTESTATIONS.cyclonedx, DIGEST),
      [],
    );
  });
});

describe('main with a fake cosign binary (deploy gate)', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'verify-'));
  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const bin = path.join(dir, 'cosign');
  const sigOk = sigJson();
  const att = Object.fromEntries(Object.entries(ATTESTATIONS).map(([k, v]) => [k, attLine(v)]));
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const mode = process.env.FAKE_COSIGN_MODE;
const a = process.argv.slice(2);
if (mode === 'hang') setTimeout(() => {}, 60000);
else if (mode === 'unsigned') { console.error('Error: no matching signatures'); process.exit(1); }
else if (mode === 'rekor') { console.error('Error: rekor lookup failed: dial tcp: i/o timeout'); process.exit(1); }
else if (a[0] === 'verify') process.stdout.write(${JSON.stringify(sigOk)});
else if (mode === 'no-att') { console.error('Error: no matching attestations'); process.exit(1); }
else process.stdout.write(${JSON.stringify(att)}[a[a.indexOf('--type') + 1]] + '\\n');
`,
  );
  chmodSync(bin, 0o755);
  const images = path.join(dir, 'images.json');
  writeFileSync(images, JSON.stringify({ api: REF }));
  /** @param {string} mode @param {Record<string, string>} [extra] @returns {{ code: number, summary: string }} */
  const run = (mode, extra = {}) => {
    const summary = path.join(dir, `${mode}.md`);
    writeFileSync(summary, '');
    const env = { ...process.env, COSIGN_BIN: bin, FAKE_COSIGN_MODE: mode, ...extra };
    const code = main(['--images', images, '--summary', summary], env);
    return { code, summary: readFileSync(summary, 'utf8') };
  };

  it('verifies a CI-010-signed image and logs digest + identity', () => {
    const r = run('ok');
    assert.equal(r.code, 0);
    assert.match(r.summary, /verified \*\*api\*\*/);
    assert.ok(r.summary.includes(DIGEST));
    assert.ok(r.summary.includes(GOOD_SUBJECT));
    assert.match(r.summary, /logIndex=99/);
  });

  it('aborts the deploy for an unsigned dummy image, missing attestation or Rekor outage', () => {
    for (const mode of ['unsigned', 'no-att', 'rekor']) {
      const r = run(mode);
      assert.equal(r.code, 1, mode);
      assert.match(r.summary, /FAILED \*\*api\*\*/, mode);
    }
  });

  it('fails closed on cosign timeout or a missing cosign binary', () => {
    assert.equal(run('hang', { VERIFY_TIMEOUT_MS: '500' }).code, 1);
    assert.equal(run('ok', { COSIGN_BIN: path.join(dir, 'missing') }).code, 1);
    const r = cosignExec(path.join(dir, 'missing'), 500, {})(['version']);
    assert.ok(r.error);
  });

  it('rejects bad arguments and tag-pinned images', () => {
    assert.equal(main([]), 2);
    const tagged = path.join(dir, 'tagged.json');
    writeFileSync(tagged, JSON.stringify({ api: 'ghcr.io/tinycrowslab/bw-api:latest' }));
    assert.equal(main(['--images', tagged], { COSIGN_BIN: bin }), 1);
    assert.equal(main(['--images', path.join(dir, 'nope.json')]), 1);
  });
});

describe('verify-images workflow and cluster policy', () => {
  const wfText = readFileSync(path.join(REPO_ROOT, '.github/workflows/verify-images.yml'), 'utf8');
  /** @type {unknown} */
  const rawWf = parse(wfText);
  const wf = /** @type {{ on: Record<string, unknown>, jobs: Record<string, {
    permissions: Record<string, string>, steps: { run?: string }[], 'continue-on-error'?: unknown }> }} */ (
    rawWf
  );

  it('is reusable only, read-only, and runs the gate without bypass', () => {
    assert.deepEqual(Object.keys(wf.on), ['workflow_call']);
    const job = wf.jobs['verify-images'];
    assert.ok(job);
    assert.equal(job.permissions['id-token'], undefined);
    assert.equal(job.permissions.packages, 'read');
    assert.equal(job['continue-on-error'], undefined);
    assert.ok(job.steps.some((s) => (s.run ?? '').includes('node scripts/verify-images.mjs')));
    for (const bad of [...FORBIDDEN_FLAGS, '|| true']) assert.ok(!wfText.includes(bad), bad);
  });

  it('admission policy pins the same identity, issuer and attestations as CI-010', () => {
    const text = readFileSync(path.join(REPO_ROOT, 'infra/k3s/policy/verify-images.yaml'), 'utf8');
    /** @type {unknown} */
    const raw = parse(text);
    const p = /** @type {{ kind: string, spec: { mode: string, authorities: { keyless: {
      identities: { issuer: string, subjectRegExp: string }[] }, ctlog?: unknown,
      attestations: { predicateType: string }[] }[] } }} */ (raw);
    assert.equal(p.kind, 'ClusterImagePolicy');
    assert.equal(p.spec.mode, 'enforce');
    const [auth] = p.spec.authorities;
    assert.ok(auth);
    assert.ok(auth.ctlog);
    assert.deepEqual(auth.keyless.identities, [
      { issuer: id.issuer, subjectRegExp: id.identityRegexp },
    ]);
    assert.deepEqual(
      auth.attestations.map((a) => a.predicateType),
      Object.keys(ATTESTATIONS),
    );
  });
});
