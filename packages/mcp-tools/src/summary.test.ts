import { describe, expect, it } from 'vitest';

import { summariseInput } from './summary.js';

const identity = (text: string): string => text;

describe('summariseInput', () => {
  it('masks values under secret-looking keys at any depth', () => {
    const summary = summariseInput(
      {
        url: 'https://t',
        headers: { Authorization: 'Bearer abc', 'X-Api-Key': 'k' },
        password: 'p',
        tokenId: 'keep',
      },
      identity,
    );
    expect(summary).not.toContain('abc');
    expect(summary).not.toContain('"k"');
    expect(summary).not.toContain('"p"');
    expect(summary).toContain('tokenId');
    expect(summary).toContain('keep');
  });

  it('redacts credential-shaped strings and applies the injected redactor', () => {
    const summary = summariseInput(
      { note: 'key AKIAABCDEFGHIJKLMNOP and bwk_secretvalue12345678', other: 'custom-secret' },
      (text) => text.replaceAll('custom-secret', '[registry]'),
    );
    expect(summary).not.toContain('AKIAABCDEFGHIJKLMNOP');
    expect(summary).toContain('[registry]');
  });

  it('fails closed with a placeholder when the redactor throws', () => {
    const summary = summariseInput({ a: 'v' }, () => {
      throw new Error('registry down');
    });
    expect(summary).toBe('[summary unavailable]');
  });

  it('bounds length without splitting a surrogate pair', () => {
    const summary = summariseInput({ text: '😀'.repeat(2000) }, identity);
    expect(summary.length).toBeLessThanOrEqual(1024);
    expect(() => {
      encodeURIComponent(summary);
    }).not.toThrow();
  });

  it('survives cyclic, deep and bigint input', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(summariseInput(cyclic, identity)).toContain('[truncated]');
    expect(summariseInput({ n: 10n }, identity)).toContain('"10"');
    expect(summariseInput(undefined, identity)).toBe('null');
  });
});
