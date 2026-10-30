import { describe, expect, it } from 'vitest';

import { createFakeExternalStore, createFakeKekWrapBackend } from './fakes.test-helpers.js';
import { createRegistryFetcher } from './fetcher.js';
import { createBackendRegistry } from './registry.js';

import type { SecretRecord } from '../resolve.js';

const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';

function record(overrides: Partial<SecretRecord>): SecretRecord {
  return {
    id: 'sec-1',
    tenantId: TENANT_A,
    type: 'static',
    purpose: 'login',
    backend: 'vault',
    status: 'active',
    version: 1,
    envelope: null,
    externalLocator: null,
    ...overrides,
  } as SecretRecord;
}

async function codeOfAsync(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return (error as { code?: unknown }).code;
  }
  return undefined;
}

const SIGNAL = { signal: new AbortController().signal };

async function setup() {
  const vault = createFakeExternalStore({ kind: 'vault' });
  const kms = createFakeKekWrapBackend({ kind: 'aws_kms' });
  const openbao = createFakeKekWrapBackend({ kind: 'openbao' });
  const registry = createBackendRegistry({
    backends: [openbao.backend, kms.backend, vault.backend],
  });
  const locator = await vault.backend.put(TENANT_A, 'db-password', 'hunter2');
  const fetcher = createRegistryFetcher(registry);
  const fetch = (r: SecretRecord) => fetcher.fetch(r, SIGNAL);
  return { fetch, vault, kms, locator };
}

describe('createRegistryFetcher', () => {
  it('returns the value for an external_store record through its locator', async () => {
    const { fetch, locator } = await setup();
    const raw = await fetch(record({ externalLocator: locator }));
    expect(Buffer.from(raw).toString('utf8')).toBe('hunter2');
  });

  it('never serves a record to another tenant (the locator names its tenant)', async () => {
    const { fetch, locator } = await setup();
    expect(await codeOfAsync(fetch(record({ tenantId: TENANT_B, externalLocator: locator })))).toBe(
      'SECRET_NOT_FOUND',
    );
  });

  it('rejects a mixed-mode record: external backend with no locator', async () => {
    const { fetch } = await setup();
    expect(await codeOfAsync(fetch(record({ externalLocator: null })))).toBe('ENVELOPE_INVALID');
  });

  it('rejects a record that holds an envelope under an external backend', async () => {
    const { fetch, locator } = await setup();
    expect(
      await codeOfAsync(fetch(record({ externalLocator: locator, envelope: { v: 1 } as never }))),
    ).toBe('ENVELOPE_INVALID');
  });

  it('never returns plaintext from a kek_wrap backend, which holds no customer store', async () => {
    const { fetch } = await setup();
    expect(
      await codeOfAsync(fetch(record({ backend: 'aws_kms', externalLocator: { ref: 'x' } }))),
    ).toBe('EXTERNAL_BACKEND_UNAVAILABLE');
  });

  it('fails closed with EXTERNAL_BACKEND_UNAVAILABLE when the vault is down', async () => {
    const { fetch, vault, locator } = await setup();
    vault.control.down = true;
    expect(await codeOfAsync(fetch(record({ externalLocator: locator })))).toBe(
      'EXTERNAL_BACKEND_UNAVAILABLE',
    );
  });

  it('rejects an unregistered backend kind', async () => {
    const { fetch, locator } = await setup();
    expect(
      await codeOfAsync(fetch(record({ backend: 'azure_kv', externalLocator: locator }))),
    ).toBe('UNKNOWN_SECRET_BACKEND');
  });
});
