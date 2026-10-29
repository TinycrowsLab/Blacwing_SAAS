import { describe, expect, it } from 'vitest';

import { findingQuerySignature, parseFindingListQuery } from './query.js';

/** The wire code of a refused query (`ApiProblemError.problemCode`). */
function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    const code = (error as { problemCode?: unknown }).problemCode;
    if (typeof code === 'string') return code;
    throw error;
  }
  throw new Error('expected the query to be refused');
}

describe('parseFindingListQuery', () => {
  it('defaults the page size to 50 and carries no cursor or filter', () => {
    expect(parseFindingListQuery({})).toEqual({
      filters: {},
      cursor: undefined,
      limit: 50,
    });
  });

  it('accepts every filter of the contract and a string limit', () => {
    const parsed = parseFindingListQuery({
      assetId: '0198f0a0-0000-7000-8000-0000000000e1',
      status: 'confirmed',
      severity: 'high',
      cwe: 'CWE-89',
      owasp: 'A03',
      baselineStatus: 'open',
      limit: '25',
      cursor: 'abc.def',
    });
    expect(parsed.filters).toEqual({
      assetId: '0198f0a0-0000-7000-8000-0000000000e1',
      status: 'confirmed',
      severity: 'high',
      cwe: 'CWE-89',
      owasp: 'A03',
      baselineStatus: 'open',
    });
    expect(parsed.limit).toBe(25);
    expect(parsed.cursor).toBe('abc.def');
  });

  it('clamps a limit above 200 to 200 (§9) and refuses zero, negatives and non-integers', () => {
    expect(parseFindingListQuery({ limit: '5000' }).limit).toBe(200);
    expect(codeOf(() => parseFindingListQuery({ limit: '0' }))).toBe('bad_request');
    expect(codeOf(() => parseFindingListQuery({ limit: '-3' }))).toBe('bad_request');
    expect(codeOf(() => parseFindingListQuery({ limit: '2.5' }))).toBe('bad_request');
    expect(codeOf(() => parseFindingListQuery({ limit: 'many' }))).toBe('bad_request');
  });

  it('refuses an empty or oversized cursor as a bad page query', () => {
    expect(codeOf(() => parseFindingListQuery({ cursor: '' }))).toBe('bad_request');
    expect(codeOf(() => parseFindingListQuery({ cursor: 'x'.repeat(2049) }))).toBe('bad_request');
  });

  it('refuses an unknown filter instead of silently returning every finding', () => {
    expect(codeOf(() => parseFindingListQuery({ severty: 'high' }))).toBe('invalid_filter');
  });

  it('refuses an unknown status, severity band, baseline status or malformed asset id', () => {
    expect(codeOf(() => parseFindingListQuery({ status: 'nonsense' }))).toBe('invalid_filter');
    expect(codeOf(() => parseFindingListQuery({ severity: 'extreme' }))).toBe('invalid_filter');
    expect(codeOf(() => parseFindingListQuery({ baselineStatus: 'maybe' }))).toBe('invalid_filter');
    expect(codeOf(() => parseFindingListQuery({ assetId: 'not-a-uuid' }))).toBe('invalid_filter');
  });

  it('refuses a CWE or OWASP id that is not in the pinned lists (validated, not just shaped)', () => {
    expect(codeOf(() => parseFindingListQuery({ cwe: 'CWE-99999' }))).toBe('invalid_filter');
    expect(codeOf(() => parseFindingListQuery({ cwe: 'CWE-1' }))).toBe('invalid_filter');
    expect(parseFindingListQuery({ cwe: 'CWE-89' }).filters.cwe).toBe('CWE-89');
    expect(codeOf(() => parseFindingListQuery({ owasp: 'A11' }))).toBe('invalid_filter');
    expect(codeOf(() => parseFindingListQuery({ owasp: 'A1' }))).toBe('invalid_filter');
  });

  it('refuses a repeated filter (an array value) as an invalid filter', () => {
    expect(codeOf(() => parseFindingListQuery({ status: ['confirmed', 'released'] }))).toBe(
      'invalid_filter',
    );
  });

  it('names only field paths in the detail, never the rejected value', () => {
    let detail = '';
    try {
      parseFindingListQuery({ status: 'SECRET-VALUE-123' });
    } catch (error) {
      detail = String((error as { detail?: unknown }).detail);
    }
    expect(detail).toContain('status');
    expect(detail).not.toContain('SECRET-VALUE-123');
  });
});

describe('findingQuerySignature', () => {
  it('is stable for equal filters whatever their key order, and differs when they differ', () => {
    const a = parseFindingListQuery({ status: 'confirmed', severity: 'high' }).filters;
    const b = parseFindingListQuery({ severity: 'high', status: 'confirmed' }).filters;
    const c = parseFindingListQuery({ status: 'released' }).filters;
    expect(findingQuerySignature(a, true)).toBe(findingQuerySignature(b, true));
    expect(findingQuerySignature(a, true)).not.toBe(findingQuerySignature(c, true));
  });

  it('differs by viewer visibility, so an analyst cursor cannot be replayed by a non-analyst', () => {
    const filters = parseFindingListQuery({}).filters;
    expect(findingQuerySignature(filters, true)).not.toBe(findingQuerySignature(filters, false));
  });
});
