import { describe, expect, it } from 'vitest';

import { type Catalogue, CatalogueError, defineCatalogue, selectApplicable } from './catalogue.js';
import {
  assertInfraIntrusiveness,
  INFRA_CATALOGUE,
  INFRA_CATALOGUE_METRIC,
  infraCatalogueMetricSamples,
} from './infra.js';
import { isKnownCwe, isKnownOwaspTop10, isKnownWstg } from './standards.js';

import type { SurfaceNode } from '../surface/write.js';

const ASSET = '0190a000-0000-7000-8000-000000000001';
const service = (port: number, name?: string, proto: 'tcp' | 'udp' = 'tcp'): SurfaceNode => ({
  type: 'service',
  assetId: ASSET,
  address: '203.0.113.10',
  port,
  proto,
  ...(name === undefined ? {} : { name }),
});
const endpoint = (url: string, method = 'GET'): SurfaceNode => ({
  type: 'endpoint',
  assetId: ASSET,
  method,
  url,
});
const technology = (product: string, version?: string): SurfaceNode => ({
  type: 'technology',
  assetId: ASSET,
  address: '203.0.113.10',
  product,
  ...(version === undefined ? {} : { version }),
});
const host = (): SurfaceNode => ({ type: 'host', assetId: ASSET, address: '203.0.113.10' });
const role = (): SurfaceNode => ({ type: 'role', assetId: ASSET, roleName: 'admin' });

const ids = (node: SurfaceNode): string[] =>
  selectApplicable(INFRA_CATALOGUE, node).map((entry) => entry.id);

/** A valid entry the negative tests mutate one field at a time. */
const valid = (): Record<string, unknown> => ({
  id: 'infra.test.entry',
  title: 'Test entry',
  wstg: ['WSTG-CONF-05'],
  cwe: ['CWE-668'],
  owasp: ['A05'],
  oracleType: 'status_diff',
  negativeControlTemplate: {
    strategy: 'benign_value',
    oracleType: 'status_diff',
    description: 'control',
  },
  intrusiveness: 'passive',
  budgetHint: { maxRequests: 10, maxRps: 1 },
  appliesTo: () => true,
});
const build = (patch: Record<string, unknown>): Catalogue =>
  defineCatalogue('1.0.0', [{ ...valid(), ...patch }]);

describe('INFRA_CATALOGUE', () => {
  it('covers every required infrastructure class family', () => {
    const cwes = new Set(INFRA_CATALOGUE.entries.flatMap((entry) => entry.cwe));
    for (const cwe of [
      'CWE-326',
      'CWE-327',
      'CWE-295',
      'CWE-668',
      'CWE-1188',
      'CWE-538',
      'CWE-16',
      'CWE-1035',
      'CWE-1104',
      'CWE-1392',
      'CWE-521',
    ]) {
      expect(cwes, cwe).toContain(cwe);
    }
    const owasp = new Set(INFRA_CATALOGUE.entries.flatMap((entry) => entry.owasp));
    expect([...owasp].sort()).toEqual(['A02', 'A05', 'A06', 'A07']);
  });

  it('resolves every WSTG, CWE and OWASP id against the standards tables', () => {
    for (const entry of INFRA_CATALOGUE.entries) {
      entry.wstg.forEach((id) => {
        expect(isKnownWstg(id), id).toBe(true);
      });
      entry.cwe.forEach((id) => {
        expect(isKnownCwe(id), id).toBe(true);
      });
      entry.owasp.forEach((id) => {
        expect(isKnownOwaspTop10(id), id).toBe(true);
      });
    }
  });

  it('declares an oracle, a negative control and a non-destructive class on every entry', () => {
    expect(INFRA_CATALOGUE.entries.length).toBeGreaterThanOrEqual(5);
    for (const entry of INFRA_CATALOGUE.entries) {
      expect(entry.oracleType).toBeTruthy();
      expect(entry.negativeControlTemplate.description.length).toBeGreaterThan(0);
      expect(['passive', 'active_safe']).toContain(entry.intrusiveness);
    }
  });

  it('never catalogues a state-changing or destructive class', () => {
    const classes: string[] = INFRA_CATALOGUE.entries.map((e) => e.intrusiveness);
    expect(classes).not.toContain('state_changing');
    expect(classes).not.toContain('destructive');
  });

  it('flags only the default-credential class as confirmed by reference', () => {
    const flagged = INFRA_CATALOGUE.entries.filter((e) => e.requiresReferenceCredentials === true);
    expect(flagged.map((e) => e.id)).toEqual(['infra.auth.default_credentials']);
  });

  it('keeps credential values and payloads out of the catalogue', () => {
    for (const entry of INFRA_CATALOGUE.entries) {
      expect(Object.keys(entry).sort()).toEqual(
        [
          'id',
          'title',
          'wstg',
          'cwe',
          'owasp',
          'oracleType',
          'negativeControlTemplate',
          'intrusiveness',
          'budgetHint',
          'appliesTo',
          ...(entry.requiresReferenceCredentials === undefined
            ? []
            : ['requiresReferenceCredentials']),
        ].sort(),
      );
    }
    const serialised = JSON.stringify(INFRA_CATALOGUE.entries);
    expect(serialised).not.toMatch(/password|passwd|secret|hunter2|admin:admin/i);
  });

  it('pins a stable version and digest', () => {
    expect(INFRA_CATALOGUE.version).toBe('1.0.0');
    expect(INFRA_CATALOGUE.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.isFrozen(INFRA_CATALOGUE.entries)).toBe(true);
    expect(Object.isFrozen(INFRA_CATALOGUE.entries[0])).toBe(true);
  });
});

