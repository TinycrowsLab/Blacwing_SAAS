import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { tenantSlugSchema } from '@blackwing/contracts';

import { slugBase, slugCandidate } from './slug.js';
import { hashSignupToken, logRef, newSignupToken } from './token.js';

describe('slugBase', () => {
  it.each([
    ['Acme Security', 'acme-security'],
    ['  Acme   &  Sons, Ltd.  ', 'acme-sons-ltd'],
    ['ACME_corp', 'acme-corp'],
    ['Café Crème', 'cafe-creme'],
    ['Zoë Müller GmbH', 'zoe-muller-gmbh'],
    ['Straße Œuvre Øl', 'strasse-oeuvre-ol'],
    ['Łódź Þing', 'lodz-thing'],
    ['日本 Acme 株式会社', 'acme'],
    ['Ａｃｍｅ１２３', 'acme123'],
    ['--Hello--World--', 'hello-world'],
  ])('%j becomes %j', (name, slug) => {
    expect(slugBase(name)).toBe(slug);
  });

  it('is already NFC/NFD independent', () => {
    expect(slugBase('Café Corp')).toBe(slugBase('Café Corp'));
  });

  it('cuts at 40 characters without leaving a trailing hyphen', () => {
    const slug = slugBase(`${'a'.repeat(39)} bcd`);
    expect(slug).toBe('a'.repeat(39));
    expect(slugBase('x'.repeat(100))).toHaveLength(40);
  });

  it.each(['日本語の会社', '!!!', '--', 'ab', 'A.', '   ', '🙂🙂🙂'])(
    'refuses %j: it yields fewer than 3 letters or digits',
    (name) => {
      expect(() => slugBase(name)).toThrow(/no usable slug/);
    },
  );

  it('only ever yields a slug the tenants table accepts (property)', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', minLength: 2, maxLength: 100 }), (name) => {
        let slug: string;
        try {
          slug = slugBase(name);
        } catch {
          return; // refused is a valid answer
        }
        expect(slug.length).toBeGreaterThanOrEqual(3);
        expect(slug.length).toBeLessThanOrEqual(40);
        expect(tenantSlugSchema.safeParse(slug).success).toBe(true);
      }),
    );
  });
});

describe('slugCandidate', () => {
  it('is the base, then -2, -3, ...', () => {
    expect([1, 2, 3, 10].map((n) => slugCandidate('acme', n))).toEqual([
      'acme',
      'acme-2',
      'acme-3',
      'acme-10',
    ]);
  });

  it('shortens the base so a suffixed slug still fits in 40 characters', () => {
    const base = 'a'.repeat(40);
    for (const attempt of [2, 9, 10, 99, 100, 1000]) {
      const slug = slugCandidate(base, attempt);
      expect(slug.length).toBeLessThanOrEqual(40);
      expect(slug.endsWith(`-${String(attempt)}`)).toBe(true);
      expect(tenantSlugSchema.safeParse(slug).success).toBe(true);
    }
  });

  it('never leaves a double hyphen where the base was cut', () => {
    const base = `${'a'.repeat(36)}-bcd`;
    expect(slugCandidate(base, 12)).toBe(`${'a'.repeat(36)}-12`);
  });
});

describe('signup tokens', () => {
  it('are 256 random bits in base64url (43 characters) and never repeat', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      const token = newSignupToken();
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      seen.add(token);
    }
    expect(seen.size).toBe(200);
  });

  it('are stored as a 64-character lower-case SHA-256 that is not the token', () => {
    const token = newSignupToken();
    const hash = hashSignupToken(token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain(token);
    expect(hashSignupToken(token)).toBe(hash);
    expect(hashSignupToken(`${token}x`)).not.toBe(hash);
  });

  it('log references are short, stable, case-insensitive and hide the address', () => {
    expect(logRef('Owner@Example.com')).toBe(logRef('owner@example.com'));
    expect(logRef('owner@example.com')).toMatch(/^[0-9a-f]{12}$/);
    expect(logRef('owner@example.com')).not.toContain('owner');
  });
});
