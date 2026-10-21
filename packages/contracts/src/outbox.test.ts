// Outbox message contract rules (CONTEXT_PACK §7, §8.7, §8.8).

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  OUTBOX_BATCH_MAX,
  OUTBOX_MESSAGE_TYPES,
  OUTBOX_PAYLOAD_MAX_BYTES,
  OUTBOX_PAYLOAD_MAX_DEPTH,
  OutboxMessageSchema,
  outboxMessagesSchema,
  outboxPayloadBytes,
  outboxPayloadRefSchema,
} from './index.js';

const ID = '01900000-0000-7000-8000-000000000001';
const message = { type: 'audit.event', payload: { action: 'run.created' } };

/** Postgres renders jsonb with a space after every `:` and `,`. */
function jsonbText(value: unknown): string {
  return JSON.stringify(value).replace(
    /("(?:[^"\\]|\\.)*")|([:,])/g,
    (_all, str: string | undefined, sep: string | undefined) => str ?? `${sep ?? ''} `,
  );
}

describe('OutboxMessageSchema', () => {
  it('accepts the minimal message and the full message', () => {
    expect(OutboxMessageSchema.parse(message)).toEqual(message);
    const full = {
      type: 'temporal.signal',
      aggregateType: 'run',
      aggregateId: ID,
      payload: { signal: 'kill', nested: { list: [1, 'two', null, true] } },
      dedupeKey: 'run:kill:01900000',
    };
    expect(OutboxMessageSchema.parse(full)).toEqual(full);
  });

  it('knows the three message types of the issue', () => {
    expect(OUTBOX_MESSAGE_TYPES).toEqual(['audit.event', 'notify.send', 'temporal.signal']);
    for (const type of OUTBOX_MESSAGE_TYPES) {
      expect(OutboxMessageSchema.safeParse({ ...message, type }).success).toBe(true);
    }
  });

  it('rejects an unknown type, so a typo never becomes an undeliverable row', () => {
    expect(OutboxMessageSchema.safeParse({ ...message, type: 'audit.evnt' }).success).toBe(false);
    expect(OutboxMessageSchema.safeParse({ ...message, type: '' }).success).toBe(false);
  });

  it('has no tenant and no delivery-time field: unknown keys are rejected', () => {
    for (const extra of [
      { tenantId: ID },
      { tenant_id: ID },
      { availableAt: '2026-01-01T00:00:00.000Z' },
      { status: 'dispatched' },
    ]) {
      expect(OutboxMessageSchema.safeParse({ ...message, ...extra }).success).toBe(false);
    }
  });

  it('requires an object payload', () => {
    for (const payload of [undefined, null, 'text', 7, [1, 2]]) {
      expect(OutboxMessageSchema.safeParse({ ...message, payload }).success).toBe(false);
    }
  });

  it('rejects values JSON cannot carry', () => {
    for (const payload of [
      { n: Number.NaN },
      { n: Number.POSITIVE_INFINITY },
      { f: () => 1 },
      { u: undefined },
      { b: 10n },
    ]) {
      expect(OutboxMessageSchema.safeParse({ ...message, payload }).success).toBe(false);
    }
  });

  it('validates the dedupe key and the aggregate fields', () => {
    expect(OutboxMessageSchema.safeParse({ ...message, dedupeKey: '' }).success).toBe(false);
    expect(OutboxMessageSchema.safeParse({ ...message, dedupeKey: 'has space' }).success).toBe(
      false,
    );
    expect(OutboxMessageSchema.safeParse({ ...message, dedupeKey: 'k'.repeat(256) }).success).toBe(
      false,
    );
    expect(OutboxMessageSchema.safeParse({ ...message, dedupeKey: 'k'.repeat(255) }).success).toBe(
      true,
    );
    expect(OutboxMessageSchema.safeParse({ ...message, aggregateId: 'nope' }).success).toBe(false);
    expect(OutboxMessageSchema.safeParse({ ...message, aggregateType: 'Run' }).success).toBe(false);
  });
});

