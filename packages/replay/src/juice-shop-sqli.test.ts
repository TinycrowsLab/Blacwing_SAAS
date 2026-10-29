import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { plannerPersona, WEB_API_ORACLE_TYPES } from '@blackwing/agents';
import { WEBAPI_CATALOGUE } from '@blackwing/domain';
import { ValidationError } from '@blackwing/errors';

import {
  buildJuiceShopSqliPlan,
  JUICE_SHOP_LAB_IMAGE,
  JUICE_SHOP_LAB_ORIGIN,
  JUICE_SHOP_SQLI_CONTROL,
  JUICE_SHOP_SQLI_ORACLE,
  JUICE_SHOP_SQLI_ORACLE_ID,
  JUICE_SHOP_SQLI_PROBE,
  JUICE_SHOP_SQLI_TEST_CASE_ID,
  juiceShopScopeRules,
} from './juice-shop-sqli.js';

const ASSET = '0190a000-0000-7000-8000-000000000001';

describe('Juice Shop SQLi scenario: planner, specialist and validator agree', () => {
  it('binds the catalogue class webapi.injection.sql (WSTG-INPV-05, CWE-89, A03, active_safe)', () => {
    const entry = WEBAPI_CATALOGUE.entries.find(
      (candidate) => candidate.id === JUICE_SHOP_SQLI_TEST_CASE_ID,
    );
    expect(entry).toBeDefined();
    expect(entry?.wstg).toEqual(['WSTG-INPV-05']);
    expect(entry?.cwe).toEqual(['CWE-89']);
    expect(entry?.owasp).toEqual(['A03']);
    expect(entry?.intrusiveness).toBe('active_safe');
  });

  it('applies the catalogue class to the Juice Shop search parameter', () => {
    const entry = WEBAPI_CATALOGUE.entries.find(
      (candidate) => candidate.id === JUICE_SHOP_SQLI_TEST_CASE_ID,
    );
    const node = {
      type: 'parameter' as const,
      assetId: ASSET,
      method: 'GET',
      url: 'http://127.0.0.1:13000/rest/products/search',
      location: 'query' as const,
      name: 'q',
    };
    expect(entry?.appliesTo(node)).toBe(true);
  });

  it('declares the same oracle type the catalogue class uses, and the specialist and planner accept it', () => {
    expect(JUICE_SHOP_SQLI_ORACLE.type).toBe('error_signature');
    const entry = WEBAPI_CATALOGUE.entries.find(
      (candidate) => candidate.id === JUICE_SHOP_SQLI_TEST_CASE_ID,
    );
    expect(entry?.oracleType).toBe(JUICE_SHOP_SQLI_ORACLE.type);
    expect(entry?.negativeControlTemplate.oracleType).toBe(JUICE_SHOP_SQLI_ORACLE.type);
    expect(WEB_API_ORACLE_TYPES).toContain('error_signature');
    expect(plannerPersona.declaredOracleTypes).toContain('error_signature');
  });

  it('pins the lab image to the digest in the compose file (drift check)', () => {
    const compose = readFileSync(
      new URL('../../../infra/compose/docker-compose.dev.yml', import.meta.url),
      'utf8',
    );
    expect(compose).toContain(JUICE_SHOP_LAB_IMAGE);
  });
});

describe('Juice Shop SQLi scenario: the probe and the control', () => {
  it('uses a benign single-quote probe and an ordinary control term, both on the same parameter', () => {
    const plan = buildJuiceShopSqliPlan(JUICE_SHOP_LAB_ORIGIN);
    expect(new URL(plan.probeUrl).searchParams.get('q')).toBe(JUICE_SHOP_SQLI_PROBE);
    expect(new URL(plan.negativeControlUrl).searchParams.get('q')).toBe(JUICE_SHOP_SQLI_CONTROL);
    expect(new URL(plan.probeUrl).pathname).toBe('/rest/products/search');
    expect(new URL(plan.negativeControlUrl).pathname).toBe('/rest/products/search');
  });

  it('keeps the probe benign: one quote on an ordinary token, with no data-extraction syntax', () => {
    expect(JUICE_SHOP_SQLI_PROBE.match(/'/g)).toHaveLength(1);
    expect(JUICE_SHOP_SQLI_PROBE.toLowerCase()).not.toMatch(/union|select|sleep|--|;/);
  });

  it('replays twice and builds the plan under the scenario oracle id', () => {
    const plan = buildJuiceShopSqliPlan(JUICE_SHOP_LAB_ORIGIN);
    expect(plan.runs).toBe(2);
    expect(plan.oracle.id).toBe(JUICE_SHOP_SQLI_ORACLE_ID);
    expect(plan.testCaseId).toBe(JUICE_SHOP_SQLI_TEST_CASE_ID);
    expect(plan.labImage).toBe(JUICE_SHOP_LAB_IMAGE);
  });

  it('scopes the lab origin and excludes the application version endpoint', () => {
    const scope = juiceShopScopeRules(new URL(JUICE_SHOP_LAB_ORIGIN));
    expect(scope.rules).toEqual([
      expect.objectContaining({ effect: 'include', cidr: '127.0.0.1/32', ports: [13000] }),
      expect.objectContaining({
        effect: 'exclude',
        cidr: '127.0.0.1/32',
        paths: ['/rest/admin/application-version'],
      }),
    ]);
  });

  it('rejects a malformed lab origin as a validation error', () => {
    expect(() => buildJuiceShopSqliPlan('not a url')).toThrow(ValidationError);
  });
});
