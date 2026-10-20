import { readFileSync } from 'node:fs';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  formatCidr,
  isScopeRuleError,
  normaliseHost,
  normaliseHostPattern,
  normaliseIp,
  normalisePath,
  parseCidr,
  parseScopeRules,
  ScopeRuleError,
  scopeRuleSchema,
  scopeRulesSchema,
  scopeTargetSchema,
} from './index.js';

interface VectorFile {
  version: number;
  vectors: { name: string; category: string; rules: unknown; target: unknown; expect: unknown }[];
  invalidRules: { name: string; rule: unknown }[];
}

const file = JSON.parse(
  readFileSync(new URL('./scope.vectors.json', import.meta.url), 'utf8'),
) as VectorFile;

describe('scope.vectors.json (shared TS/Go contract)', () => {
  it('is well-formed and non-empty', () => {
    expect(file.version).toBe(1);
    expect(file.vectors.length).toBeGreaterThanOrEqual(40);
    const names = new Set<string>();
    for (const vector of file.vectors) {
      expect(vector.name.length).toBeGreaterThan(0);
      expect(names.has(vector.name), `duplicate vector name ${vector.name}`).toBe(false);
      names.add(vector.name);
      expect(scopeRulesSchema.safeParse(vector.rules).success, vector.name).toBe(true);
      expect(scopeTargetSchema.safeParse(vector.target).success, vector.name).toBe(true);
      expect(vector.expect).toMatchObject({ inScope: expect.any(Boolean) as boolean });
    }
  });

  it('covers every required category', () => {
    const categories = new Set(file.vectors.map((v) => v.category));
    for (const category of [
      'in-scope',
      'excluded',
      'default-deny',
      'wildcard',
      'cidr-v4',
      'cidr-v6',
      'port',
      'method',
      'traversal',
      'idn',
      'unicode-path',
    ]) {
      expect(categories.has(category), category).toBe(true);
    }
  });

  it.each(file.invalidRules.map((v) => [v.name, v.rule] as const))(
    'rejects malformed rule: %s',
    (_name, rule) => {
      const result = scopeRuleSchema.safeParse(rule);
      expect(result.success).toBe(false);
      expect(() => parseScopeRules({ rules: [rule] })).toThrow(ScopeRuleError);
    },
  );
});

describe('parseScopeRules', () => {
  it('canonicalises hosts, cidrs, paths, ports and methods', () => {
    const parsed = parseScopeRules({
      rules: [
        {
          effect: 'include',
          host: 'BÜCHER.Example.test.',
          cidr: '::FFFF:10.0.0.0/104',
          ports: [
            { from: 8080, to: 8080 },
            { from: 1, to: 2 },
          ],
          paths: ['/a//b/./c/', '/caf%C3%A9', '/x%2541'],
          methods: ['get', 'Post'],
        },
      ],
    });
    expect(parsed.rules[0]).toEqual({
      effect: 'include',
      host: 'xn--bcher-kva.example.test',
      cidr: '10.0.0.0/8',
      ports: [8080, { from: 1, to: 2 }],
      paths: ['/a/b/c', '/café', '/x%2541'],
      methods: ['GET', 'POST'],
    });
  });

  it('is idempotent on its own output', () => {
    const once = parseScopeRules({
      rules: [
        { effect: 'include', host: '*.EXAMPLE.test', paths: ['/%2525/a?b', '/q%3Fx%23y'] },
        { effect: 'exclude', cidr: '2001:0DB8:0:0:0:0:0:0/32', methods: ['delete'] },
      ],
    });
    expect(parseScopeRules(once)).toEqual(once);
    expect(once.rules[0]?.paths).toEqual(['/%2525/a', '/q%3Fx%23y']);
    expect(once.rules[1]?.cidr).toBe('2001:db8::/32');
  });

  it('accepts an empty rule set (default-deny is the matcher’s job)', () => {
    expect(parseScopeRules({ rules: [] })).toEqual({ rules: [] });
  });

  it('throws a coded error naming the bad rule', () => {
    let caught: unknown;
    try {
      parseScopeRules({ rules: [{ effect: 'include', host: 'a.example.test' }, { effect: 'x' }] });
    } catch (error) {
      caught = error;
    }
    expect(isScopeRuleError(caught)).toBe(true);
    expect((caught as ScopeRuleError).code).toBe('SCOPE_INVALID_RULE');
    expect((caught as ScopeRuleError).issues.some((p) => p.startsWith('rules.1'))).toBe(true);
    expect(isScopeRuleError(new Error('x'))).toBe(false);
  });

  it('rejects port 0, out-of-range and non-numeric ports', () => {
    for (const ports of [[0], [65_536], ['80'], [-1], [{ from: 0, to: 10 }]]) {
      expect(
        scopeRuleSchema.safeParse({ effect: 'include', host: 'a.example.test', ports }).success,
        JSON.stringify(ports),
      ).toBe(false);
    }
  });
});

