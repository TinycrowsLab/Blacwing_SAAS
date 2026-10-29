import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import { describe, expect, it } from 'vitest';

import {
  parseScopeRules,
  type ScopeRule,
  type StandingAuthorisationDto,
} from '@blackwing/contracts';

import {
  buildScopeRule,
  budgetPrefill,
  canonicalRule,
  checkBudgets,
  coveringStandingAuthorisations,
  describeDecision,
  describeRule,
  intrusivenessOptions,
  parseTargetInput,
  previewScope,
  rulesNotGrantedBy,
} from './scope-model';

const ASSET_A = '0198f0a0-0000-7000-8000-0000000000e1';
const ASSET_B = '0198f0a0-0000-7000-8000-0000000000e2';
const NOW = new Date('2026-10-30T10:00:00.000Z');

/** A standing authorisation as the API returns it, with defaults the individual tests override. */
function sa(overrides: Partial<StandingAuthorisationDto> = {}): StandingAuthorisationDto {
  return {
    id: 'sa_01m64cavacexhrddgjb6xd80xv',
    assetIds: [ASSET_A, ASSET_B],
    scopeRules: {
      rules: [{ effect: 'include', host: 'app.example.test' }],
    },
    maxIntrusiveness: 'active_safe',
    preApprovedTestClasses: [],
    defaultBudgets: { costCapUsd: 20, maxRequests: 1000, maxDurationMs: 3_600_000 },
    testWindows: [],
    validFrom: '2026-10-01T00:00:00.000Z',
    expiresAt: '2026-11-30T00:00:00.000Z',
    requesterId: '0198f0a0-0000-7000-8000-0000000000a1',
    approverId: '0198f0a0-0000-7000-8000-0000000000a2',
    signature: 'sig',
    signingKeyId: 'key-1',
    status: 'active',
    revocationReason: null,
    version: 1,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

const vectorsPath = createRequire(import.meta.url).resolve(
  '@blackwing/contracts/scope.vectors.json',
);
const { vectors } = JSON.parse(readFileSync(vectorsPath, 'utf8')) as {
  vectors: {
    name: string;
    rules: unknown;
    target: unknown;
    expect: { inScope: boolean; matchedRuleIndex?: number };
  }[];
};

describe('covering standing authorisations', () => {
  it('offers only SAs that cover every selected asset', () => {
    const onlyA = sa({ id: 'sa_a', assetIds: [ASSET_A] });
    const both = sa({ id: 'sa_both' });
    expect(coveringStandingAuthorisations([onlyA, both], [ASSET_A, ASSET_B], NOW)).toEqual([both]);
    expect(coveringStandingAuthorisations([onlyA, both], [ASSET_A], NOW)).toEqual([onlyA, both]);
  });

  it('refuses SAs that are not active, not yet valid or expired', () => {
    expect(
      coveringStandingAuthorisations([sa({ status: 'pending_approval' })], [ASSET_A], NOW),
    ).toEqual([]);
    expect(
      coveringStandingAuthorisations(
        [sa({ status: 'revoked', revocationReason: 'x' })],
        [ASSET_A],
        NOW,
      ),
    ).toEqual([]);
    expect(
      coveringStandingAuthorisations(
        [sa({ validFrom: '2026-11-01T00:00:00.000Z' })],
        [ASSET_A],
        NOW,
      ),
    ).toEqual([]);
    expect(
      coveringStandingAuthorisations(
        [sa({ expiresAt: '2026-10-30T09:59:59.000Z' })],
        [ASSET_A],
        NOW,
      ),
    ).toEqual([]);
  });

  it('offers nothing when no asset is selected', () => {
    expect(coveringStandingAuthorisations([sa()], [], NOW)).toEqual([]);
  });
});

describe('rules against the SA grant', () => {
  it('matches a rule to the SA rule whatever the order of its keys', () => {
    expect(canonicalRule({ effect: 'include', host: 'a.test' })).toBe(
      canonicalRule({ host: 'a.test', effect: 'include' }),
    );
  });

  it('flags every rule the SA does not grant exactly, including a narrower one', () => {
    const granted = sa();
    const exact: ScopeRule = { effect: 'include', host: 'app.example.test' };
    const narrower: ScopeRule = { effect: 'include', host: 'app.example.test', paths: ['/admin'] };
    const other: ScopeRule = { effect: 'exclude', host: 'app.example.test' };
    expect(rulesNotGrantedBy([exact, narrower, other], granted)).toEqual([1, 2]);
  });
});

describe('intrusiveness picker', () => {
  it('never offers destructive, even when the SA ceiling is state-changing', () => {
    const options = intrusivenessOptions(sa({ maxIntrusiveness: 'state_changing' }));
    expect(options.map((option) => option.value)).toEqual([
      'passive',
      'active_safe',
      'state_changing',
    ]);
    expect(options.every((option) => option.allowed)).toBe(true);
  });

  it('disables every option above the SA ceiling, with a reason', () => {
    const options = intrusivenessOptions(sa({ maxIntrusiveness: 'passive' }));
    expect(options.map((option) => [option.value, option.allowed])).toEqual([
      ['passive', true],
      ['active_safe', false],
      ['state_changing', false],
    ]);
    expect(options[1]?.disabledReason).toMatch(/ceiling \(Passive\)/);
    expect(options[0]?.disabledReason).toBeNull();
  });
});

describe('budgets', () => {
  it('pre-fills the request count from the class default, clamped to the SA bound', () => {
    expect(
      budgetPrefill(
        'active_safe',
        sa({ defaultBudgets: { costCapUsd: 5, maxRequests: 500, maxDurationMs: 60_000 } }),
      ),
    ).toEqual({
      maxRequests: 500,
      costCapUsd: 5,
      maxDurationMs: 60_000,
    });
    expect(
      budgetPrefill(
        'passive',
        sa({ defaultBudgets: { costCapUsd: 5, maxRequests: 9000, maxDurationMs: 60_000 } }),
      ),
    ).toEqual({
      maxRequests: 200,
      costCapUsd: 5,
      maxDurationMs: 60_000,
    });
  });

  it('accepts a budget within the SA defaults and drops empty fields', () => {
    const result = checkBudgets({ maxRequests: 800, costCapUsd: 10 }, sa());
    expect(result).toEqual({ ok: true, budgets: { maxRequests: 800, costCapUsd: 10 } });
  });

  it('refuses a budget above the SA default on any bounded dimension', () => {
    const result = checkBudgets({ maxRequests: 1001 }, sa());
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.message).toMatch(/above the standing authorisation default/);
    expect(checkBudgets({ costCapUsd: 20.01 }, sa()).ok).toBe(false);
  });

  it('refuses values the run-budget schema rejects, naming the field and not the value', () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = checkBudgets({ maxRequests: bad }, sa());
      expect(result.ok).toBe(false);
      expect(result.ok ? '' : result.message).toMatch(/maxRequests/);
    }
  });
});

