// Hand-written audit event fixtures shared by the audit contract tests. @blackwing/testing depends on
// this package, so its factories cannot be used here without a cycle.

import fc from 'fast-check';

import {
  AUDIT_ACTION_CATALOGUE,
  AUDIT_GENESIS_PREV_HASH,
  type AuditJsonValue,
  auditTargetTypeSchema,
} from '../index.js';

export const TENANT_ID = '01900000-0000-7000-8000-000000000001';
const EVENT_ID = '01900000-0000-7000-8000-0000000000a1';
const RUN_ID = '01900000-0000-7000-8000-0000000000b1';
const SHA256_HEX = 64;
const SMALL = 4;
const KEY_MAX = 8;
const HEX_DIGITS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'a', 'b', 'c', 'd', 'e', 'f'];
const ID_CHARS = [...HEX_DIGITS, 'g', 'h', 'k', 'm', 'x', 'y', 'z', '-', '_', '.', ':', '@', '/'];

const HASH_A = 'a'.repeat(SHA256_HEX);

/** A valid `gate2.decided` event with every optional field set. */
export function validEvent(): Record<string, unknown> {
  return {
    id: EVENT_ID,
    tenantId: TENANT_ID,
    occurredAt: '2026-01-01T00:00:00.000Z',
    action: 'gate2.decided',
    severity: 'notice',
    actor: {
      type: 'user',
      id: '01900000-0000-7000-8000-000000000002',
      email: 'approver@example.test',
    },
    target: {
      type: 'run',
      id: RUN_ID,
      publicId: 'run_01j0000000000000000000000a',
    },
    outcome: 'denied',
    reason: 'Gate 2 timed out; denied by default',
    metadata: { decision: 'deny', timeoutSeconds: 300, escalation: { tool: 'nuclei' } },
    traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
    runId: RUN_ID,
    ip: '192.0.2.10',
    userAgent: 'Mozilla/5.0',
    prevHash: AUDIT_GENESIS_PREV_HASH,
    hash: HASH_A,
    seq: 1,
  };
}

/** A valid event with only the required fields. */
export function minimalEvent(): Record<string, unknown> {
  return {
    id: EVENT_ID,
    tenantId: TENANT_ID,
    occurredAt: '2026-01-01T00:00:00.000Z',
    action: 'kill.fired',
    severity: 'critical',
    actor: { type: 'system' },
    target: { type: 'tenant', id: TENANT_ID },
    outcome: 'success',
    metadata: {},
    prevHash: HASH_A,
    hash: HASH_A,
    seq: 2,
  };
}

const hex64 = fc.stringMatching(/^[0-9a-f]{64}$/);

const uuidV7 = fc.stringMatching(
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
);

const identifier = fc.string({
  unit: fc.constantFrom(...ID_CHARS),
  minLength: 1,
  maxLength: 40,
});

/** Small JSON metadata values (ASCII keys and strings so they stay well within the size cap). */
const jsonValue: fc.Arbitrary<AuditJsonValue> = fc.letrec<{ value: AuditJsonValue }>((tie) => ({
  value: fc.oneof(
    { depthSize: 'small', withCrossShrink: true },
    fc.string({ maxLength: KEY_MAX }),
    fc.integer(),
    fc.double({ noNaN: true, noDefaultInfinity: true }),
    fc.boolean(),
    fc.constant(null),
    fc.array(tie('value'), { maxLength: SMALL }),
    fc.dictionary(fc.string({ maxLength: KEY_MAX }), tie('value'), { maxKeys: SMALL }),
  ),
})).value;

/** Arbitrary structurally valid events (severity always `critical`, so the floor holds). */
export const validEventArbitrary: fc.Arbitrary<Record<string, unknown>> = fc
  .record({
    id: uuidV7,
    tenantId: uuidV7,
    action: fc.constantFrom(...AUDIT_ACTION_CATALOGUE.map((entry) => entry.action)),
    actor: fc.oneof(
      fc.record({ type: fc.constant('user'), id: identifier }),
      fc.record({ type: fc.constant('service'), id: identifier, tokenId: identifier }),
      fc.record({ type: fc.constant('anonymous') }),
    ),
    targetType: fc.constantFrom(...auditTargetTypeSchema.options),
    targetId: identifier,
    outcome: fc.constantFrom('success', 'failure', 'denied'),
    metadata: fc.dictionary(fc.string({ maxLength: KEY_MAX }), jsonValue, { maxKeys: SMALL }),
    prevHash: hex64,
    hash: hex64,
    seq: fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER }),
  })
  .map(({ targetType, targetId, ...rest }) => ({
    ...rest,
    occurredAt: '2026-03-04T05:06:07.089Z',
    severity: 'critical',
    target: { type: targetType, id: targetId },
  }));
