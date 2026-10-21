// Offline harness for the kill SLO rules (KILL-007): no promtool on this host, so the rule
// thresholds are checked and the p99 math is fed synthetic histograms.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { parse } from 'yaml';

import { REPO_ROOT } from './test-fixtures.mjs';

/** @typedef {{ alert?: string; record?: string; expr: string; for?: string }} Rule */
/** @type {unknown} */
const parsed = parse(
  readFileSync(path.join(REPO_ROOT, 'infra/k3s/kill/prometheus-rules.yaml'), 'utf8'),
);
const doc = /** @type {{ spec: { groups: { rules: Rule[] }[] } }} */ (parsed);
const rules = doc.spec.groups.flatMap((g) => g.rules);
/** @param {string} name */
const alert = (name) => rules.find((r) => r.alert === name);

// The CONTEXT_PACK 8.5 budgets and the worker halt buckets (apps/worker/src/kill/metrics.ts).
const EGRESS_BUDGET_MS = 2000;
const HALT_BUDGET_MS = 10_000;
const HALT_BUCKETS = [100, 250, 500, 1000, 1500, 2000, 3000, 5000, 7500, 10000, 15000, 30000];

/**
 * Prometheus histogram_quantile over cumulative buckets (linear interpolation inside a bucket).
 * @param {number} q
 * @param {number[]} bounds
 * @param {number[]} cumulative
 */
function quantile(q, bounds, cumulative) {
  const total = cumulative[cumulative.length - 1];
  const rank = q * total;
  const i = cumulative.findIndex((c) => c >= rank);
  const lower = i === 0 ? 0 : (bounds[i - 1] ?? 0);
  const below = i === 0 ? 0 : (cumulative[i - 1] ?? 0);
  return lower + (((bounds[i] ?? 0) - lower) * (rank - below)) / ((cumulative[i] ?? 0) - below);
}

/**
 * @param {number} n
 * @param {number} value
 */
const rep = (n, value) => Array.from({ length: n }, () => value);

/** @param {number[]} values */
function observe(values) {
  let n = 0;
  return HALT_BUCKETS.map((le) => {
    n = values.filter((v) => v <= le).length;
    return n;
  });
}

/**
 * Evaluates `<metric>... > N` against a computed p99.
 * @param {Rule | undefined} rule
 * @param {number} p99
 */
function fires(rule, p99) {
  const threshold = Number(/> (\d+)$/.exec(rule?.expr ?? '')?.[1]);
  return p99 > threshold;
}

describe('kill SLO rules', () => {
  it('alerts use the 2 s / 10 s budgets from the spec', () => {
    assert.match(alert('KillEgressBlockSloBreached').expr, /stage="egress"\} > 2000$/);
    assert.match(alert('KillFullHaltSloBreached').expr, /p99 > 10000$/);
    assert.equal(EGRESS_BUDGET_MS, 2000);
    assert.equal(HALT_BUDGET_MS, 10_000);
  });

  it('records p50, p95 and p99 over 1 h for the halt and per-stage histograms', () => {
    for (const metric of ['bw_kill_halt_ms', 'bw_kill_stage_latency_ms']) {
      for (const q of ['p50', 'p95', 'p99']) {
        const rec = rules.find((r) => r.record === `blackwing:${metric}:${q}`);
        assert.ok(rec, `${metric}:${q}`);
        assert.match(rec.expr, new RegExp(`${metric}_bucket\\[1h\\]`));
      }
    }
  });

  it('full-halt alert fires for a synthetic slow halt and stays quiet within budget', () => {
    const slow = observe([...rep(90, 3000), ...rep(10, 14_000)]);
    const fast = observe(rep(100, 3000));
    assert.equal(fires(alert('KillFullHaltSloBreached'), quantile(0.99, HALT_BUCKETS, slow)), true);
    assert.equal(
      fires(alert('KillFullHaltSloBreached'), quantile(0.99, HALT_BUCKETS, fast)),
      false,
    );
  });

  it('pages on any kill that ends partially_halted or failed', () => {
    const rule = alert('KillEndedUnhealthy');
    assert.match(rule.expr, /status=~"partially_halted\|failed"/);
    assert.match(rule.expr, /> 0$/);
  });

  it('keeps cardinality bounded: only the stage label, never a run or tenant id', () => {
    const exprs = rules.map((r) => r.expr).join('\n');
    assert.doesNotMatch(exprs, /run_id|tenant_id|kill_event_id/);
  });
});
