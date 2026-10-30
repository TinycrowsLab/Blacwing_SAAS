import { describe, expect, it } from 'vitest';

import { safeAttr } from './attributes.js';

describe('safeAttr', () => {
  it('keeps an ordinary attribute as a single-entry object', () => {
    expect(safeAttr('plan.id', 'plan-42')).toEqual({ 'plan.id': 'plan-42' });
    expect(safeAttr('http.status_code', 200)).toEqual({ 'http.status_code': 200 });
    expect(safeAttr('tenant.region', ['eu', 'us'])).toEqual({ 'tenant.region': ['eu', 'us'] });
  });

  it.each([
    ['virtual model key', 'bwk_9f8e7d6c5b4a'],
    ['personal access token', 'bw_pat_AbC123xyz'],
    ['CI token', 'bw_ci_0123456789'],
    ['run token', 'bw_run_payload.signature'],
    ['bearer header', 'Bearer abcdefghijklmnop'],
  ])('drops a value carrying a %s', (_label, value) => {
    expect(safeAttr('request.detail', value)).toEqual({});
  });

  it('drops a secret-ref that is embedded in a longer string', () => {
    expect(safeAttr('proxy.url', 'http://bwk_abc123@egress.internal:3128')).toEqual({});
  });

  it('drops an array when any item carries a secret', () => {
    expect(safeAttr('headers.list', ['ok', 'bw_pat_leaked'])).toEqual({});
  });

  it.each([
    'user.email',
    'Email',
    'contact.phone',
    'customer.full_name',
    'ip-address',
    'password',
    'api.token',
    'authorization',
    'session.cookie',
  ])('drops the PII or credential key %s whatever its value', (key) => {
    expect(safeAttr(key, 'harmless')).toEqual({});
  });

  it('keeps tenant identifiers as attributes (§8.6)', () => {
    expect(safeAttr('tenant_id', '7c9e6679-7425-40de-944b-e07fc1f90ae7')).toEqual({
      tenant_id: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
    });
  });

  it('drops an undefined value without throwing', () => {
    expect(safeAttr('maybe', undefined)).toEqual({ maybe: undefined });
  });
});
