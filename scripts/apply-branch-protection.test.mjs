// Tests for the branch-protection script (CI-015, #153): the committed policy against the real
// workflows, and the apply / check flow against an in-memory fake of the rulesets API.

import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import {
  CHECKS_PATH,
  REGISTRY_PATH,
  RULESET_PATH,
  buildRuleset,
  codeOwnersActive,
  jobNames,
  loadRequiredChecks,
  main,
  normalize,
  sameRuleset,
  verifyRepo,
} from './apply-branch-protection.mjs';
import { REPO_ROOT } from './test-fixtures.mjs';

/** @type {string[]} */
const tmpDirs = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A scratch copy of just the files the script reads. */
function scratch() {
  const dir = mkdtempSync(path.join(tmpdir(), 'bw-bp-'));
  tmpDirs.push(dir);
  for (const rel of ['.github/workflows', '.github/rulesets', CHECKS_PATH, REGISTRY_PATH]) {
    cpSync(path.join(REPO_ROOT, rel), path.join(dir, rel), { recursive: true });
  }
  return dir;
}

/** @param {unknown} v @returns {Record<string, unknown>} */
const obj = (v) => {
  assert.ok(typeof v === 'object' && v !== null && !Array.isArray(v));
  return /** @type {Record<string, unknown>} */ (v);
};

/** In-memory fake of the repository rulesets API. */
function fakeApi() {
  /** @type {Map<string, Record<string, unknown>>} */
  const store = new Map();
  /** @type {string[]} */
  const calls = [];
  /** @type {string[]} */
  const auth = [];
  let next = 1;
  /** @type {(url: string, init: RequestInit) => Response} */
  const handle = (url, init) => {
    const method = init.method ?? 'GET';
    const route = url.replace(/^.*\/rulesets/, '/rulesets');
    calls.push(`${method} ${route}`);
    auth.push(String(obj(init.headers).authorization));
    const body = typeof init.body === 'string' ? obj(JSON.parse(init.body)) : {};
    const json = (/** @type {unknown} */ v) => new Response(JSON.stringify(v), { status: 200 });
    if (method === 'GET' && route.startsWith('/rulesets?')) {
      return json([...store.values()].map((r) => ({ id: r.id, name: r.name })));
    }
    if (method === 'POST') {
      const id = next++;
      store.set(String(id), { ...body, id });
      return json(store.get(String(id)));
    }
    const id = route.split('/')[2] ?? '';
    if (method === 'GET') return json(store.get(id));
    if (method === 'PUT') {
      store.set(id, { ...body, id: Number(id) });
      return json(store.get(id));
    }
    return new Response('{}', { status: 404 });
  };
  /** @type {(url: string, init: RequestInit) => Promise<Response>} */
  const fetchImpl = (url, init) => Promise.resolve(handle(url, init));
  return { store, calls, auth, fetchImpl };
}