describe('appliesTo selection', () => {
  it('selects the TLS posture class for a TLS service and an https endpoint only', () => {
    expect(ids(service(443))).toContain('infra.tls.posture');
    expect(ids(service(8443))).toContain('infra.tls.posture');
    expect(ids(service(22, 'ssh'))).not.toContain('infra.tls.posture');
    expect(ids(service(443, 'https'))).toContain('infra.tls.posture');
    expect(ids(endpoint('https://a.example/login'))).toContain('infra.tls.posture');
    expect(ids(endpoint('http://a.example/login'))).not.toContain('infra.tls.posture');
  });

  it('selects the admin interface class for admin paths and admin products', () => {
    expect(ids(endpoint('https://a.example/admin/users'))).toContain(
      'infra.config.admin_interface',
    );
    expect(ids(endpoint('https://a.example/actuator/env'))).toContain(
      'infra.config.admin_interface',
    );
    expect(ids(technology('phpMyAdmin', '5.2.1'))).toContain('infra.config.admin_interface');
    expect(ids(endpoint('https://a.example/products/search'))).not.toContain(
      'infra.config.admin_interface',
    );
  });

  it('selects the exposure class for every endpoint', () => {
    expect(ids(endpoint('https://a.example/backup.zip'))).toContain('infra.config.exposure');
    expect(ids(endpoint('http://a.example/'))).toContain('infra.config.exposure');
  });

  it('selects the known-vulnerable-component class only for a technology with a version', () => {
    expect(ids(technology('nginx', '1.18.0'))).toContain(
      'infra.component.known_vulnerable_version',
    );
    expect(ids(technology('nginx'))).not.toContain('infra.component.known_vulnerable_version');
  });

  it('selects the default-credential class only for a credentialed service', () => {
    expect(ids(service(22, 'ssh'))).toContain('infra.auth.default_credentials');
    expect(ids(service(3306, 'mysql'))).toContain('infra.auth.default_credentials');
    expect(ids(service(443, 'https'))).not.toContain('infra.auth.default_credentials');
    expect(ids(service(22))).not.toContain('infra.auth.default_credentials');
  });

  it('selects nothing for a node type no class applies to', () => {
    expect(ids(host())).toEqual([]);
    expect(ids(role())).toEqual([]);
  });
});

describe('build-time checks', () => {
  it('rejects an unknown CWE id so the catalogue fails to build', () => {
    expect(() => build({ cwe: ['CWE-99999'] })).toThrow(
      /entry 0\.cwe: unknown or retired id CWE-99999/,
    );
  });

  it('rejects an unknown WSTG id and an unknown OWASP id', () => {
    expect(() => build({ wstg: ['WSTG-CONF-99'] })).toThrow(CatalogueError);
    expect(() => build({ owasp: ['A11'] })).toThrow(CatalogueError);
  });

  it('rejects a state-changing class in the infrastructure catalogue', () => {
    const changing = defineCatalogue('1.0.0', [
      { ...valid(), id: 'infra.test.changing', intrusiveness: 'state_changing' },
    ]);
    expect(() => assertInfraIntrusiveness(changing)).toThrow(
      /infra\.test\.changing: intrusiveness state_changing is not allowed/,
    );
  });

  it('accepts a passive or active-safe class in the infrastructure catalogue', () => {
    const safe = defineCatalogue('1.0.0', [valid()]);
    expect(assertInfraIntrusiveness(safe)).toBe(safe);
  });

  it('rejects a non-boolean reference-credentials flag', () => {
    expect(() => build({ requiresReferenceCredentials: 'yes' })).toThrow(CatalogueError);
  });
});

describe('infraCatalogueMetricSamples', () => {
  it('reports entry counts per class for the load metric', () => {
    expect(INFRA_CATALOGUE_METRIC).toBe('infra_catalogue_entries_total');
    const samples = infraCatalogueMetricSamples();
    expect(samples.map((s) => s.labels.class)).toEqual([
      'passive',
      'active_safe',
      'state_changing',
    ]);
    expect(samples.find((s) => s.labels.class === 'state_changing')?.value).toBe(0);
    expect(samples.reduce((sum, s) => sum + s.value, 0)).toBe(INFRA_CATALOGUE.entries.length);
  });
});
