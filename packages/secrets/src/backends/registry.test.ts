import { describe, expect, it } from 'vitest';

import { createFakeExternalStore, createFakeKekWrapBackend } from './fakes.test-helpers.js';
import { createBackendRegistry, DEFAULT_SECRET_BACKEND } from './registry.js';

import type { SecretBackendImpl } from './types.js';

const TENANT = 'tenant-a';

function codeOf(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return (error as { code?: unknown }).code;
  }
  return undefined;
}

async function codeOfAsync(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return (error as { code?: unknown }).code;
  }
  return undefined;
}

function build() {
  const kms = createFakeKekWrapBackend({ kind: 'aws_kms' });
  const vault = createFakeExternalStore({ kind: 'vault' });
  const openbao = createFakeKekWrapBackend({ kind: 'openbao' });
  const registry = createBackendRegistry({
    backends: [openbao.backend, kms.backend, vault.backend],
  });
  return { registry, kms, vault, openbao };
}

describe('backendRegistry', () => {
  it('resolves openbao by default as the kek_wrap backend', () => {
    const { registry } = build();
    expect(DEFAULT_SECRET_BACKEND).toBe('openbao');
    const backend = registry.resolveDefault();
    expect(backend.kind).toBe('openbao');
    expect(backend.mode).toBe('kek_wrap');
  });

  it('resolves each fake backend by its kind and lists the registered kinds', () => {
    const { registry } = build();
    expect(registry.resolve('aws_kms').mode).toBe('kek_wrap');
    expect(registry.resolve('vault').mode).toBe('external_store');
    expect(registry.kinds).toEqual(['openbao', 'aws_kms', 'vault']);
  });

  it('rejects an unknown or prototype-named kind with UNKNOWN_SECRET_BACKEND', () => {
    const { registry } = build();
    for (const kind of ['azure_kv', 'constructor', '__proto__', '']) {
      expect(codeOf(() => registry.resolve(kind))).toBe('UNKNOWN_SECRET_BACKEND');
    }
  });

  it('refuses a duplicate registration at boot', () => {
    const a = createFakeKekWrapBackend({ kind: 'aws_kms' }).backend;
    const b = createFakeExternalStore({ kind: 'vault' }).backend;
    const dup = createFakeKekWrapBackend({ kind: 'aws_kms' }).backend;
    expect(
      codeOf(() => createBackendRegistry({ backends: [a, b, dup], defaultKind: 'aws_kms' })),
    ).toBe('CONFIG_INVALID');
  });

  it('refuses a default backend that is not registered', () => {
    const kms = createFakeKekWrapBackend({ kind: 'aws_kms' }).backend;
    expect(codeOf(() => createBackendRegistry({ backends: [kms] }))).toBe('CONFIG_INVALID');
  });

  it('honours an explicit default kind', () => {
    const kms = createFakeKekWrapBackend({ kind: 'aws_kms' }).backend;
    const registry = createBackendRegistry({ backends: [kms], defaultKind: 'aws_kms' });
    expect(registry.resolveDefault().kind).toBe('aws_kms');
  });

  it('resolves a healthy backend', async () => {
    const { registry } = build();
    expect((await registry.resolveHealthy('vault')).kind).toBe('vault');
  });

  it('fails closed when a backend is down: the call errors and never returns another backend', async () => {
    const { registry, vault } = build();
    vault.control.down = true;
    expect(await codeOfAsync(registry.resolveHealthy('vault'))).toBe(
      'EXTERNAL_BACKEND_UNAVAILABLE',
    );
    // The openbao backend is healthy, but a down vault must not be answered by it.
    expect((await registry.resolveHealthy('openbao')).kind).toBe('openbao');
  });

  it('uses KEK_UNAVAILABLE for a down kek_wrap backend', async () => {
    const { registry, kms } = build();
    kms.control.down = true;
    expect(await codeOfAsync(registry.resolveHealthy('aws_kms'))).toBe('KEK_UNAVAILABLE');
  });

  it('treats a health probe that throws as unhealthy', async () => {
    const base = createFakeExternalStore({ kind: 'azure_kv' }).backend;
    const throwing: SecretBackendImpl = {
      ...base,
      health: () => Promise.reject(new Error('network')),
    };
    const registry = createBackendRegistry({ backends: [throwing], defaultKind: 'azure_kv' });
    expect(await codeOfAsync(registry.resolveHealthy('azure_kv'))).toBe(
      'EXTERNAL_BACKEND_UNAVAILABLE',
    );
  });

  it('reports UNKNOWN_SECRET_BACKEND from resolveHealthy for an unregistered kind', async () => {
    const { registry } = build();
    expect(await codeOfAsync(registry.resolveHealthy('nope'))).toBe('UNKNOWN_SECRET_BACKEND');
  });

  it('takes the tenant per call, so one resolved backend serves many tenants isolated by locator', async () => {
    const { registry, vault } = build();
    const backend = registry.resolve('vault');
    if (backend.mode !== 'external_store') throw new Error('expected an external store');
    const locator = await backend.put(TENANT, 'db-password', 'hunter2');
    expect(vault.stored.get(TENANT)?.size).toBe(1);
    expect(locator.tenantId).toBe(TENANT);
    expect(await codeOfAsync(backend.get('tenant-b', locator))).toBe('SECRET_NOT_FOUND');
  });
});