describe('target preview', () => {
  it('reads a host, a URL with a port and an IP, normalising the host', () => {
    expect(parseTargetInput('App.Example.Test')).toMatchObject({
      ok: true,
      target: { host: 'app.example.test', port: 443, path: '/', method: 'GET' },
    });
    expect(parseTargetInput('http://app.example.test:8080/login')).toMatchObject({
      ok: true,
      target: { host: 'app.example.test', port: 8080, path: '/login' },
    });
    expect(parseTargetInput('10.0.0.5')).toMatchObject({
      ok: true,
      target: { ip: '10.0.0.5', port: 443 },
    });
  });

  it('turns a punycode host the way the server does (IDNA)', () => {
    expect(parseTargetInput('bücher.example.test')).toMatchObject({
      ok: true,
      target: { host: 'xn--bcher-kva.example.test' },
    });
  });

  it('refuses empty and malformed input with a reason', () => {
    const empty = parseTargetInput('   ');
    expect(empty.ok).toBe(false);
    expect(empty.ok ? '' : empty.message).toMatch(/Enter a host/);
    expect(parseTargetInput('bad host name').ok).toBe(false);
    expect(parseTargetInput('https://[::').ok).toBe(false);
  });

  it('agrees with the shared scope vectors: the preview gives the server matcher result', () => {
    expect(vectors.length).toBeGreaterThan(0);
    for (const vector of vectors) {
      const rules = parseScopeRules(vector.rules).rules;
      const decision = previewScope(rules, vector.target as Parameters<typeof previewScope>[1]);
      expect(decision.inScope, vector.name).toBe(vector.expect.inScope);
      expect(decision.matchedRuleIndex, vector.name).toBe(vector.expect.matchedRuleIndex);
    }
  });

  it('describes the outcome in plain words, naming the rule by its position', () => {
    const rules: ScopeRule[] = [
      { effect: 'include', host: 'app.example.test' },
      { effect: 'exclude', host: 'admin.example.test' },
    ];
    const inScope = previewScope(rules, {
      host: 'app.example.test',
      port: 443,
      path: '/',
      method: 'GET',
    });
    expect(describeDecision(inScope)).toBe('In scope: matched rule 1.');
    const excluded = previewScope(
      [
        { effect: 'include', host: '*.example.test' },
        { effect: 'exclude', host: 'admin.example.test' },
      ],
      { host: 'admin.example.test', port: 443, path: '/', method: 'GET' },
    );
    expect(describeDecision(excluded)).toBe('Out of scope: excluded by rule 2.');
    const none = previewScope(rules, { host: 'other.test', port: 443, path: '/', method: 'GET' });
    expect(describeDecision(none)).toMatch(/default deny/);
  });
});

