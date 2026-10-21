#!/usr/bin/env node
// Applies, idempotently, the branch-protection ruleset for `main` (CI-015, #153) through the
// GitHub rulesets API, and verifies the committed files against the workflows.
//
// The desired state is committed: `.github/rulesets/main.json` (the full ruleset) and
// `.github/required-checks.json` (the one place the required check names live). This script
// rebuilds the ruleset from those, so the two files cannot silently drift from each other.
//
// Usage:
//   node scripts/apply-branch-protection.mjs --verify                 offline: files vs workflows
//   node scripts/apply-branch-protection.mjs --check  [--repo o/r]    live drift check (exit 1 on drift)
//   node scripts/apply-branch-protection.mjs --apply  [--repo o/r]    create or update the ruleset
//   --require-signatures   also require signed commits (optional, off by default)
//   --api <url>            API base (default https://api.github.com; tests use a local fake)
//
// OFFLINE-STUB(online-porting #897): tested against an in-memory fake API, not live GitHub.
//
// The admin token comes from BW_GITHUB_ADMIN_TOKEN (or GITHUB_ADMIN_TOKEN) at run time. It is
// never read from a file, never printed and never committed.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse } from 'yaml';

export const RULESET_PATH = '.github/rulesets/main.json';
export const CHECKS_PATH = '.github/required-checks.json';
export const REGISTRY_PATH = 'docs/runbooks/code-owners.md';
export const DEFAULT_REPO = 'TinycrowsLab/Blacwing_SAAS';
const NO_CONTENT = 204;
export const RULESET_NAME = 'main-protection';
/** Paths whose CODEOWNERS review is mandatory (issue #153, requirement 2). */
export const SECURITY_PATHS = [
  'apps/egress-gateway/**',
  'packages/policy/**',
  'packages/crypto/**',
  '.trivyignore',
  '.gitleaks.toml',
];

/**
 * @param {unknown} v
 * @returns {v is Record<string, unknown>}
 */
const isRecord = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/** @param {unknown} error */
const message = (error) => (error instanceof Error ? error.message : String(error));

/**
 * @param {string} root
 * @returns {{ context: string, workflow: string }[]}
 */
export function loadRequiredChecks(root) {
  const doc = /** @type {unknown} */ (
    JSON.parse(readFileSync(path.join(root, CHECKS_PATH), 'utf8'))
  );
  const list = isRecord(doc) && Array.isArray(doc.required) ? doc.required : [];
  return list.flatMap((c) =>
    isRecord(c) && typeof c.context === 'string' && typeof c.workflow === 'string'
      ? [{ context: c.context, workflow: c.workflow }]
      : [],
  );
}

/**
 * True only when every owner in the CODEOWNERS registry is `active`. A placeholder team cannot
 * give a review, so requiring code-owner review would block every merge on its paths.
 * @param {string} root
 * @returns {boolean}
 */