describe('normalisation', () => {
  it('maps IDN and punycode hosts to the same form', () => {
    expect(normaliseHost('bücher.example.test')).toBe('xn--bcher-kva.example.test');
    expect(normaliseHost('XN--BCHER-KVA.example.test')).toBe('xn--bcher-kva.example.test');
    expect(normaliseHost('10.0.0.1')).toBeNull();
    expect(normaliseHost('')).toBeNull();
    expect(normaliseHostPattern('*.Example.test')).toBe('*.example.test');
    expect(normaliseHostPattern('*.test')).toBeNull();
  });

  it('normalises IPv4-mapped IPv6 to one representation', () => {
    expect(normaliseIp('::ffff:10.0.0.1')).toBe('10.0.0.1');
    expect(normaliseIp('::FFFF:a00:1')).toBe('10.0.0.1');
    expect(normaliseIp('0:0:0:0:0:ffff:10.0.0.1')).toBe('10.0.0.1');
    expect(normaliseIp('10.0.0.1')).toBe('10.0.0.1');
  });

  it('formats IPv6 per RFC 5952 for compressed and expanded input', () => {
    expect(normaliseIp('2001:0db8:0000:0000:0000:0000:0000:0001')).toBe('2001:db8::1');
    expect(normaliseIp('2001:DB8::1')).toBe('2001:db8::1');
    expect(normaliseIp('2001:db8:0:1:0:0:0:1')).toBe('2001:db8:0:1::1');
    expect(normaliseIp('2001:db8:0:0:1:0:0:1')).toBe('2001:db8::1:0:0:1');
    expect(normaliseIp('2001:db8:1:1:1:1:0:1')).toBe('2001:db8:1:1:1:1:0:1');
    expect(normaliseIp('::')).toBe('::');
    expect(normaliseIp('::1')).toBe('::1');
    expect(normaliseIp('1::')).toBe('1::');
    for (const bad of ['1:2:3:4:5:6:7:8:9', '1::2::3', '12345::', '1.2.3.4::', 'fe80::1%1', 'x']) {
      expect(normaliseIp(bad), bad).toBeNull();
    }
  });

  it('parses CIDRs strictly', () => {
    const cidr = parseCidr('2001:db8::/32');
    expect(cidr && formatCidr(cidr)).toBe('2001:db8::/32');
    expect(parseCidr('0.0.0.0/0')?.prefix).toBe(96);
    expect(parseCidr('::/0')?.prefix).toBe(0);
    expect(parseCidr('10.0.0.0/8 ')).toBeNull();
  });

  it('resolves dot segments, clamps at root, and never double-decodes', () => {
    expect(normalisePath('/a/../../etc')).toEqual({ ok: true, path: '/etc' });
    expect(normalisePath('/a/%2e%2e/b')).toEqual({ ok: true, path: '/b' });
    expect(normalisePath('/%252e%252e/b')).toEqual({ ok: true, path: '/%252e%252e/b' });
    expect(normalisePath('/a/../b', { allowDotDot: false }).ok).toBe(false);
    expect(normalisePath('relative').ok).toBe(false);
    expect(normalisePath('/%0a').ok).toBe(false);
  });

  it('path normalisation is idempotent', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 40 }), (tail) => {
        const once = normalisePath(`/${tail}`);
        if (!once.ok) return;
        expect(normalisePath(once.path)).toEqual(once);
      }),
    );
  });

  it('host normalisation is idempotent', () => {
    fc.assert(
      fc.property(fc.domain(), (domain) => {
        const once = normaliseHost(domain);
        if (once === null) return;
        expect(normaliseHost(once)).toBe(once);
      }),
    );
  });

  it('ip normalisation is idempotent', () => {
    fc.assert(
      fc.property(fc.oneof(fc.ipV4(), fc.ipV6()), (ip) => {
        const once = normaliseIp(ip);
        if (once === null) return;
        expect(normaliseIp(once)).toBe(once);
      }),
    );
  });
});
