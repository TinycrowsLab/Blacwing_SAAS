import { describe, expect, it } from 'vitest';

import { isMarkedSecret, markSecret, redactionRegistry, unmarkSecret } from './redaction.js';

describe('redaction registry', () => {
  it('markSecret adds the value and returns it unchanged', () => {
    const value = 'registry-secret-value-1';
    const before = redactionRegistry.version;
    const branded = markSecret(value);
    expect(branded).toBe(value);
    expect(isMarkedSecret(value)).toBe(true);
    expect(redactionRegistry.has(value)).toBe(true);
    expect(redactionRegistry.values()).toContain(value);
    expect(redactionRegistry.version).toBe(before + 1);
  });

  it('is idempotent: re-registering does not bump the version', () => {
    const value = 'registry-secret-value-2';
    markSecret(value);
    const { size, version } = redactionRegistry;
    markSecret(value);
    expect(redactionRegistry.size).toBe(size);
    expect(redactionRegistry.version).toBe(version);
  });

  it('never registers the empty string', () => {
    const size = redactionRegistry.size;
    expect(markSecret('')).toBe('');
    expect(isMarkedSecret('')).toBe(false);
    expect(redactionRegistry.size).toBe(size);
  });

  it('stores values verbatim: whitespace and Unicode are not normalised', () => {
    const padded = '  padded secret\t';
    const composed = 'café-secret';
    const decomposed = 'café-secret';
    markSecret(padded);
    markSecret(composed);
    expect(isMarkedSecret(padded)).toBe(true);
    expect(isMarkedSecret(padded.trim())).toBe(false);
    expect(isMarkedSecret(composed)).toBe(true);
    expect(isMarkedSecret(decomposed)).toBe(false);
  });

  it('unmarkSecret removes a value and reports whether it was present', () => {
    const value = 'registry-secret-value-3';
    markSecret(value);
    const version = redactionRegistry.version;
    expect(unmarkSecret(value)).toBe(true);
    expect(isMarkedSecret(value)).toBe(false);
    expect(redactionRegistry.version).toBe(version + 1);
    expect(unmarkSecret(value)).toBe(false);
    expect(redactionRegistry.version).toBe(version + 1);
  });

  it('values() is a frozen snapshot that cannot mutate the registry', () => {
    const value = 'registry-secret-value-4';
    markSecret(value);
    const snapshot = redactionRegistry.values();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(() => {
      (snapshot as string[]).pop();
    }).toThrow(TypeError);
    expect(isMarkedSecret(value)).toBe(true);
  });

  it('the registry object itself is frozen', () => {
    expect(Object.isFrozen(redactionRegistry)).toBe(true);
  });
});