export function codeOwnersActive(root) {
  const file = path.join(root, REGISTRY_PATH);
  if (!existsSync(file)) return false;
  const rows = readFileSync(file, 'utf8')
    .split('\n')
    .map((l) => /^\|\s*`@[^`]+`\s*\|\s*([a-z-]+)\s*\|/.exec(l)?.[1])
    .filter((s) => s !== undefined);
  return rows.length > 0 && rows.every((s) => s === 'active');
}

/**
 * @param {string} root
 * @param {{ requireSignatures?: boolean, codeOwners?: boolean }} [opts]
 * @returns {Record<string, unknown>}
 */
export function buildRuleset(root, opts = {}) {
  const checks = loadRequiredChecks(root);
  const codeOwners = opts.codeOwners ?? codeOwnersActive(root);
  /** @type {Record<string, unknown>[]} */
  const rules = [
    { type: 'deletion' },
    { type: 'non_fast_forward' },
    { type: 'required_linear_history' },
    {
      type: 'pull_request',
      parameters: {
        required_approving_review_count: 1,
        dismiss_stale_reviews_on_push: true,
        require_code_owner_review: codeOwners,
        require_last_push_approval: true,
        required_review_thread_resolution: true,
      },
    },
    {
      type: 'required_status_checks',
      parameters: {
        strict_required_status_checks_policy: true,
        required_status_checks: checks.map((c) => ({ context: c.context })),
      },
    },
  ];
  if (opts.requireSignatures) rules.push({ type: 'required_signatures' });
  return {
    name: RULESET_NAME,
    target: 'branch',
    enforcement: 'active',
    conditions: { ref_name: { include: ['refs/heads/main'], exclude: [] } },
    // No bypass actors: administrators are subject to the ruleset too.
    bypass_actors: [],
    rules,
  };
}

/**
 * Reduces a ruleset (desired or live) to the fields this script manages, in a stable order.
 * @param {unknown} ruleset
 * @returns {Record<string, unknown>}
 */
export function normalize(ruleset) {
  const r = isRecord(ruleset) ? ruleset : {};
  const rules = (Array.isArray(r.rules) ? r.rules : [])
    .filter((x) => isRecord(x))
    .map((rule) => {
      const out = /** @type {Record<string, unknown>} */ ({ type: rule.type });
      const params = isRecord(rule.parameters) ? rule.parameters : undefined;
      if (rule.type === 'required_status_checks' && params) {
        const list = Array.isArray(params.required_status_checks)
          ? params.required_status_checks
          : [];
        out.parameters = {
          strict_required_status_checks_policy:
            params.strict_required_status_checks_policy === true,
          required_status_checks: list
            .filter((x) => isRecord(x))
            .map((c) => String(c.context))
            .sort()
            .map((context) => ({ context })),
        };
      } else if (rule.type === 'pull_request' && params) {
        out.parameters = {
          required_approving_review_count: Number(params.required_approving_review_count ?? 0),
          dismiss_stale_reviews_on_push: params.dismiss_stale_reviews_on_push === true,
          require_code_owner_review: params.require_code_owner_review === true,
          require_last_push_approval: params.require_last_push_approval === true,
          required_review_thread_resolution: params.required_review_thread_resolution === true,
        };
      }
      return out;
    });
  rules.sort((a, b) => String(a.type).localeCompare(String(b.type)));
  const cond =
    isRecord(r.conditions) && isRecord(r.conditions.ref_name) ? r.conditions.ref_name : {};
  return {
    name: r.name,
    target: r.target,
    enforcement: r.enforcement,
    include: Array.isArray(cond.include) ? cond.include.map(String).sort() : [],
    exclude: Array.isArray(cond.exclude) ? cond.exclude.map(String).sort() : [],
    bypass_actors: Array.isArray(r.bypass_actors) ? r.bypass_actors : [],
    rules,
  };
}

/**
 * @param {unknown} a
 * @param {unknown} b
 */
export const sameRuleset = (a, b) => JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));

/**
 * Job names in a workflow file: the `name:` of each job, or its key.
 * @param {string} text
 * @returns {string[]}
 */
export function jobNames(text) {
  const doc = /** @type {unknown} */ (parse(text));
  const jobs = isRecord(doc) && isRecord(doc.jobs) ? doc.jobs : {};
  return Object.entries(jobs).map(([key, job]) =>
    isRecord(job) && typeof job.name === 'string' ? job.name : key,
  );
}

/**
 * Offline verification of the committed policy.
 * @param {string} root
 * @returns {string[]} problems
 */
export function verifyRepo(root) {
  /** @type {string[]} */
  const errors = [];
  let checks;
  try {
    checks = loadRequiredChecks(root);
  } catch (error) {
    return [`${CHECKS_PATH}: ${message(error)}`];
  }
  const contexts = checks.map((c) => c.context);
  if (new Set(contexts).size !== contexts.length) errors.push(`${CHECKS_PATH}: duplicate context`);
  for (const must of [
    'required-checks',
    'lint',
    'typecheck',
    'commitlint',
    'unit',
    'integration',
    'go',
    'gitleaks',
    'drift',
    'dependency-review',
  ]) {
    if (!contexts.includes(must))
      errors.push(`${CHECKS_PATH}: required check "${must}" is missing`);
  }
  for (const c of checks) {
    const file = path.join(root, '.github/workflows', c.workflow);
    if (!existsSync(file)) {
      errors.push(`${CHECKS_PATH}: workflow ${c.workflow} for "${c.context}" does not exist`);
      continue;
    }
    let names;
    try {
      names = jobNames(readFileSync(file, 'utf8'));
    } catch (error) {
      errors.push(`${c.workflow}: ${message(error)}`);
      continue;
    }
    if (!names.includes(c.context)) {
      errors.push(
        `${CHECKS_PATH}: no job named "${c.context}" in ${c.workflow} (check-name drift)`,
      );
    }
  }
  const rulesetFile = path.join(root, RULESET_PATH);
  if (!existsSync(rulesetFile)) {
    errors.push(`${RULESET_PATH} is missing`);
  } else {
    try {
      const committed = /** @type {unknown} */ (JSON.parse(readFileSync(rulesetFile, 'utf8')));
      const signatures =
        isRecord(committed) &&
        Array.isArray(committed.rules) &&
        committed.rules.some((r) => isRecord(r) && r.type === 'required_signatures');
      if (!sameRuleset(committed, buildRuleset(root, { requireSignatures: signatures }))) {
        errors.push(
          `${RULESET_PATH} does not match ${CHECKS_PATH} and the CODEOWNERS registry; regenerate it with --write`,
        );
      }
    } catch (error) {
      errors.push(`${RULESET_PATH}: ${message(error)}`);
    }
  }
  return errors;
}

/**
 * @typedef {(url: string, init: RequestInit) => Promise<Response>} Fetch
 */

/**
 * @param {{ api: string, repo: string, token: string, fetchImpl?: Fetch }} ctx
 * @param {string} method
 * @param {string} route
 * @param {unknown} [body]
 * @returns {Promise<unknown>}
 */
async function call(ctx, method, route, body) {
  const doFetch = ctx.fetchImpl ?? fetch;
  /** @type {RequestInit} */
  const init = {
    method,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${ctx.token}`,
      'x-github-api-version': '2022-11-28',
      'content-type': 'application/json',
    },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await doFetch(`${ctx.api}/repos/${ctx.repo}${route}`, init);
  if (!res.ok) {
    // Status only: never echo the response body or the token.
    throw new Error(`GitHub API ${method} ${route} failed with HTTP ${res.status}`);
  }
  return res.status === NO_CONTENT ? undefined : /** @type {unknown} */ (await res.json());
}

