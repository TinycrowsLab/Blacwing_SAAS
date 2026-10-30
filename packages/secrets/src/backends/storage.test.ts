import { describe, expect, it } from 'vitest';

import { createFakeExternalStore } from './fakes.test-helpers.js';
import { assertStorageShape, storeExternalSecret } from './storage.js';

function codeOf(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return (error as { code?: unknown }).code;
  }
  return undefined;
}

const LOCATOR = { provider: 'fake-vault', tenantId: 'tenant-a', ref: 'x' };
const ENVELOPE = { v: 1 };

describe('assertStorageShape', () => {
  it('accepts an external_store row with a locator and no envelope', () => {
    expect(() => {
      assertStorageShape({ envelope: null, externalLocator: LOCATOR }, 'external_store');
    }).not.toThrow();
  });

  it('accepts a kek_wrap row with an envelope and no locator', () => {
    expect(() => {
      assertStorageShape({ envelope: ENVELOPE, externalLocator: null }, 'kek_wrap');
    }).not.toThrow();
  });

  it('rejects a mixed-mode external record that has no locator', () => {
    expect(
      codeOf(() => {
        assertStorageShape({ envelope: null, externalLocator: null }, 'external_store');
      }),
    ).toBe('ENVELOPE_INVALID');
  });

  it('rejects an external record that also carries an envelope', () => {
    expect(
      codeOf(() => {
        assertStorageShape({ envelope: ENVELOPE, externalLocator: LOCATOR }, 'external_store');
      }),
    ).toBe('ENVELOPE_INVALID');
  });

  it('rejects a kek_wrap record with no envelope, or one that also has a locator', () => {
    expect(
      codeOf(() => {
        assertStorageShape({ envelope: null, externalLocator: null }, 'kek_wrap');
      }),
    ).toBe('ENVELOPE_INVALID');
    expect(
      codeOf(() => {
        assertStorageShape({ envelope: ENVELOPE, externalLocator: LOCATOR }, 'kek_wrap');
      }),
    ).toBe('ENVELOPE_INVALID');
  });
});

describe('storeExternalSecret', () => {
  it('returns only the backend kind and locator, never the value', async () => {
    const { backend } = createFakeExternalStore({ kind: 'vault' });
    const row = await storeExternalSecret(backend, 'tenant-a', 'db-password', 'hunter2-plain');
    expect(row).toEqual({
      backend: 'vault',
      envelope: null,
      externalLocator: expect.objectContaining({ tenantId: 'tenant-a' }) as unknown,
    });
    expect(JSON.stringify(row)).not.toContain('hunter2-plain');
  });

  it('produces no row when the store rejects the write', async () => {
    const { backend, control } = createFakeExternalStore({ kind: 'vault' });
    control.down = true;
    await expect(
      storeExternalSecret(backend, 'tenant-a', 'db-password', 'hunter2-plain'),
    ).rejects.toMatchObject({ code: 'EXTERNAL_BACKEND_UNAVAILABLE' });
  });
});
