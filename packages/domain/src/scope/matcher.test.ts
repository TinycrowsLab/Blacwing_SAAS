import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  parseScopeRules,
  type ScopeRuleInput,
  type ScopeTarget,
  scopeTargetSchema,
} from '@blackwing/contracts';

import { matchScope, ruleSpecificity } from './matcher.js';

interface Vector {
  name: string;
  rules: unknown;
  target: unknown;
  expect: { inScope: boolean; matchedRuleIndex?: number };
}

const vectorsPath = createRequire(import.meta.url).resolve(
  '@blackwing/contracts/scope.vectors.json',
);
const { vectors } = JSON.parse(readFileSync(vectorsPath, 'utf8')) as { vectors: Vector[] };

describe('matchScope: shared vectors', () => {
  it('has vectors to run', () => {
    expect(vectors.length).toBeGreaterThan(0);
  });

  it.each(vectors.map((v) => [v.name, v] as const))('%s', (_name, vector) => {
    const rules = parseScopeRules(vector.rules);
    const target = scopeTargetSchema.parse(vector.target);
    const decision = matchScope(target, rules);
    expect(decision.inScope).toBe(vector.expect.inScope);
    expect(decision.matchedRuleIndex).toBe(vector.expect.matchedRuleIndex);
    expect(decision.reason.length).toBeGreaterThan(0);
    const expectedRule =
      vector.expect.matchedRuleIndex === undefined
        ? undefined
        : rules.rules[vector.expect.matchedRuleIndex];
    expect(decision.matchedRule).toEqual(expectedRule);
  });
});

describe('matchScope: semantics', () => {
  const host = 'app.example.test';

  it('default-deny returns inScope:false with a reason', () => {
    expect(matchScope({ host }, parseScopeRules({ rules: [] }))).toEqual({
      inScope: false,
      reason: 'default-deny: no rules',
    });
    const other = matchScope(
      { host: 'other.example.test' },
      parseScopeRules({ rules: [{ effect: 'include', host }] }),
    );
    expect(other).toEqual({ inScope: false, reason: 'default-deny: no rule matched' });
  });

  it('reports invalid targets as out of scope instead of throwing', () => {
    const rules = parseScopeRules({ rules: [{ effect: 'include', host, paths: ['/**'] }] });
    for (const target of [
      { host: 'bad host' },
      { ip: '300.1.1.1' },
      { host, port: 1.5 },
      { host, path: '/%' },
      { host, method: 'GE T' },
      {},
    ] satisfies ScopeTarget[]) {
      const decision = matchScope(target, rules);
      expect(decision.inScope, JSON.stringify(target)).toBe(false);
      expect(decision.reason).toMatch(/^default-deny: /);
    }
  });

  it('does not include the query string in the reason', () => {
    const rules = parseScopeRules({ rules: [{ effect: 'include', host }] });
    const decision = matchScope({ host, path: '/a?token=secret' }, rules);
    expect(decision.reason).not.toContain('secret');
  });

  it('orders specificity: exact host > wildcard > cidr; exact path > glob; port > range', () => {
    const [exact, wildcard, cidr, globPath, exactPath, range, port] = parseScopeRules({
      rules: [
        { effect: 'include', host },
        { effect: 'include', host: '*.example.test' },
        { effect: 'include', cidr: '10.0.0.0/8' },
        { effect: 'include', host, paths: ['/a/*'] },
        { effect: 'include', host, paths: ['/a/b'] },
        { effect: 'include', host, ports: [{ from: 1, to: 9 }] },
        { effect: 'include', host, ports: [5] },
      ],
    }).rules.map((rule) => ruleSpecificity(rule));
    expect(exact).toEqual([3, 0, 0, 0, 0]);
    expect(wildcard).toEqual([2, 0, 0, 0, 0]);
    expect(cidr).toEqual([1, 104, 0, 0, 0]);
    expect(globPath?.[2]).toBe(1);
    expect(exactPath?.[2]).toBe(2);
    expect(range?.[3]).toBe(1);
    expect(port?.[3]).toBe(2);
  });

  it('property: include then exclude of the same target is out of scope', () => {
    const label = fc.stringMatching(/^[a-z][a-z0-9]{0,10}$/);
    const ruleArb = fc.record(
      {
        host: fc.oneof(
          label.map((l) => `${l}.example.test`),
          fc.constant('*.example.test'),
        ),
        ports: fc.array(fc.integer({ min: 1, max: 65_535 }), { minLength: 1, maxLength: 3 }),
        paths: fc.array(
          fc.oneof(
            label.map((l) => `/${l}`),
            label.map((l) => `/${l}/**`),
          ),
          { minLength: 1, maxLength: 3 },
        ),
        methods: fc.subarray(['GET', 'POST', 'DELETE'] as const, { minLength: 1 }),
      },
      { requiredKeys: ['host'] },
    );
    fc.assert(
      fc.property(ruleArb, label, fc.array(ruleArb, { maxLength: 3 }), (shape, sub, noise) => {
        const include: ScopeRuleInput = { effect: 'include', ...shape };
        const exclude: ScopeRuleInput = { effect: 'exclude', ...shape };
        const others = noise.map((r): ScopeRuleInput => ({ effect: 'include', ...r }));
        const target: ScopeTarget = {
          host: shape.host.startsWith('*.') ? `${sub}.example.test` : shape.host,
          ...(shape.ports ? { port: shape.ports[0] } : {}),
          ...(shape.paths ? { path: shape.paths[0]?.replace('/**', '/x') } : {}),
          ...(shape.methods ? { method: shape.methods[0] } : {}),
        };
        const inOnly = matchScope(target, parseScopeRules({ rules: [include] }));
        expect(inOnly.inScope).toBe(true);
        // Noise rules that are no more specific than `include` never change the outcome.
        const quiet = others.filter((o) => !isStrictlyMoreSpecific(o, include));
        const both = matchScope(target, parseScopeRules({ rules: [...quiet, include, exclude] }));
        expect(both.inScope).toBe(false);
        expect(both.matchedRule?.effect).toBe('exclude');
        const reversed = matchScope(target, parseScopeRules({ rules: [exclude, include] }));
        expect(reversed.inScope).toBe(false);
      }),
    );
  });
});

function isStrictlyMoreSpecific(a: ScopeRuleInput, b: ScopeRuleInput): boolean {
  const { rules } = parseScopeRules({ rules: [a, b] });
  const [sa, sb] = rules.map((rule) => ruleSpecificity(rule));
  if (!sa || !sb) return false;
  for (let i = 0; i < sa.length; i += 1) {
    const diff = (sa[i] ?? 0) - (sb[i] ?? 0);
    if (diff !== 0) return diff > 0;
  }
  return false;
}
