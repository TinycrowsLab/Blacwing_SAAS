import { describe, expect, it } from 'vitest';

import { ValidationError } from '@blackwing/errors';

import { classifyFinding } from './classify.js';
import { DEFAULT_MAPPING_DATASET, loadMappingDataset } from './mappings.js';

const ONE_ENTRY = {
  version: '2.0.0',
  mappings: {
    'webapi.injection.sql': {
      cweCandidates: ['CWE-89'],
      owaspTop10: 'A03',
      wstg: ['WSTG-INPV-05'],
    },
  },
};

describe('classifyFinding precedence', () => {
  it('prefers the specialist-declared CWE over the curated default and keeps the default as a candidate', () => {
    const result = classifyFinding('webapi.injection.sql', { cwe: ['CWE-79'] });
    expect(result.cweId).toBe('CWE-79');
    expect(result.detail.cweCandidates).toEqual(['CWE-79', 'CWE-89']);
  });

  it('prefers the specialist-declared OWASP category and WSTG refs, merged after the defaults', () => {
    const result = classifyFinding('webapi.injection.sql', {
      owasp: 'A01',
      wstg: ['WSTG-ATHZ-01', 'WSTG-INPV-05'],
    });
    expect(result.owaspCategory).toBe('A01');
    expect(result.detail.wstg).toEqual(['WSTG-ATHZ-01', 'WSTG-INPV-05']);
  });

  it('uses the curated default when the specialist declares nothing', () => {
    const result = classifyFinding('webapi.injection.sql');
    expect(result).toMatchObject({ cweId: 'CWE-89', owaspCategory: 'A03', unmapped: false });
  });

  it('takes a finding with no mapping entry from the candidate refs, and is mapped when both are given', () => {
    const cweOnly = classifyFinding('raw.unknown_class', { cwe: ['CWE-22'] });
    expect(cweOnly).toMatchObject({ cweId: 'CWE-22', owaspCategory: null, unmapped: true });
    const full = classifyFinding('raw.unknown_class', { cwe: ['CWE-22'], owasp: 'A01' });
    expect(full).toMatchObject({ cweId: 'CWE-22', owaspCategory: 'A01', unmapped: false });
  });
});

describe('classifyFinding unmapped handling', () => {
  it('flags a finding with no CWE and no OWASP category as unmapped, never inventing an id', () => {
    const result = classifyFinding('raw.unknown_class');
    expect(result).toMatchObject({
      cweId: null,
      owaspCategory: null,
      unmapped: true,
      cweTop25: false,
    });
    expect(result.detail).toEqual({ cweCandidates: [], apiTop10: null, wstg: [] });
  });

  it('flags a finding whose OWASP category is missing even when the CWE is known', () => {
    const result = classifyFinding('raw.unknown_class', { cwe: ['CWE-89'] });
    expect(result).toMatchObject({ cweId: 'CWE-89', owaspCategory: null, unmapped: true });
  });

  it('takes the API Top 10 id from the dataset and keeps the OWASP category it declares', () => {
    const dataset = loadMappingDataset({
      version: '2.0.0',
      mappings: {
        'webapi.bola.object': {
          cweCandidates: ['CWE-915'],
          owaspTop10: 'A01',
          apiTop10: 'API1',
          wstg: [],
        },
      },
    });
    const result = classifyFinding('webapi.bola.object', {}, dataset);
    expect(result).toMatchObject({ owaspCategory: 'A01', unmapped: false });
    expect(result.detail.apiTop10).toBe('API1');
  });

  it('falls back to A01 with an API id for mass assignment, per the shipped dataset', () => {
    const result = classifyFinding('webapi.mass_assignment');
    expect(result).toMatchObject({ cweId: 'CWE-915', owaspCategory: 'A01', unmapped: false });
    expect(result.detail.apiTop10).toBe('API3');
  });
});

describe('classifyFinding refusals and metadata', () => {
  it.each([
    ['a CWE of zero', { cwe: ['CWE-0'] }],
    ['an OWASP category that does not exist', { owasp: 'A11' }],
    ['an API id in the OWASP slot', { owasp: 'API1' }],
    ['a WSTG id that does not exist', { wstg: ['WSTG-XXXX-99'] }],
    ['an unknown key', { cweId: 'CWE-89' }],
  ])('rejects %s with ValidationError and never maps it', (_label, refs) => {
    expect(() => classifyFinding('webapi.injection.sql', refs)).toThrow(ValidationError);
  });

  it('records the mapping version that produced the classification', () => {
    expect(classifyFinding('webapi.injection.sql').mappingVersion).toBe(
      DEFAULT_MAPPING_DATASET.version,
    );
    expect(
      classifyFinding('webapi.injection.sql', {}, loadMappingDataset(ONE_ENTRY)).mappingVersion,
    ).toBe('2.0.0');
  });

  it('flags a primary CWE that is on the CWE Top 25 list', () => {
    expect(classifyFinding('webapi.injection.sql').cweTop25).toBe(true);
    expect(classifyFinding('webapi.config.security_headers').cweTop25).toBe(false);
  });

  it('does not treat an inherited property name as a mapping entry', () => {
    const result = classifyFinding('constructor');
    expect(result.unmapped).toBe(true);
    expect(result.cweId).toBeNull();
  });
});

describe('loadMappingDataset', () => {
  const entry = (overrides: Record<string, unknown> = {}) => ({
    cweCandidates: ['CWE-89'],
    owaspTop10: 'A03',
    wstg: [],
    ...overrides,
  });
  const dataset = (mappings: Record<string, unknown>, version = '1.0.0') => ({ version, mappings });

  it('normalises and freezes a valid dataset', () => {
    const loaded = loadMappingDataset(
      dataset({ 'webapi.injection.sql': entry({ cweCandidates: ['cwe-089'], owaspTop10: 'a03' }) }),
    );
    expect(loaded.mappings['webapi.injection.sql']).toMatchObject({
      cweCandidates: ['CWE-89'],
      owaspTop10: 'A03',
    });
    expect(Object.isFrozen(loaded)).toBe(true);
  });

  it.each([
    ['a CWE of zero', dataset({ 'webapi.x.y': entry({ cweCandidates: ['CWE-0'] }) })],
    ['an unknown OWASP category', dataset({ 'webapi.x.y': entry({ owaspTop10: 'A11' }) })],
    ['a non-semver version', dataset({ 'webapi.x.y': entry() }, 'v1')],
    ['a class key that is not dotted', dataset({ SQL: entry() })],
    ['an empty candidate list', dataset({ 'webapi.x.y': entry({ cweCandidates: [] }) })],
    ['a payload field (strict schema)', dataset({ 'webapi.x.y': entry({ payload: "' OR 1=1" }) })],
  ])('refuses %s at load time', (_label, raw) => {
    expect(() => loadMappingDataset(raw)).toThrow(ValidationError);
  });
});
