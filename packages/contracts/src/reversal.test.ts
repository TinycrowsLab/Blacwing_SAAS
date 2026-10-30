import { describe, expect, it } from 'vitest';

import {
  jsonByteLength,
  REVERSAL_INLINE_MAX_BYTES,
  REVERSAL_UNDO_STATUSES,
  reversalJournalCreateSchema,
  reversalJournalEntrySchema,
  reversalTargetSchema,
  reversalUndoDescriptorSchema,
  reversalUndoPayloadSchema,
  reversalUndoStatusSchema,
} from './reversal.js';

const UUID_A = '0190f3a2-7c1d-7b2e-9f00-000000000001';
const UUID_B = '0190f3a2-7c1d-7b2e-9f00-000000000002';
const UUID_C = '0190f3a2-7c1d-7b2e-9f00-000000000003';
const EVIDENCE = '0190f3a2-7c1d-7b2e-9f00-0000000000e1';
const PUBLIC_ID = 'rvj_01hzx3k6w8f5r4t2n9q7x0m1ab';
const STAMP = '2026-10-30T07:00:00.000Z';

const target = {
  kind: 'endpoint',
  ref: 'orders.create',
  method: 'POST',
  urlTemplate: '/orders/{id}',
} as const;
const undo = {
  type: 'delete_created_resource',
  params: { resourceId: 'ord_123', attempts: 1 },
} as const;

const validCreate = {
  tenantId: UUID_A,
  runId: UUID_B,
  testCaseId: UUID_C,
  action: 'create order',
  target,
  undoInstructions: undo,
};

describe('reversal undo status', () => {
  it('lists exactly the four lifecycle values', () => {
    expect(REVERSAL_UNDO_STATUSES).toEqual(['pending', 'undone', 'not_needed', 'failed']);
  });

  it('accepts each lifecycle value and rejects an unknown one', () => {
    for (const status of REVERSAL_UNDO_STATUSES) {
      expect(reversalUndoStatusSchema.parse(status)).toBe(status);
    }
    expect(reversalUndoStatusSchema.safeParse('reverted').success).toBe(false);
    expect(reversalUndoStatusSchema.safeParse('Pending').success).toBe(false);
    expect(reversalUndoStatusSchema.safeParse(' undone').success).toBe(false);
  });
});

describe('undo descriptor (typed, never a command)', () => {
  it('accepts a declared type with flat scalar params', () => {
    expect(reversalUndoDescriptorSchema.parse(undo)).toEqual(undo);
    expect(
      reversalUndoDescriptorSchema.safeParse({
        type: 'restore_field',
        params: { flag: true, n: null },
      }).success,
    ).toBe(true);
  });

  it('rejects an unknown type and any command-like key (no free-form shell)', () => {
    expect(reversalUndoDescriptorSchema.safeParse({ type: 'shell', params: {} }).success).toBe(
      false,
    );
    expect(
      reversalUndoDescriptorSchema.safeParse({
        type: 'http_request',
        params: {},
        command: 'rm -rf /',
      }).success,
    ).toBe(false);
    expect(
      reversalUndoDescriptorSchema.safeParse({ type: 'http_request', params: { 'bad key': 'x' } })
        .success,
    ).toBe(false);
  });

  it('rejects nested values, so the descriptor stays flat', () => {
    expect(
      reversalUndoDescriptorSchema.safeParse({ type: 'http_request', params: { body: { a: 1 } } })
        .success,
    ).toBe(false);
    expect(
      reversalUndoDescriptorSchema.safeParse({ type: 'http_request', params: { list: [1] } })
        .success,
    ).toBe(false);
  });

  it('refuses more than 32 parameters', () => {
    const params = Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`p${i}`, i]));
    expect(reversalUndoDescriptorSchema.safeParse({ type: 'http_request', params }).success).toBe(
      false,
    );
  });
});

describe('target', () => {
  it('accepts a method only on an endpoint target', () => {
    expect(
      reversalTargetSchema.safeParse({ kind: 'record', ref: 'orders/1', method: 'DELETE' }).success,
    ).toBe(false);
    expect(reversalTargetSchema.safeParse({ kind: 'record', ref: 'orders/1' }).success).toBe(true);
    expect(reversalTargetSchema.safeParse(target).success).toBe(true);
  });

  it('refuses an unknown method and an unknown kind', () => {
    expect(
      reversalTargetSchema.safeParse({ kind: 'endpoint', ref: 'x', method: 'GET' }).success,
    ).toBe(false);
    expect(reversalTargetSchema.safeParse({ kind: 'database', ref: 'x' }).success).toBe(false);
  });

  it('NFC-normalises its text before it is stored (decomposed e-acute becomes one code point)', () => {
    const decomposed = 'café';
    const parsed = reversalTargetSchema.parse({ kind: 'resource', ref: decomposed });
    expect(parsed.ref).toBe('café');
  });

  it('refuses control characters in the reference', () => {
    expect(reversalTargetSchema.safeParse({ kind: 'resource', ref: 'bad\u0007ref' }).success).toBe(
      false,
    );
  });
});

