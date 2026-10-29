import { describe, expect, it } from 'vitest';

import {
  assertPersonaEligible,
  DispatchRejection,
  mandateCovers,
  standardIds,
} from './eligibility.js';

import type { DispatchTestCase, PersonaProfile } from './ports.js';

const WEB_API =
  'Detect injection (CWE-89, CWE-79, WSTG-INPV-05/01/02), SSRF (CWE-918, WSTG-INPV-19, API7), GraphQL (WSTG-APIT), CORS and headers (WSTG-CLNT-07, WSTG-CONF).';
const INFRA =
  'Probe in-scope network services, TLS and configuration (OWASP A05 and A02, WSTG-CONF and WSTG-CRYP), exposed admin interfaces (WSTG-CONF-05) and known-vulnerable versions (A06, CWE-1104).';

const persona = (name: string, mandate: string, ceiling: PersonaProfile['intrusivenessCeiling']) =>
  ({
    name,
    version: '1.0.0',
    mandate,
    intrusivenessCeiling: ceiling,
    model: 'm',
    effort: 'high',
    maxTurns: 10,
    maxBudgetUsd: 1,
  }) satisfies PersonaProfile;

const graphqlInjection: DispatchTestCase = {
  id: 'tc',
  class: 'active_safe',
  status: 'approved',
  owasp: ['A03'],
  wstg: ['WSTG-APIT-01'],
  cwe: ['CWE-89'],
};

function codeOf(fn: () => void): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof DispatchRejection) return err.code;
    throw err;
  }
  return 'ok';
}

describe('standardIds', () => {
  it('expands slash lists and keeps bare categories', () => {
    expect([...standardIds(WEB_API)]).toEqual(
      expect.arrayContaining(['WSTG-INPV-05', 'WSTG-INPV-01', 'WSTG-INPV-02', 'WSTG-APIT', 'API7']),
    );
  });
});

describe('mandateCovers', () => {
  it('matches by exact id or WSTG category', () => {
    expect(mandateCovers(WEB_API, graphqlInjection)).toBe(true);
    expect(
      mandateCovers(INFRA, { ...graphqlInjection, wstg: ['WSTG-CONF-05'], cwe: [], owasp: [] }),
    ).toBe(true);
  });

  it('does not match a sibling id of an exact mention, or a longer CWE number', () => {
    const tc = { ...graphqlInjection, wstg: ['WSTG-INPV-06'], cwe: ['CWE-8'], owasp: [] };
    expect(mandateCovers(WEB_API, tc)).toBe(false);
  });
});

describe('assertPersonaEligible matrix', () => {
  it.each([
    ['web-api-specialist', WEB_API, 'active_safe', graphqlInjection, 'ok'],
    ['infrastructure-specialist', INFRA, 'active_safe', graphqlInjection, 'PERSONA_INELIGIBLE'],
    ['web-api-specialist', WEB_API, 'passive', graphqlInjection, 'PERSONA_INELIGIBLE'],
    [
      'web-api-specialist',
      WEB_API,
      'active_safe',
      { ...graphqlInjection, status: 'proposed' },
      'TEST_CASE_NOT_APPROVED',
    ],
    [
      'web-api-specialist',
      WEB_API,
      'active_safe',
      { ...graphqlInjection, status: 'removed' },
      'TEST_CASE_NOT_APPROVED',
    ],
  ] as const)('%s ceiling %s on %j', (name, mandate, ceiling, testCase, expected) => {
    expect(
      codeOf(() => {
        assertPersonaEligible(persona(name, mandate, ceiling), testCase, 'active_safe');
      }),
    ).toBe(expected);
  });

  it('refuses a brief whose class differs from the approved test case', () => {
    expect(
      codeOf(() => {
        assertPersonaEligible(
          persona('w', WEB_API, 'state_changing'),
          graphqlInjection,
          'state_changing',
        );
      }),
    ).toBe('INVALID_REQUEST');
  });

  it('refuses state_changing for a persona with an active_safe ceiling', () => {
    const tc = { ...graphqlInjection, class: 'state_changing' } as const;
    expect(
      codeOf(() => {
        assertPersonaEligible(persona('w', WEB_API, 'active_safe'), tc, 'state_changing');
      }),
    ).toBe('PERSONA_INELIGIBLE');
    expect(
      codeOf(() => {
        assertPersonaEligible(persona('w', WEB_API, 'state_changing'), tc, 'state_changing');
      }),
    ).toBe('ok');
  });
});
