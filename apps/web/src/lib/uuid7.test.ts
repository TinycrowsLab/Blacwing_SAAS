import { describe, expect, it } from 'vitest';

import { uuidV7 } from './uuid7.js';

describe('uuidV7', () => {
  it('is a canonical v7 with the RFC variant and a unique value each call', () => {
    const ids = new Set(Array.from({ length: 200 }, () => uuidV7()));
    expect(ids.size).toBe(200);
    for (const id of ids)
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('encodes the millisecond timestamp in the first 48 bits', () => {
    const ms = 1_700_000_000_123;
    const id = uuidV7(() => ms);
    expect(Number.parseInt(id.replace(/-/g, '').slice(0, 12), 16)).toBe(ms);
  });
});