describe('inline size cap and evidence overflow', () => {
  it('keeps the largest descriptor the field limits allow inside the inline cap', () => {
    // 32 parameters, each a 64-character key and a 200-character value: the field limits bound the inline size well
    // under 16 KiB, so an oversized payload can only arrive as an evidence reference.
    const params = Object.fromEntries(
      Array.from({ length: 32 }, (_, i) => [
        `k${String(i).padStart(3, '0')}${'x'.repeat(60)}`,
        'a'.repeat(200),
      ]),
    );
    const largest = { type: 'http_request', params };
    expect(jsonByteLength(largest)).toBeLessThan(REVERSAL_INLINE_MAX_BYTES);
    expect(reversalUndoPayloadSchema.safeParse(largest).success).toBe(true);
  });

  it('refuses a parameter value over the label limit, so the inline payload stays bounded', () => {
    const over = { type: 'http_request', params: { blob: 'a'.repeat(201) } };
    expect(reversalUndoPayloadSchema.safeParse(over).success).toBe(false);
  });

  it('accepts an evidence reference for an oversized payload, and only a uuid evidence id', () => {
    expect(reversalUndoPayloadSchema.safeParse({ evidenceId: EVIDENCE }).success).toBe(true);
    expect(reversalUndoPayloadSchema.safeParse({ evidenceId: 'not-a-uuid' }).success).toBe(false);
    expect(reversalUndoPayloadSchema.safeParse({ evidenceId: EVIDENCE, extra: 1 }).success).toBe(
      false,
    );
  });
});

describe('reversalJournalCreateSchema', () => {
  it('accepts a valid create with no subtask, and with one', () => {
    expect(reversalJournalCreateSchema.parse(validCreate)).toMatchObject(validCreate);
    expect(reversalJournalCreateSchema.parse({ ...validCreate, subtaskId: UUID_A }).subtaskId).toBe(
      UUID_A,
    );
  });

  it('refuses a tenant-less create (fails closed before any write)', () => {
    const withoutTenant: Record<string, unknown> = { ...validCreate };
    delete withoutTenant.tenantId;
    expect(reversalJournalCreateSchema.safeParse(withoutTenant).success).toBe(false);
  });

  it('refuses an id that is not a lowercase UUIDv7', () => {
    expect(
      reversalJournalCreateSchema.safeParse({ ...validCreate, runId: 'run_abc' }).success,
    ).toBe(false);
    expect(
      reversalJournalCreateSchema.safeParse({ ...validCreate, testCaseId: UUID_A.toUpperCase() })
        .success,
    ).toBe(false);
  });

  it('refuses an unknown key (for example a caller-chosen status)', () => {
    expect(
      reversalJournalCreateSchema.safeParse({ ...validCreate, undoStatus: 'undone' }).success,
    ).toBe(false);
  });

  it('refuses an empty action', () => {
    expect(reversalJournalCreateSchema.safeParse({ ...validCreate, action: '' }).success).toBe(
      false,
    );
  });
});

describe('reversalJournalEntrySchema', () => {
  const entry = {
    id: UUID_A,
    publicId: PUBLIC_ID,
    tenantId: UUID_B,
    runId: UUID_B,
    testCaseId: UUID_C,
    subtaskId: null,
    action: 'create order',
    target,
    intrusivenessClass: 'state_changing',
    undoInstructions: undo,
    undoStatus: 'pending',
    undoAttempts: 0,
    undoneAt: null,
    createdAt: STAMP,
    updatedAt: STAMP,
  } as const;

  it('accepts a valid entry', () => {
    expect(reversalJournalEntrySchema.parse(entry)).toEqual(entry);
  });

  it('rejects an unknown undo_status', () => {
    expect(reversalJournalEntrySchema.safeParse({ ...entry, undoStatus: 'reverted' }).success).toBe(
      false,
    );
  });

  it('rejects a non-state_changing intrusiveness class (the journal is only for state changes)', () => {
    expect(
      reversalJournalEntrySchema.safeParse({ ...entry, intrusivenessClass: 'passive' }).success,
    ).toBe(false);
  });

  it('rejects a negative attempt count and a non-ISO timestamp', () => {
    expect(reversalJournalEntrySchema.safeParse({ ...entry, undoAttempts: -1 }).success).toBe(
      false,
    );
    expect(
      reversalJournalEntrySchema.safeParse({ ...entry, createdAt: '2026-10-30' }).success,
    ).toBe(false);
  });
});
