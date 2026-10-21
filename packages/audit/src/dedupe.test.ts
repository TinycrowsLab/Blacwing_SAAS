import { describe, expect, it } from 'vitest';

import { isUuidV7 } from '@blackwing/ids';

import { deriveAuditEventId } from './draft.js';
import { AuditEventInvalidError } from './errors.js';
import { TENANT_A, TENANT_B } from './test-support.js';

describe('deriveAuditEventId', () => {
  it('is deterministic and a valid UUIDv7', () => {
    const id = deriveAuditEventId(TENANT_A, 'gate2:run-1');
    expect(deriveAuditEventId(TENANT_A, 'gate2:run-1')).toBe(id);
    expect(isUuidV7(id)).toBe(true);
    expect(id).toBe(id.toLowerCase());
  });

  it('differs per key and per tenant', () => {
    const ids = new Set([
      deriveAuditEventId(TENANT_A, 'a'),
      deriveAuditEventId(TENANT_A, 'b'),
      deriveAuditEventId(TENANT_B, 'a'),
    ]);
    expect(ids.size).toBe(3);
  });

  it('separates tenant and key unambiguously', () => {
    expect(deriveAuditEventId('t', 'x:y')).not.toBe(deriveAuditEventId('t:x', 'y'));
  });

  it.each(['', ' ', 'a b', 'é', 'x'.repeat(256)])('rejects the key %j', (key) => {
    expect(() => deriveAuditEventId(TENANT_A, key)).toThrow(AuditEventInvalidError);
  });
});
