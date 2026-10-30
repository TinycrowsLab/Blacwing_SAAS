import { describe, expect, it } from 'vitest';

import { createFakeExternalStore, createFakeKekWrapBackend } from './fakes.test-helpers.js';
import { storeExternalSecret } from './storage.js';

const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';
const VALID_REF = 'bw-secret://tenant-a/kms-key';
const DEK = new Uint8Array(32).fill(7);

async function codeOfAsync(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return (error as { code?: unknown }).code;
  }
  return undefined;
}

describe('fake kek_wrap backend (customer KMS stand-in)', () => {
  it('round-trips a DEK and keeps the wrapped form opaque', async () => {
    const { backend } = createFakeKekWrapBackend();
    const wrapped = await backend.wrapDek(TENANT_A, DEK);
    expect(wrapped).not.toContain(Buffer.from(DEK).toString('base64'));
    expect(Buffer.from(await backend.unwrapDek(TENANT_A, wrapped))).toEqual(Buffer.from(DEK));
  });

  it('refuses another tenant’s wrapped DEK', async () => {
    const { backend } = createFakeKekWrapBackend();
    const wrapped = await backend.wrapDek(TENANT_A, DEK);
    expect(await codeOfAsync(backend.unwrapDek(TENANT_B, wrapped))).toBe('SECRET_DECRYPT_FAILED');
  });

  it('detects a tampered ciphertext (GCM authentication)', async () => {
    const { backend } = createFakeKekWrapBackend();
    const wrapped = await backend.wrapDek(TENANT_A, DEK);
    const [scheme, owner, body = ''] = wrapped.split(':');
    const chars = body.split('');
    chars[chars.length - 2] = chars[chars.length - 2] === 'A' ? 'B' : 'A';
    const tampered = `${scheme}:${owner}:${chars.join('')}`;
    expect(await codeOfAsync(backend.unwrapDek(TENANT_A, tampered))).toBe('SECRET_DECRYPT_FAILED');
  });

  it('rejects a malformed wrapped value', async () => {
    const { backend } = createFakeKekWrapBackend();
    expect(await codeOfAsync(backend.unwrapDek(TENANT_A, 'fake-kms:tenant-a:x'))).toBe(
      'SECRET_DECRYPT_FAILED',
    );
  });

  it('fails closed with KEK_UNAVAILABLE when down, and reports unhealthy', async () => {
    const { backend, control } = createFakeKekWrapBackend();
    control.down = true;
    expect(await codeOfAsync(backend.wrapDek(TENANT_A, DEK))).toBe('KEK_UNAVAILABLE');
    expect((await backend.health()).healthy).toBe(false);
    await expect(backend.testAccess()).rejects.toThrow();
  });

  it('rejects an invalid tenant id before touching the KMS', async () => {
    const { backend } = createFakeKekWrapBackend();
    expect(await codeOfAsync(backend.wrapDek('../x', DEK))).toBe('VALIDATION_FAILED');
  });

  it('validates its config and refuses a plaintext credential', () => {
    const { backend } = createFakeKekWrapBackend();
    expect(() => {
      backend.validate({ keyRef: VALID_REF });
    }).not.toThrow();
    expect(() => {
      backend.validate({ keyRef: 'AKIA-plaintext-secret-key' });
    }).toThrow();
  });
});

describe('fake external_store backend (customer vault stand-in)', () => {
  it('puts, gets and deletes a value through its locator', async () => {
    const { backend } = createFakeExternalStore();
    const locator = await backend.put(TENANT_A, 'db-password', 'hunter2');
    expect(Buffer.from(await backend.get(TENANT_A, locator)).toString('utf8')).toBe('hunter2');
    await backend.delete(TENANT_A, locator);
    expect(await codeOfAsync(backend.get(TENANT_A, locator))).toBe('SECRET_NOT_FOUND');
  });

  it('never lets one tenant read or delete another tenant’s locator', async () => {
    const { backend } = createFakeExternalStore();
    const locator = await backend.put(TENANT_A, 'db-password', 'hunter2');
    expect(await codeOfAsync(backend.get(TENANT_B, locator))).toBe('SECRET_NOT_FOUND');
    expect(await codeOfAsync(backend.delete(TENANT_B, locator))).toBe('SECRET_NOT_FOUND');
    expect(Buffer.from(await backend.get(TENANT_A, locator)).toString('utf8')).toBe('hunter2');
  });

  it('keeps plaintext only inside the vault: the persisted row carries the locator alone', async () => {
    const { backend, stored } = createFakeExternalStore();
    const plaintext = 'Zx9!qLm2#Rt7vWp4-customer-only';
    const row = await storeExternalSecret(backend, TENANT_A, 'db-password', plaintext);
    expect(JSON.stringify(row)).not.toContain(plaintext);
    expect(row.envelope).toBeNull();
    expect(row.backend).toBe('vault');
    expect(Buffer.from(stored.get(TENANT_A)?.get('db-password') ?? []).toString('utf8')).toBe(
      plaintext,
    );
  });

  it('rejects an unsafe store reference', async () => {
    const { backend } = createFakeExternalStore();
    expect(await codeOfAsync(backend.put(TENANT_A, '../escape', 'x'))).toBe('VALIDATION_FAILED');
  });

  it('fails closed with EXTERNAL_BACKEND_UNAVAILABLE when down', async () => {
    const { backend, control } = createFakeExternalStore();
    const locator = await backend.put(TENANT_A, 'db-password', 'hunter2');
    control.down = true;
    expect(await codeOfAsync(backend.get(TENANT_A, locator))).toBe('EXTERNAL_BACKEND_UNAVAILABLE');
    expect((await backend.health()).healthy).toBe(false);
  });

  it('validates its config: a plaintext token is refused, a secret_ref is accepted', () => {
    const { backend } = createFakeExternalStore();
    expect(() => {
      backend.validate({ address: 'https://vault.example.com', tokenRef: VALID_REF });
    }).not.toThrow();
    expect(() => {
      backend.validate({ address: 'https://vault.example.com', tokenRef: 'hvs.plaintext-token' });
    }).toThrow();
  });
});
