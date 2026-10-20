import { describe, expect, it } from 'vitest';

import {
  idempotencyKeySchema,
  KILL_API_SCOPES,
  killTriggerRequestSchema,
  killTriggerResponseSchema,
} from './index.js';

const RUN_ID = '01890a5d-ac96-774b-bcce-b302099a8057';

describe('kill trigger API contracts (KILL-003)', () => {
  it('accepts run, asset and tenant but never global', () => {
    expect(KILL_API_SCOPES).toEqual(['run', 'asset', 'tenant']);
    expect(
      killTriggerRequestSchema.safeParse({ scope: 'global', reason: 'stop all' }).success,
    ).toBe(false);
  });

  it('parses a run kill and enforces the minimum reason length after trimming', () => {
    expect(
      killTriggerRequestSchema.parse({ scope: 'run', scopeRefId: RUN_ID, reason: 'bad' }),
    ).toEqual({ scope: 'run', scopeRefId: RUN_ID, reason: 'bad' });
    expect(
      killTriggerRequestSchema.safeParse({ scope: 'run', scopeRefId: RUN_ID, reason: '  ab  ' })
        .success,
    ).toBe(false);
  });

  it('rejects unknown fields and non-UUIDv7 refs', () => {
    expect(
      killTriggerRequestSchema.safeParse({ scope: 'tenant', reason: 'stop', extra: 1 }).success,
    ).toBe(false);
    expect(
      killTriggerRequestSchema.safeParse({ scope: 'run', scopeRefId: 'run-1', reason: 'stop' })
        .success,
    ).toBe(false);
  });

  it('describes the 202 body', () => {
    expect(
      killTriggerResponseSchema.parse({
        killEventId: RUN_ID,
        status: 'initiated',
        triggeredAt: '2026-10-20T10:00:00.000Z',
      }).status,
    ).toBe('initiated');
  });

  it('bounds the Idempotency-Key to 8..255 visible ASCII characters', () => {
    expect(idempotencyKeySchema.safeParse('k-12345678').success).toBe(true);
    expect(idempotencyKeySchema.safeParse('short').success).toBe(false);
    expect(idempotencyKeySchema.safeParse('has space 123').success).toBe(false);
    expect(idempotencyKeySchema.safeParse('x'.repeat(256)).success).toBe(false);
  });
});
