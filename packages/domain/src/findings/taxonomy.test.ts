import { describe, expect, it } from 'vitest';

import { ValidationError } from '@blackwing/errors';

import {
  candidateRefsSchema,
  CWE_TOP25_2025,
  cweRefSchema,
  normaliseCweId,
  normaliseOwaspId,
  normaliseWstgId,
  owaspTop10RefSchema,
  parseTaxon,
} from './taxonomy.js';

describe('normaliseCweId', () => {
  it.each([
    ['CWE-79', 'CWE-79'],
    ['cwe-79', 'CWE-79'],
    ['  CWE-79  ', 'CWE-79'],
    ['CWE-079', 'CWE-79'],
    ['CWE-00089', 'CWE-89'],
    ['ＣＷＥ－８９', 'CWE-89'],
  ])('normalises %j to %s', (raw, expected) => {
    expect(normaliseCweId(raw)).toBe(expected);
  });

  it('leaves a malformed id unchanged so the pinned check refuses it', () => {
    expect(normaliseCweId('CWE-0')).toBe('CWE-0');
    expect(normaliseCweId('CWE-')).toBe('CWE-');
    expect(normaliseCweId('79')).toBe('79');
  });
});

describe('normaliseOwaspId and normaliseWstgId', () => {
  it.each([
    ['A03', 'A03'],
    ['a3', 'A03'],
    ['A01:2021', 'A01'],
    ['api7:2023', 'API7'],
    ['API10', 'API10'],
  ])('normalises OWASP %j to %s', (raw, expected) => {
    expect(normaliseOwaspId(raw)).toBe(expected);
  });

  it('normalises a WSTG id to upper case with no surrounding spaces', () => {
    expect(normaliseWstgId(' wstg-inpv-05 ')).toBe('WSTG-INPV-05');
  });
});

describe('pinned id refs', () => {
  it('accepts a pinned CWE and refuses one outside the pinned lists, including CWE-0', () => {
    expect(cweRefSchema.parse('cwe-089')).toBe('CWE-89');
    expect(cweRefSchema.safeParse('CWE-0').success).toBe(false);
    expect(cweRefSchema.safeParse('CWE-99999').success).toBe(false);
    expect(cweRefSchema.safeParse('CWE-1234567').success).toBe(false);
  });

  it('refuses an unknown OWASP category and an API id where the Top 10 id belongs', () => {
    expect(owaspTop10RefSchema.safeParse('A11').success).toBe(false);
    expect(owaspTop10RefSchema.safeParse('A00').success).toBe(false);
    expect(owaspTop10RefSchema.safeParse('API1').success).toBe(false);
    expect(owaspTop10RefSchema.parse('a10:2021')).toBe('A10');
  });

  it('lists the CWE Top 25 (2025) ids, all of them pinned', () => {
    expect(CWE_TOP25_2025.size).toBe(25);
    expect(CWE_TOP25_2025.has('CWE-89')).toBe(true);
    expect(cweRefSchema.safeParse('CWE-288').success).toBe(true);
  });
});

describe('candidateRefsSchema', () => {
  it('accepts an empty declaration and a normalised one', () => {
    expect(candidateRefsSchema.parse({})).toEqual({});
    expect(
      candidateRefsSchema.parse({
        cwe: ['cwe-79'],
        owasp: 'a03',
        apiTop10: 'API7',
        wstg: ['wstg-inpv-01'],
      }),
    ).toEqual({ cwe: ['CWE-79'], owasp: 'A03', apiTop10: 'API7', wstg: ['WSTG-INPV-01'] });
  });

  it('refuses an unknown key (strict), an unknown WSTG id and an over-long candidate list', () => {
    expect(candidateRefsSchema.safeParse({ cweId: 'CWE-89' }).success).toBe(false);
    expect(candidateRefsSchema.safeParse({ wstg: ['WSTG-XXXX-99'] }).success).toBe(false);
    expect(candidateRefsSchema.safeParse({ cwe: new Array(9).fill('CWE-79') }).success).toBe(false);
  });
});

describe('parseTaxon', () => {
  it('throws ValidationError naming the field and never echoing the rejected value', () => {
    let thrown: unknown;
    try {
      parseTaxon(candidateRefsSchema, { cwe: ['CWE-0'] }, 'classification refs');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ValidationError);
    const text = `${(thrown as ValidationError).message} ${(thrown as ValidationError).detail ?? ''}`;
    expect(text).toContain('cwe');
    expect(text).not.toContain('CWE-0');
  });
});
