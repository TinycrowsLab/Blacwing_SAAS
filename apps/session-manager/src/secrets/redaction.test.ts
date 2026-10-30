import { afterEach, describe, expect, it } from 'vitest';

import { isMarkedSecret, markSecret, unmarkSecret } from '@blackwing/config';

import { createSecretRedactionRegistry } from './redaction.js';

const VALUE = 'hunter2-session-value';

afterEach(() => {
  unmarkSecret(VALUE);
});

describe('createSecretRedactionRegistry', () => {
  it('marks a value for redaction while it is acquired and unmarks it on release', () => {
    const registry = createSecretRedactionRegistry();
    const release = registry.acquire(VALUE);
    expect(registry.has(VALUE)).toBe(true);
    expect(isMarkedSecret(VALUE)).toBe(true);
    expect(registry.size).toBe(1);
    release();
    expect(registry.has(VALUE)).toBe(false);
    expect(registry.size).toBe(0);
  });

  it('keeps the value marked until the last holder releases it', () => {
    const registry = createSecretRedactionRegistry();
    const first = registry.acquire(VALUE);
    const second = registry.acquire(VALUE);
    first();
    expect(registry.has(VALUE)).toBe(true);
    second();
    expect(registry.has(VALUE)).toBe(false);
  });

  it('makes a repeated release of one holder a no-op, so it cannot drop another holder', () => {
    const registry = createSecretRedactionRegistry();
    const first = registry.acquire(VALUE);
    registry.acquire(VALUE);
    first();
    first();
    expect(registry.has(VALUE)).toBe(true);
  });

  it('never unmarks a value that was already marked before the operation acquired it', () => {
    markSecret(VALUE);
    const registry = createSecretRedactionRegistry();
    const release = registry.acquire(VALUE);
    release();
    expect(isMarkedSecret(VALUE)).toBe(true);
  });

  it('tracks distinct values independently', () => {
    const registry = createSecretRedactionRegistry();
    const release = registry.acquire(VALUE);
    const other = registry.acquire('another-session-value');
    expect(registry.size).toBe(2);
    other();
    expect(registry.has(VALUE)).toBe(true);
    expect(registry.has('another-session-value')).toBe(false);
    release();
    unmarkSecret('another-session-value');
  });
});