describe('building a rule from the row text', () => {
  const row = { effect: 'include' as const, target: '', ports: '', paths: '', methods: '' };

  it('builds a host rule with ports, paths and methods', () => {
    const built = buildScopeRule({
      ...row,
      target: 'app.example.test',
      ports: '443, 8000-8100',
      paths: '/api/*',
      methods: 'get, post',
    });
    expect(built).toEqual({
      ok: true,
      rule: {
        effect: 'include',
        host: 'app.example.test',
        ports: [443, { from: 8000, to: 8100 }],
        paths: ['/api/*'],
        methods: ['GET', 'POST'],
      },
    });
  });

  it('builds a CIDR rule when the target has a slash', () => {
    const built = buildScopeRule({ ...row, target: '10.0.0.0/24' });
    expect(built.ok && built.rule).toMatchObject({ cidr: '10.0.0.0/24' });
  });

  it('refuses an include with no address, and a wildcard in the wrong place, in plain words', () => {
    expect(buildScopeRule(row)).toEqual({
      ok: false,
      message: 'An include rule needs a host or a CIDR.',
    });
    const wildcard = buildScopeRule({ ...row, target: 'a.*.example.test' });
    expect(wildcard).toEqual({
      ok: false,
      message: 'This rule is not valid. Check the host or CIDR, ports, paths and methods.',
    });
  });

  it('refuses a bad port, a reversed range and an unknown method', () => {
    expect(buildScopeRule({ ...row, target: 'a.example.test', ports: '70000' }).ok).toBe(false);
    expect(buildScopeRule({ ...row, target: 'a.example.test', ports: '900-100' }).ok).toBe(false);
    expect(buildScopeRule({ ...row, target: 'a.example.test', methods: 'DELETEALL' }).ok).toBe(
      false,
    );
  });
});

describe('rule text', () => {
  it('describes a rule in one line', () => {
    expect(
      describeRule({
        effect: 'exclude',
        host: 'admin.example.test',
        ports: [443],
        methods: ['POST'],
      }),
    ).toBe('Exclude admin.example.test; ports 443; methods POST');
  });
});