describe('payload cap (64 KiB of jsonb text)', () => {
  const sized = (bytes: number): Record<string, unknown> => {
    // {"b": ""} is 9 bytes around the string.
    return { b: 'x'.repeat(bytes - 9) };
  };

  it('accepts a payload exactly at the cap and rejects one byte over', () => {
    expect(outboxPayloadBytes(sized(OUTBOX_PAYLOAD_MAX_BYTES))).toBe(OUTBOX_PAYLOAD_MAX_BYTES);
    expect(
      OutboxMessageSchema.safeParse({ ...message, payload: sized(OUTBOX_PAYLOAD_MAX_BYTES) })
        .success,
    ).toBe(true);
    const over = OutboxMessageSchema.safeParse({
      ...message,
      payload: sized(OUTBOX_PAYLOAD_MAX_BYTES + 1),
    });
    expect(over.success).toBe(false);
    expect(over.error?.issues[0]?.message).toContain('payloadRef');
  });

  it('counts UTF-8 bytes, not characters', () => {
    const payload = { b: 'é'.repeat(OUTBOX_PAYLOAD_MAX_BYTES / 2) };
    expect(OutboxMessageSchema.safeParse({ ...message, payload }).success).toBe(false);
  });

  it('matches the jsonb text size for arbitrary JSON (never under-counts)', () => {
    fc.assert(
      fc.property(fc.dictionary(fc.string(), fc.jsonValue({ maxDepth: 4 })), (payload) => {
        expect(outboxPayloadBytes(payload)).toBeGreaterThanOrEqual(
          new TextEncoder().encode(jsonbText(payload)).byteLength,
        );
      }),
    );
  });

  it('is exact when no number is in exponent form', () => {
    const payload = { a: [1, 22, -3.5, true, false, null], b: { c: 'é"\\\n', d: {} }, e: [] };
    expect(outboxPayloadBytes(payload)).toBe(new TextEncoder().encode(jsonbText(payload)).length);
  });

  it('rounds exponent-form numbers up, as Postgres expands them', () => {
    expect(outboxPayloadBytes({ n: 1e300 })).toBeGreaterThanOrEqual(301 + 6);
    expect(outboxPayloadBytes({ n: 1e-300 })).toBeGreaterThanOrEqual(302 + 6);
  });

  it('rejects a payload nested deeper than the limit', () => {
    let nested: Record<string, unknown> = { leaf: 1 };
    for (let i = 1; i <= OUTBOX_PAYLOAD_MAX_DEPTH; i += 1) nested = { n: nested };
    expect(OutboxMessageSchema.safeParse({ ...message, payload: nested }).success).toBe(false);
    let atLimit: Record<string, unknown> = { leaf: 1 };
    for (let i = 2; i <= OUTBOX_PAYLOAD_MAX_DEPTH; i += 1) atLimit = { n: atLimit };
    expect(OutboxMessageSchema.safeParse({ ...message, payload: atLimit }).success).toBe(true);
  });

  it('accepts a pointer to an oversized body', () => {
    const payloadRef = {
      payloadRef: {
        s3Key: 'tenants/t/outbox/abc.json',
        sha256: 'a'.repeat(64),
        sizeBytes: 200_000,
      },
    };
    expect(outboxPayloadRefSchema.parse(payloadRef)).toEqual(payloadRef);
    expect(OutboxMessageSchema.safeParse({ ...message, payload: payloadRef }).success).toBe(true);
    expect(
      outboxPayloadRefSchema.safeParse({ payloadRef: { ...payloadRef.payloadRef, sha256: 'xyz' } })
        .success,
    ).toBe(false);
    expect(outboxPayloadRefSchema.safeParse({ ...payloadRef, body: 'inline blob' }).success).toBe(
      false,
    );
  });
});

describe('outboxMessagesSchema', () => {
  it('accepts an empty batch and a full batch, rejects one more', () => {
    expect(outboxMessagesSchema.parse([])).toEqual([]);
    expect(
      outboxMessagesSchema.safeParse(Array.from({ length: OUTBOX_BATCH_MAX }, () => message))
        .success,
    ).toBe(true);
    expect(
      outboxMessagesSchema.safeParse(Array.from({ length: OUTBOX_BATCH_MAX + 1 }, () => message))
        .success,
    ).toBe(false);
  });
});