/**
 * @param {{ api: string, repo: string, token: string, fetchImpl?: Fetch }} ctx
 * @param {Record<string, unknown>} desired
 * @param {{ apply: boolean }} mode
 * @returns {Promise<{ action: 'created' | 'updated' | 'unchanged' | 'drift' | 'missing', ruleset: unknown }>}
 */
export async function reconcile(ctx, desired, mode) {
  const list = await call(ctx, 'GET', '/rulesets?includes_parents=false');
  const summary = (Array.isArray(list) ? list : [])
    .filter((x) => isRecord(x))
    .find((r) => r.name === RULESET_NAME);
  if (!summary) {
    if (!mode.apply) return { action: 'missing', ruleset: null };
    return { action: 'created', ruleset: await call(ctx, 'POST', '/rulesets', desired) };
  }
  const id = String(summary.id);
  const live = await call(ctx, 'GET', `/rulesets/${id}`);
  if (sameRuleset(live, desired)) return { action: 'unchanged', ruleset: live };
  if (!mode.apply) return { action: 'drift', ruleset: live };
  return { action: 'updated', ruleset: await call(ctx, 'PUT', `/rulesets/${id}`, desired) };
}

/**
 * @param {string[]} argv
 * @param {{ root?: string, env?: Record<string, string | undefined>, fetchImpl?: Fetch, out?: (s: string) => void, err?: (s: string) => void }} [io]
 * @returns {Promise<number>} exit code
 */
export async function main(argv, io = {}) {
  const root = io.root ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const env = io.env ?? process.env;
  const out =
    io.out ??
    ((s) => {
      console.log(s);
    });
  const err =
    io.err ??
    ((s) => {
      console.error(s);
    });
  const arg = (/** @type {string} */ name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const requireSignatures = argv.includes('--require-signatures');

  if (argv.includes('--verify')) {
    const errors = verifyRepo(root);
    for (const e of errors) err(e);
    if (errors.length === 0) out('branch protection policy ok');
    return errors.length === 0 ? 0 : 1;
  }
  const desired = buildRuleset(root, { requireSignatures });
  if (argv.includes('--print')) {
    out(JSON.stringify(desired, null, 2));
    return 0;
  }
  const apply = argv.includes('--apply');
  if (!apply && !argv.includes('--check')) {
    err('usage: apply-branch-protection.mjs --verify | --print | --check | --apply [--repo o/r]');
    return 2;
  }
  const token = env.BW_GITHUB_ADMIN_TOKEN ?? env.GITHUB_ADMIN_TOKEN;
  if (!token) {
    err('BW_GITHUB_ADMIN_TOKEN (an admin PAT or app token) is required; it is never committed.');
    return 2;
  }
  const problems = verifyRepo(root);
  if (problems.length > 0) {
    for (const e of problems) err(e);
    err('refusing to touch the live repository while the committed policy is inconsistent');
    return 1;
  }
  if (!codeOwnersActive(root)) {
    err(
      `warning: CODEOWNERS teams are placeholders (#842); require_code_owner_review stays off for ${SECURITY_PATHS.join(', ')}`,
    );
  }
  try {
    const result = await reconcile(
      {
        api: arg('--api') ?? 'https://api.github.com',
        repo: arg('--repo') ?? DEFAULT_REPO,
        token,
        ...(io.fetchImpl ? { fetchImpl: io.fetchImpl } : {}),
      },
      desired,
      { apply },
    );
    out(JSON.stringify({ action: result.action, ruleset: result.ruleset }, null, 2));
    return result.action === 'drift' || result.action === 'missing' ? 1 : 0;
  } catch (error) {
    err(message(error));
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(await main(process.argv.slice(2)));
}
