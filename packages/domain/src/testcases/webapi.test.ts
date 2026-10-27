import { describe, expect, it } from 'vitest';

import { type Catalogue, CatalogueError, defineCatalogue, selectApplicable } from './catalogue.js';
import { isKnownApiTop10, isKnownCwe, isKnownOwaspTop10, isKnownWstg } from './standards.js';
import {
  WEBAPI_CATALOGUE,
  WEBAPI_CATALOGUE_METRIC,
  webApiCatalogueMetricSamples,
} from './webapi.js';

import type { SurfaceNode } from '../surface/write.js';

const ASSET = '0190a000-0000-7000-8000-000000000001';
const param = (name: string, location: 'query' | 'body' = 'query'): SurfaceNode => ({
  type: 'parameter',
  assetId: ASSET,
  method: 'GET',
  url: 'https://a.example/rest/products/search',
  location,
  name,
});
const endpoint = (url: string, method = 'GET'): SurfaceNode => ({
  type: 'endpoint',
  assetId: ASSET,
  method,
  url,
});
const ids = (cat: Catalogue, node: SurfaceNode): string[] =>
  selectApplicable(cat, node).map((entry) => entry.id);

/** A valid entry the negative tests mutate one field at a time. */
const valid = (): Record<string, unknown> => ({
  id: 'webapi.test.entry',
  title: 'Test entry',
  wstg: ['WSTG-INPV-05'],
  cwe: ['CWE-89'],
  owasp: ['A03'],
  oracleType: 'marker',
  negativeControlTemplate: {
    strategy: 'benign_value',
    oracleType: 'marker',
    description: 'control',
  },
  intrusiveness: 'passive',
  budgetHint: { maxRequests: 10, maxRps: 1 },
  appliesTo: () => true,
});
const build = (patch: Record<string, unknown>): Catalogue =>
  defineCatalogue('1.0.0', [{ ...valid(), ...patch }]);

describe('WEBAPI_CATALOGUE', () => {
  it('covers every required class family', () => {
    const cwes = new Set(WEBAPI_CATALOGUE.entries.flatMap((entry) => entry.cwe));
    for (const cwe of [
      'CWE-89',
      'CWE-78',
      'CWE-90',
      'CWE-943',
      'CWE-79',
      'CWE-918',
      'CWE-209',
      'CWE-200',
      'CWE-693',
      'CWE-942',
      'CWE-1004',
      'CWE-611',
      'CWE-1336',
      'CWE-22',
      'CWE-601',
      'CWE-915',
      'CWE-434',
    ]) {
      expect(cwes, cwe).toContain(cwe);
    }
    const apis = new Set(WEBAPI_CATALOGUE.entries.flatMap((entry) => entry.apiTop10 ?? []));
    expect([...apis].sort()).toEqual(['API3', 'API7', 'API8', 'API9']);
  });

  it('resolves every WSTG, CWE and OWASP id against the standards tables', () => {
    for (const entry of WEBAPI_CATALOGUE.entries) {
      entry.wstg.forEach((id) => {
        expect(isKnownWstg(id), id).toBe(true);
      });
      entry.cwe.forEach((id) => {
        expect(isKnownCwe(id), id).toBe(true);
      });
      entry.owasp.forEach((id) => {
        expect(isKnownOwaspTop10(id), id).toBe(true);
      });
      (entry.apiTop10 ?? []).forEach((id) => {
        expect(isKnownApiTop10(id), id).toBe(true);
      });
    }
  });

  it('declares an oracle, a negative control and a non-destructive class on every entry', () => {
    expect(WEBAPI_CATALOGUE.entries.length).toBeGreaterThanOrEqual(15);
    for (const entry of WEBAPI_CATALOGUE.entries) {
      expect(entry.oracleType).toBeTruthy();
      expect(entry.negativeControlTemplate.description.length).toBeGreaterThan(0);
      expect(['passive', 'active_safe', 'state_changing']).toContain(entry.intrusiveness);
      expect(entry.intrusiveness).not.toBe('destructive');
    }
  });

  it('flags the state-changing classes', () => {
    const changing = WEBAPI_CATALOGUE.entries.filter((e) => e.intrusiveness === 'state_changing');
    expect(changing.map((e) => e.id).sort()).toEqual([
      'webapi.file_upload',
      'webapi.mass_assignment',
    ]);
  });

  it('binds blind classes to the out-of-band oracle and file read to its sentinel oracle', () => {
    const byId = new Map(WEBAPI_CATALOGUE.entries.map((e) => [e.id, e]));
    expect(byId.get('webapi.ssrf')?.oracleType).toBe('out_of_band');
    expect(byId.get('webapi.xxe')?.oracleType).toBe('out_of_band');
    expect(byId.get('webapi.path_traversal')?.oracleType).toBe('file_read_marker');
  });

  it('pins a stable version and digest', () => {
    expect(WEBAPI_CATALOGUE.version).toBe('1.0.0');
    expect(WEBAPI_CATALOGUE.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(build({}).digest).toBe(build({}).digest);
    expect(build({}).digest).not.toBe(build({ title: 'Other title' }).digest);
    expect(defineCatalogue('1.0.1', [valid()]).digest).not.toBe(build({}).digest);
  });

  it('is immutable', () => {
    expect(Object.isFrozen(WEBAPI_CATALOGUE.entries)).toBe(true);
    expect(Object.isFrozen(WEBAPI_CATALOGUE.entries[0])).toBe(true);
  });

  it('reports entry counts per class for the load metric', () => {
    expect(WEBAPI_CATALOGUE_METRIC).toBe('webapi_catalogue_entries_total');
    const samples = webApiCatalogueMetricSamples();
    expect(samples.map((s) => s.labels.class)).toEqual([
      'passive',
      'active_safe',
      'state_changing',
    ]);
    expect(samples.reduce((sum, s) => sum + s.value, 0)).toBe(WEBAPI_CATALOGUE.entries.length);
  });

  it('keeps payload strings out: entries carry only the declared fields', () => {
    for (const entry of WEBAPI_CATALOGUE.entries) {
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
          ...(entry.apiTop10 ? ['apiTop10'] : []),
        ].sort(),
      );
    }
  });
});

