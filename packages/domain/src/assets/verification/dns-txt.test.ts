import { describe, expect, it } from 'vitest';

import { capDnsTxtValues, DNS_TXT_DEFAULTS, matchesDnsTxt, normaliseTxtValue } from './dns-txt.js';

const TOKEN = 'blackwing-site-verification=ABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRS';

describe('DNS_TXT_DEFAULTS', () => {
  it('fixes the issue bounds: 5 s timeout, 2 retries, 50 records', () => {
    expect(DNS_TXT_DEFAULTS).toEqual({ timeoutMs: 5_000, retries: 2, maxRecords: 50 });
  });
});

describe('matchesDnsTxt', () => {
  it('passes on an exact token value', () => {
    expect(matchesDnsTxt(TOKEN, [TOKEN])).toBe(true);
  });

  it('scans every TXT value and passes when one of many matches', () => {
    expect(matchesDnsTxt(TOKEN, ['v=spf1 -all', 'google-site-verification=x', TOKEN])).toBe(true);
  });

  it('never matches an empty observation set, or a different token', () => {
    expect(matchesDnsTxt(TOKEN, [])).toBe(false);
    expect(
      matchesDnsTxt(TOKEN, [
        'blackwing-site-verification=ABCDEFGHIJKLMNOPQRSTUVWXYZ234567AAAAAAAAAAAAAAAAAAAA',
      ]),
    ).toBe(false);
  });

  it('does not match a token that is only a prefix or a substring of the record', () => {
    expect(matchesDnsTxt(TOKEN, [`${TOKEN}-extra`])).toBe(false);
    expect(matchesDnsTxt(TOKEN, [`prefix ${TOKEN}`])).toBe(false);
    expect(matchesDnsTxt(TOKEN, [TOKEN.slice(0, -1)])).toBe(false);
  });

  it('handles case and whitespace variations (named test)', () => {
    expect(matchesDnsTxt(TOKEN, [`  ${TOKEN}  `])).toBe(true);
    expect(matchesDnsTxt(TOKEN, [TOKEN.toUpperCase()])).toBe(true);
    expect(matchesDnsTxt(TOKEN, [`\t${TOKEN}\n`])).toBe(true);
  });
});

describe('normaliseTxtValue', () => {
  it('trims and lower-cases a value', () => {
    expect(normaliseTxtValue('  Blackwing-Site-Verification=AB  ')).toBe(
      'blackwing-site-verification=ab',
    );
  });
});

describe('capDnsTxtValues', () => {
  it('keeps every value under the cap and is not truncated', () => {
    expect(capDnsTxtValues(['a', 'b'], 50)).toEqual({ values: ['a', 'b'], truncated: false });
  });

  it('cuts a very large set at the cap, in resolver order, and says so', () => {
    const many = Array.from({ length: 51 }, (_, index) => `v${index}`);
    const capped = capDnsTxtValues(many, 50);
    expect(capped.values).toHaveLength(50);
    expect(capped.values[0]).toBe('v0');
    expect(capped.truncated).toBe(true);
  });

  it('treats a set exactly at the cap as complete', () => {
    const exact = Array.from({ length: 50 }, (_, index) => `v${index}`);
    expect(capDnsTxtValues(exact, 50).truncated).toBe(false);
  });
});
