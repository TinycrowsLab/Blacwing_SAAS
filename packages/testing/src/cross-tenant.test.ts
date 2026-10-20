import { describe, expect, it } from 'vitest';

import {
  CrossTenantAssertionError,
  crossTenantDenied,
  isDenialError,
  isEmptyResult,
} from './cross-tenant.js';

const A = '01900000-0000-7000-8000-00000000000a';
const B = '01900000-0000-7000-8000-00000000000b';
const opts = { ownerTenantId: A, otherTenantId: B, subject: 'probe row' };

/** A store that behaves like a correctly isolated repository. */
const isolated = (tenantId: string): Promise<string[]> =>
  Promise.resolve(tenantId === A ? ['row-of-a'] : []);

async function failure(promise: Promise<unknown>): Promise<CrossTenantAssertionError> {
  const error: unknown = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  if (!(error instanceof CrossTenantAssertionError))
    throw new Error('expected a CrossTenantAssertionError');
  return error;
}

describe('crossTenantDenied', () => {
  it('passes when the owner reads data and the other tenant gets nothing', async () => {
    await expect(crossTenantDenied(isolated, opts)).resolves.toEqual({
      ownerResult: ['row-of-a'],
      denial: 'empty',
    });
  });

  it("passes when the other tenant's read is denied with a recognised error", async () => {
    const read = (tenantId: string): Promise<string> =>
      tenantId === A
        ? Promise.resolve('ok')
        : Promise.reject(Object.assign(new Error('rls'), { code: '42501' }));
    await expect(crossTenantDenied(read, opts)).resolves.toMatchObject({ denial: 'error' });
  });

  it('fails on a cross-tenant leak', async () => {
    const leaky = (): Promise<string[]> => Promise.resolve(['row-of-a']);
    const error = await failure(crossTenantDenied(leaky, opts));
    expect(error.reason).toBe('cross_tenant_leak');
    expect(error.message).toMatch(/§8\.6/);
  });

  it('catches the false negative: an empty same-tenant read fails the check', async () => {
    // A broken query returns nothing for everyone, so a denial-only assertion would pass.
    const broken = (): Promise<string[]> => Promise.resolve([]);
    expect((await failure(crossTenantDenied(broken, opts))).reason).toBe('owner_read_empty');
  });

  it('catches the false negative: a failing same-tenant read fails the check', async () => {
    const throwing = (): Promise<string[]> =>
      Promise.reject(Object.assign(new Error('rls'), { code: '42501' }));
    const error = await failure(crossTenantDenied(throwing, opts));
    expect(error.reason).toBe('owner_read_failed');
    expect(error.cause).toBeInstanceOf(Error);
  });

  it('does not treat an unrelated error as a denial', async () => {
    const read = (tenantId: string): Promise<string> =>
      tenantId === A
        ? Promise.resolve('ok')
        : Promise.reject(Object.assign(new Error('syntax'), { code: '42601' }));
    expect((await failure(crossTenantDenied(read, opts))).reason).toBe('unexpected_error');
  });

  it('accepts a custom denial classifier', async () => {
    const read = (tenantId: string): Promise<string> =>
      tenantId === A ? Promise.resolve('ok') : Promise.reject(new Error('custom'));
    const isDenial = (e: unknown): boolean => e instanceof Error && e.message === 'custom';
    await expect(crossTenantDenied(read, { ...opts, isDenial })).resolves.toMatchObject({
      denial: 'error',
    });
  });

  it('refuses a misconfigured check (same tenant twice, empty ids)', async () => {
    expect(
      (await failure(crossTenantDenied(isolated, { ownerTenantId: A, otherTenantId: A }))).reason,
    ).toBe('misconfigured');
    expect(
      (await failure(crossTenantDenied(isolated, { ownerTenantId: '', otherTenantId: B }))).reason,
    ).toBe('misconfigured');
  });

  it('reads the owner first, then the other tenant', async () => {
    const calls: string[] = [];
    await crossTenantDenied((tenantId) => {
      calls.push(tenantId);
      return isolated(tenantId);
    }, opts);
    expect(calls).toEqual([A, B]);
  });
});

describe('isEmptyResult', () => {
  it.each([
    [null, true],
    [undefined, true],
    [false, true],
    [0, true],
    [[], true],
    [new Map(), true],
    [new Set(), true],
    [{ rows: [], rowCount: 0 }, true],
    [{ records: [] }, true],
    [[1], false],
    [{ rows: [{ id: 1 }] }, false],
    [{ records: [{}] }, false],
    ['text', false],
    [1, false],
    [{ id: 1 }, false],
  ] as const)('%j -> %s', (value, expected) => {
    expect(isEmptyResult(value)).toBe(expected);
  });
});

describe('isDenialError', () => {
  it.each([
    [{ code: '42501' }, true],
    [{ code: 'NOT_FOUND' }, true],
    [{ code: 'FORBIDDEN' }, true],
    [{ code: 'TENANT_ACCESS_DENIED' }, true],
    [{ httpStatus: 404 }, true],
    [{ status: 403 }, true],
    [{ code: '42601' }, false],
    [{ status: 500 }, false],
    [new Error('plain'), false],
    ['string', false],
    [null, false],
  ] as const)('%j -> %s', (value, expected) => {
    expect(isDenialError(value)).toBe(expected);
  });
});