describe('appliesTo', () => {
  it('selects injection, XSS and template classes for any parameter', () => {
    const selected = ids(WEBAPI_CATALOGUE, param('q'));
    expect(selected).toEqual(
      expect.arrayContaining([
        'webapi.injection.sql',
        'webapi.injection.os_command',
        'webapi.injection.ldap',
        'webapi.injection.nosql',
        'webapi.xss.client_side',
        'webapi.ssti',
      ]),
    );
    expect(selected).not.toContain('webapi.ssrf');
    expect(selected).not.toContain('webapi.path_traversal');
    expect(selected).not.toContain('webapi.open_redirect');
  });

  it('selects SSRF for URL-like parameter names in any casing', () => {
    for (const name of ['url', 'callbackUrl', 'webhook_uri', 'Target-Host']) {
      expect(ids(WEBAPI_CATALOGUE, param(name)), name).toContain('webapi.ssrf');
    }
  });

  it('selects open redirect and path traversal by parameter name', () => {
    expect(ids(WEBAPI_CATALOGUE, param('returnUrl'))).toContain('webapi.open_redirect');
    expect(ids(WEBAPI_CATALOGUE, param('next'))).toContain('webapi.open_redirect');
    expect(ids(WEBAPI_CATALOGUE, param('fileName'))).toContain('webapi.path_traversal');
    expect(ids(WEBAPI_CATALOGUE, param('urlencoded'))).not.toContain('webapi.ssrf');
  });

  it('selects GraphQL only for a GraphQL endpoint', () => {
    expect(ids(WEBAPI_CATALOGUE, endpoint('https://a.example/graphql', 'POST'))).toContain(
      'webapi.graphql.exposure',
    );
    expect(ids(WEBAPI_CATALOGUE, endpoint('https://a.example/api/v1/GraphQL'))).toContain(
      'webapi.graphql.exposure',
    );
    expect(ids(WEBAPI_CATALOGUE, endpoint('https://a.example/rest/products'))).not.toContain(
      'webapi.graphql.exposure',
    );
  });

  it('selects header, cookie, CORS and error classes for endpoints', () => {
    expect(ids(WEBAPI_CATALOGUE, endpoint('https://a.example/'))).toEqual(
      expect.arrayContaining([
        'webapi.config.security_headers',
        'webapi.config.cookie_flags',
        'webapi.config.cors',
        'webapi.info.verbose_error',
        'webapi.info.sensitive_data',
      ]),
    );
  });

  it('selects XXE and mass assignment only for body-bearing methods', () => {
    expect(ids(WEBAPI_CATALOGUE, endpoint('https://a.example/api/users', 'post'))).toEqual(
      expect.arrayContaining(['webapi.xxe', 'webapi.mass_assignment']),
    );
    const getIds = ids(WEBAPI_CATALOGUE, endpoint('https://a.example/api/users'));
    expect(getIds).not.toContain('webapi.xxe');
    expect(getIds).not.toContain('webapi.mass_assignment');
  });

  it('selects file upload only for upload-like body endpoints', () => {
    expect(
      ids(WEBAPI_CATALOGUE, endpoint('https://a.example/profile/avatar-upload', 'POST')),
    ).toContain('webapi.file_upload');
    expect(
      ids(WEBAPI_CATALOGUE, endpoint('https://a.example/profile/avatar-upload')),
    ).not.toContain('webapi.file_upload');
    expect(ids(WEBAPI_CATALOGUE, endpoint('https://a.example/api/users', 'POST'))).not.toContain(
      'webapi.file_upload',
    );
  });

  it('selects nothing for nodes with no applicable class', () => {
    const host: SurfaceNode = { type: 'host', assetId: ASSET, address: 'a.example' };
    const role: SurfaceNode = { type: 'role', assetId: ASSET, roleName: 'admin' };
    expect(ids(WEBAPI_CATALOGUE, host)).toEqual([]);
    expect(ids(WEBAPI_CATALOGUE, role)).toEqual([]);
  });

  it('copes with an unparseable endpoint url template', () => {
    expect(ids(WEBAPI_CATALOGUE, endpoint('/graphql'))).toContain('webapi.graphql.exposure');
  });
});