/** @param {string} root @param {string[]} argv @param {ReturnType<typeof fakeApi>} api */
async function run(root, argv, api) {
  /** @type {string[]} */
  const out = [];
  /** @type {string[]} */
  const err = [];
  const code = await main(argv, {
    root,
    env: { BW_GITHUB_ADMIN_TOKEN: 'test-token-value' },
    fetchImpl: api.fetchImpl,
    out: (s) => out.push(s),
    err: (s) => err.push(s),
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

describe('committed branch-protection policy', () => {
  it('is consistent with the real workflows and ruleset', () => {
    assert.deepEqual(verifyRepo(REPO_ROOT), []);
  });

  it('requires every check named in the issue', () => {
    const contexts = loadRequiredChecks(REPO_ROOT).map((c) => c.context);
    for (const c of [
      'lint',
      'typecheck',
      'commitlint',
      'unit',
      'integration',
      'go',
      'gitleaks',
      'drift',
      'dependency-review',
      'required-checks',
    ]) {
      assert.ok(contexts.includes(c), c);
    }
  });

  it('enforces linear history, no force-push, no deletion, stale-review dismissal, conversation resolution and up-to-date branches', () => {
    const ruleset = obj(JSON.parse(readFileSync(path.join(REPO_ROOT, RULESET_PATH), 'utf8')));
    const rules = /** @type {Record<string, unknown>[]} */ (ruleset.rules);
    const types = rules.map((r) => r.type);
    for (const t of [
      'deletion',
      'non_fast_forward',
      'required_linear_history',
      'pull_request',
      'required_status_checks',
    ]) {
      assert.ok(types.includes(t), t);
    }
    const pr = obj(obj(rules.find((r) => r.type === 'pull_request')).parameters);
    assert.equal(pr.dismiss_stale_reviews_on_push, true);
    assert.equal(pr.required_review_thread_resolution, true);
    assert.ok(Number(pr.required_approving_review_count) >= 1);
    const sc = obj(obj(rules.find((r) => r.type === 'required_status_checks')).parameters);
    assert.equal(sc.strict_required_status_checks_policy, true);
  });

  it('has no bypass actors, so administrators are subject to it', () => {
    assert.deepEqual(buildRuleset(REPO_ROOT).bypass_actors, []);
  });

  it('keeps code-owner review off while the CODEOWNERS teams are placeholders and on once active', () => {
    assert.equal(codeOwnersActive(REPO_ROOT), false);
    const dir = scratch();
    const registry = path.join(dir, REGISTRY_PATH);
    writeFileSync(
      registry,
      readFileSync(registry, 'utf8').replaceAll('| placeholder |', '| active |'),
    );
    assert.equal(codeOwnersActive(dir), true);
    const pr = obj(
      obj(
        /** @type {Record<string, unknown>[]} */ (buildRuleset(dir).rules).find(
          (r) => r.type === 'pull_request',
        ),
      ).parameters,
    );
    assert.equal(pr.require_code_owner_review, true);
    // The committed ruleset is stale until regenerated: verify reports it.
    assert.ok(verifyRepo(dir).some((e) => e.includes(RULESET_PATH)));
  });

  it('adds required_signatures only when asked', () => {
    const types = /** @type {Record<string, unknown>[]} */ (
      buildRuleset(REPO_ROOT, { requireSignatures: true }).rules
    ).map((r) => r.type);
    assert.ok(types.includes('required_signatures'));
    assert.ok(
      !(
        /** @type {Record<string, unknown>[]} */ (buildRuleset(REPO_ROOT).rules).some(
          (r) => r.type === 'required_signatures',
        )
      ),
    );
  });

  it('detects check-name drift between required-checks.json and the workflows', () => {
    const dir = scratch();
    const file = path.join(dir, '.github/workflows/test.yml');
    writeFileSync(file, readFileSync(file, 'utf8').replace(/^ {2}unit:$/m, '  unit-tests:'));
    assert.ok(verifyRepo(dir).some((e) => e.includes('"unit"') && e.includes('drift')));
  });

  it('detects a missing required check and a ruleset that no longer matches', () => {
    const dir = scratch();
    const checks = path.join(dir, CHECKS_PATH);
    writeFileSync(
      checks,
      readFileSync(checks, 'utf8').replace(
        '{ "context": "gitleaks", "workflow": "secret-scan.yml" },',
        '',
      ),
    );
    const errors = verifyRepo(dir);
    assert.ok(errors.some((e) => e.includes('"gitleaks" is missing')));
    assert.ok(errors.some((e) => e.includes(RULESET_PATH)));
  });

  it('keeps path-conditional jobs from deadlocking: go.yml has no paths filter and pr.yml has the aggregator', () => {
    const go = readFileSync(path.join(REPO_ROOT, '.github/workflows/go.yml'), 'utf8');
    assert.ok(!/^\s+paths:/m.test(go));
    assert.ok(jobNames(go).includes('go'));
    assert.ok(
      jobNames(readFileSync(path.join(REPO_ROOT, '.github/workflows/pr.yml'), 'utf8')).includes(
        'required-checks',
      ),
    );
  });
});

describe('apply-branch-protection (against a fake rulesets API)', () => {
  it('creates the ruleset, then is idempotent', async () => {
    const api = fakeApi();
    const first = await run(REPO_ROOT, ['--apply'], api);
    assert.equal(first.code, 0, first.err);
    assert.equal(obj(JSON.parse(first.out)).action, 'created');
    assert.equal(api.store.size, 1);
    const second = await run(REPO_ROOT, ['--apply'], api);
    assert.equal(second.code, 0, second.err);
    assert.equal(obj(JSON.parse(second.out)).action, 'unchanged');
    assert.equal(api.store.size, 1);
    assert.ok(
      !api.calls
        .slice(api.calls.length - 2)
        .some((c) => c.startsWith('PUT') || c.startsWith('POST')),
    );
    assert.ok(sameRuleset(obj(JSON.parse(second.out)).ruleset, buildRuleset(REPO_ROOT)));
  });

  it('prints the resulting ruleset as JSON and never prints the token', async () => {
    const api = fakeApi();
    const res = await run(REPO_ROOT, ['--apply'], api);
    assert.ok(!res.out.includes('test-token-value') && !res.err.includes('test-token-value'));
    assert.ok(api.auth.every((a) => a === 'Bearer test-token-value'));
    assert.equal(normalize(obj(JSON.parse(res.out)).ruleset).name, 'main-protection');
  });

  it('repairs a weakened live ruleset on --apply and reports it as drift on --check', async () => {
    const api = fakeApi();
    await run(REPO_ROOT, ['--apply'], api);
    const live = [...api.store.values()][0] ?? {};
    live.rules = /** @type {Record<string, unknown>[]} */ (live.rules).filter(
      (r) => r.type !== 'non_fast_forward',
    );
    const check = await run(REPO_ROOT, ['--check'], api);
    assert.equal(check.code, 1);
    assert.equal(obj(JSON.parse(check.out)).action, 'drift');
    const fix = await run(REPO_ROOT, ['--apply'], api);
    assert.equal(obj(JSON.parse(fix.out)).action, 'updated');
    assert.equal((await run(REPO_ROOT, ['--check'], api)).code, 0);
  });

  it('--check on a repository without the ruleset fails', async () => {
    const res = await run(REPO_ROOT, ['--check'], fakeApi());
    assert.equal(res.code, 1);
    assert.equal(obj(JSON.parse(res.out)).action, 'missing');
  });

  it('requires an admin token and refuses to run with an inconsistent policy', async () => {
    const noToken = await main(['--apply'], {
      root: REPO_ROOT,
      env: {},
      out: () => undefined,
      err: () => undefined,
    });
    assert.equal(noToken, 2);
    const dir = scratch();
    const file = path.join(dir, '.github/workflows/test.yml');
    writeFileSync(file, readFileSync(file, 'utf8').replace(/^ {2}unit:$/m, '  unit-tests:'));
    const api = fakeApi();
    const res = await run(dir, ['--apply'], api);
    assert.equal(res.code, 1);
    assert.equal(api.calls.length, 0);
  });

  it('reports API failures by status only', async () => {
    const res = await main(['--apply'], {
      root: REPO_ROOT,
      env: { BW_GITHUB_ADMIN_TOKEN: 'test-token-value' },
      fetchImpl: () => Promise.resolve(new Response('secret body', { status: 403 })),
      out: () => undefined,
      err: (s) => {
        assert.ok(!s.includes('secret body') && !s.includes('test-token-value'));
      },
    });
    assert.equal(res, 1);
  });
});