describe('defineCatalogue build-time checks', () => {
  it('accepts a valid entry', () => {
    expect(build({}).entries).toHaveLength(1);
  });

  it.each([
    ['unknown WSTG id', { wstg: ['WSTG-INPV-99'] }],
    ['malformed WSTG id', { wstg: ['wstg-inpv-05'] }],
    ['unknown CWE id', { cwe: ['CWE-99999'] }],
    ['malformed CWE id', { cwe: ['89'] }],
    ['no CWE id', { cwe: [] }],
    ['unknown OWASP category', { owasp: ['A11'] }],
    ['unknown API category', { owasp: [], apiTop10: ['API11'] }],
    ['no OWASP category at all', { owasp: [] }],
    ['repeated id', { cwe: ['CWE-89', 'CWE-89'] }],
    ['unknown oracle type', { oracleType: 'free_form' }],
    [
      'unknown control oracle type',
      { negativeControlTemplate: { strategy: 'benign_value', oracleType: 'x', description: 'd' } },
    ],
    [
      'unknown control strategy',
      { negativeControlTemplate: { strategy: 'payload', oracleType: 'marker', description: 'd' } },
    ],
    ['missing negative control', { negativeControlTemplate: undefined }],
    [
      'empty control description',
      {
        negativeControlTemplate: {
          strategy: 'benign_value',
          oracleType: 'marker',
          description: '',
        },
      },
    ],
    ['destructive class', { intrusiveness: 'destructive' }],
    ['unknown class', { intrusiveness: 'Passive' }],
    ['budget over the class default', { budgetHint: { maxRequests: 100_000, maxRps: 1 } }],
    ['rate over the class default', { budgetHint: { maxRequests: 10, maxRps: 500 } }],
    ['rate over request count', { budgetHint: { maxRequests: 2, maxRps: 3 } }],
    ['non-positive budget', { budgetHint: { maxRequests: 0, maxRps: 1 } }],
    ['bad class id', { id: 'Not A Class' }],
    ['undotted class id', { id: 'sqli' }],
    ['missing predicate', { appliesTo: undefined }],
    ['non-function predicate', { appliesTo: 'yes' }],
    ['extra payload field', { payload: 'x' }],
  ])('rejects %s', (_label, patch) => {
    expect(() => build(patch)).toThrow(CatalogueError);
  });

  it('names the failing entry and field', () => {
    expect(() => build({ cwe: ['CWE-99999'] })).toThrow(
      /entry 0\.cwe: unknown or retired id CWE-99999/,
    );
  });

  it('rejects a duplicate class id', () => {
    expect(() => defineCatalogue('1.0.0', [valid(), valid()])).toThrow(
      /duplicate class id webapi\.test\.entry/,
    );
  });

  it('rejects a non-semver version', () => {
    expect(() => defineCatalogue('1.0', [valid()])).toThrow(CatalogueError);
  });

  it('fails closed on a non-object entry', () => {
    expect(() => defineCatalogue('1.0.0', ['x'])).toThrow(CatalogueError);
  });
});

describe('standards tables', () => {
  it('resolve known ids and reject unknown, retired and prototype keys', () => {
    expect(isKnownCwe('CWE-79')).toBe(true);
    expect(isKnownCwe('CWE-80000')).toBe(false);
    expect(isKnownCwe('constructor')).toBe(false);
    expect(isKnownOwaspTop10('A10')).toBe(true);
    expect(isKnownOwaspTop10('A00')).toBe(false);
    expect(isKnownApiTop10('API10')).toBe(true);
    expect(isKnownApiTop10('API0')).toBe(false);
    expect(isKnownWstg('WSTG-INPV-19')).toBe(true);
    expect(isKnownWstg('__proto__')).toBe(false);
  });
});
