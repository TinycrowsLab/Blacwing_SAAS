// Audit event contract and action catalogue (AUDIT-001, CONTEXT_PACK §8.7, §8.8).

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  AUDIT_ACTION_CATALOGUE,
  AUDIT_ACTION_CLASSES,
  AUDIT_ACTIONS,
  AUDIT_METADATA_MAX_BYTES,
  auditActionEntry,
  auditActionSchema,
  AuditEventSchema,
  auditEventHashInput,
  auditSeveritySchema,
  canonicalJson,
  measureAuditMetadata,
} from '../index.js';
import {
  minimalEvent,
  TENANT_ID,
  validEvent,
  validEventArbitrary,
} from './fixtures.test-helpers.js';

/**
 * Every action released so far, in order. The catalogue is additive-only: this list may only grow at
 * the end. Never edit or remove an existing line; append new actions here when they are added.
 */
const RELEASED_ACTIONS = [
  'auth.login',
  'auth.logout',
  'auth.sso_link',
  'auth.api_token_issued',
  'auth.api_token_revoked',
  'authz.denied',
  'authz.role_changed',
  'asset.created',
  'asset.verified',
  'sa.requested',
  'sa.approved',
  'sa.rejected',
  'sa.revoked',
  'gate1.decided',
  'gate2.decided',
  'gate3.released',
  'run.created',
  'run.state_changed',
  'tool.invoked',
  'egress.blocked',
  'kill.fired',
  'kill.completed',
  'finding.released',
  'finding.risk_accepted',
  'export.generated',
  'secret.resolved',
  'config.changed',
  'connector.configured',
  'kill.triggered',
  'kill.forbidden',
  'kill.egress_blocked',
  'kill.sandboxes_terminated',
  'secret.kek_provisioned',
  'secret.kek_rotated',
  'secret.kek_disabled',
  'kill.keys_revoked',
  'kill.workflows_cancelled',
  'activity.started',
  'activity.succeeded',
  'activity.failed',
  'workflow.started',
  'workflow.completed',
  'workflow.failed',
  'workflow.cancelled',
  'workflow.continued_as_new',
  'soc_kill.link_minted',
  'soc_kill.triggered',
  'soc_kill.rejected',
  'outbox.delivery_failed',
] as const;

/** The §8.8 sentence, class by class, with the actions that must exist for it. */
const SECTION_8_8: Readonly<Record<(typeof AUDIT_ACTION_CLASSES)[number], readonly string[]>> = {
  login: ['auth.login'],
  approval: ['sa.approved', 'sa.rejected'],
  gate_decision: ['gate1.decided', 'gate2.decided', 'gate3.released'],
  tool_action: ['tool.invoked', 'egress.blocked'],
  finding_release: ['finding.released'],
  export: ['export.generated'],
  kill: ['kill.fired', 'kill.triggered', 'kill.forbidden'],
  config_change: ['config.changed', 'connector.configured'],
};

const issuesOf = (value: unknown): string[] => {
  const result = AuditEventSchema.safeParse(value);
  return result.success ? [] : result.error.issues.map((issue) => issue.path.join('.'));
};

describe('AuditEventSchema', () => {
  it('accepts a valid event with every field, and a minimal one', () => {
    expect(AuditEventSchema.parse(validEvent())).toEqual(validEvent());
    expect(AuditEventSchema.parse(minimalEvent())).toEqual(minimalEvent());
  });

  it('accepts arbitrary well-formed events', () => {
    fc.assert(
      fc.property(validEventArbitrary, (event) => {
        expect(AuditEventSchema.safeParse(event).success).toBe(true);
      }),
    );
  });

  it('rejects unknown and forward actions at the boundary', () => {
    for (const action of ['auth.impersonate', 'AUTH.LOGIN', 'auth.login ', '', 'gate4.decided']) {
      expect(issuesOf({ ...validEvent(), action })).toContain('action');
    }
  });

  it('fails closed on a missing or malformed tenantId', () => {
    const withoutTenant = validEvent();
    Reflect.deleteProperty(withoutTenant, 'tenantId');
    expect(issuesOf(withoutTenant)).toContain('tenantId');
    expect(issuesOf({ ...validEvent(), tenantId: '' })).toContain('tenantId');
    expect(
      issuesOf({ ...validEvent(), tenantId: '01900000-0000-7000-8000-00000000000A' }),
    ).toContain('tenantId');
    expect(issuesOf({ ...validEvent(), tenantId: null })).toContain('tenantId');
  });

  it('requires every non-optional field', () => {
    for (const field of [
      'id',
      'occurredAt',
      'action',
      'severity',
      'actor',
      'target',
      'outcome',
      'metadata',
      'prevHash',
      'hash',
      'seq',
    ]) {
      const event = validEvent();
      Reflect.deleteProperty(event, field);
      expect(issuesOf(event)).toContain(field);
    }
  });

  it('rejects unknown keys, non-UTC timestamps, bad hashes and bad sequence numbers', () => {
    expect(issuesOf({ ...validEvent(), extra: 1 })).toEqual(['']);
    expect(issuesOf({ ...validEvent(), occurredAt: '2026-01-01T01:00:00.000+01:00' })).toContain(
      'occurredAt',
    );
    expect(issuesOf({ ...validEvent(), hash: 'A'.repeat(64) })).toContain('hash');
    expect(issuesOf({ ...validEvent(), prevHash: 'a'.repeat(63) })).toContain('prevHash');
    for (const seq of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '1']) {
      expect(issuesOf({ ...validEvent(), seq })).toContain('seq');
    }
    expect(issuesOf({ ...validEvent(), traceId: '0'.repeat(32) })).toContain('traceId');
    expect(issuesOf({ ...validEvent(), ip: '999.0.0.1' })).toContain('ip');
    expect(issuesOf({ ...validEvent(), ip: '2001:db8::1' })).toEqual([]);
    expect(issuesOf({ ...validEvent(), outcome: 'partial' })).toContain('outcome');
  });

  it('types actors: identity per actor type, anonymous carries none', () => {
    const withActor = (actor: unknown): string[] => issuesOf({ ...validEvent(), actor });
    expect(withActor({ type: 'operator', id: 'op-1', email: 'soc@example.test' })).toEqual([]);
    expect(withActor({ type: 'service', id: 'egress-gateway', tokenId: 'tok-1' })).toEqual([]);
    expect(withActor({ type: 'system', id: 'scheduler' })).toEqual([]);
    expect(withActor({ type: 'anonymous' })).toEqual([]);
    expect(withActor({ type: 'user' })).toContain('actor.id');
    expect(withActor({ type: 'service', id: 'svc', email: 'svc@example.test' })).toContain('actor');
    expect(withActor({ type: 'anonymous', id: 'someone' })).toContain('actor');
    expect(withActor({ type: 'user', id: 'has space' })).toContain('actor.id');
    expect(withActor({ type: 'robot', id: 'r' })).toContain('actor.type');
  });

  it('types targets', () => {
    const withTarget = (target: unknown): string[] => issuesOf({ ...validEvent(), target });
    expect(withTarget({ type: 'finding', id: 'f-1' })).toEqual([]);
    expect(withTarget({ type: 'galaxy', id: 'g' })).toContain('target.type');
    expect(withTarget({ type: 'run' })).toContain('target.id');
    expect(withTarget({ type: 'run', id: 'r', publicId: 'RUN_1' })).toContain('target.publicId');
  });

  it('never lets a producer lower the catalogue severity', () => {
    expect(issuesOf({ ...minimalEvent(), severity: 'warning' })).toContain('severity');
    expect(issuesOf({ ...validEvent(), severity: 'info' })).toContain('severity');
    expect(issuesOf({ ...validEvent(), severity: 'critical' })).toEqual([]);
  });

  describe('Unicode', () => {
    it('NFC-normalises strings in every field and metadata key, so NFD and NFC hash alike', () => {
      const nfd = 'René';
      const nfc = 'René';
      const decomposed = {
        ...validEvent(),
        reason: nfd,
        metadata: { [nfd]: [nfd, { note: nfd }] },
      };
      const composed = {
        ...validEvent(),
        reason: nfc,
        metadata: { [nfc]: [nfc, { note: nfc }] },
      };
      const parsed = AuditEventSchema.parse(decomposed);
      expect(parsed.reason).toBe(nfc);
      expect(parsed.metadata).toEqual({ [nfc]: [nfc, { note: nfc }] });
      expect(auditEventHashInput(parsed)).toBe(
        auditEventHashInput(AuditEventSchema.parse(composed)),
      );
    });

    it('rejects metadata keys that collide after normalisation', () => {
      const event = { ...validEvent(), metadata: { René: 1, René: 2 } };
      // The issue is reported on the second key, the one that collided.
      expect(issuesOf(event)).toEqual([`metadata.${'Ren\u00e9'.normalize('NFC')}`]);
    });

    it('rejects lone surrogates, which no other language can hash identically', () => {
      expect(issuesOf({ ...validEvent(), metadata: { note: 'x\uD800y' } })).toEqual(['']);
      expect(issuesOf({ ...validEvent(), reason: '\uDC00' })).toEqual(['']);
    });

    it('accepts astral characters', () => {
      const parsed = AuditEventSchema.parse({
        ...validEvent(),
        metadata: { emoji: '\ud83d\ude00' },
      });
      expect(parsed.metadata).toEqual({ emoji: '\ud83d\ude00' });
    });

    it('rejects a __proto__ metadata key, which JavaScript would silently drop from the hash', () => {
      const metadata = JSON.parse('{"nested":{"__proto__":{"polluted":true}}}') as unknown;
      expect(issuesOf({ ...validEvent(), metadata })).toContain('metadata.nested.__proto__');
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });
  });

  describe('metadata size cap', () => {
    const metadataOfSize = (bytes: number): Record<string, string> => {
      // {"k":"..."} is 8 bytes of framing around the value.
      const value = 'x'.repeat(bytes - 8);
      const metadata = { k: value };
      expect(measureAuditMetadata(metadata).sizeBytes).toBe(bytes);
      return metadata;
    };

    it('accepts exactly 16KB of canonical metadata and rejects one byte more', () => {
      expect(
        issuesOf({ ...validEvent(), metadata: metadataOfSize(AUDIT_METADATA_MAX_BYTES) }),
      ).toEqual([]);
      expect(
        issuesOf({ ...validEvent(), metadata: metadataOfSize(AUDIT_METADATA_MAX_BYTES + 1) }),
      ).toEqual(['metadata']);
    });

    it('measures UTF-8 bytes, not UTF-16 units', () => {
      const metadata = { k: 'é'.repeat(AUDIT_METADATA_MAX_BYTES / 2) };
      expect(measureAuditMetadata(metadata)).toEqual({
        sizeBytes: AUDIT_METADATA_MAX_BYTES + 8,
        fitsInline: false,
      });
      expect(issuesOf({ ...validEvent(), metadata })).toEqual(['metadata']);
    });

    it('stores overflow by reference to the evidence store', () => {
      const metadataRef = {
        evidenceKey: `tenants/${TENANT_ID}/audit/metadata/0190.json`,
        sha256: 'b'.repeat(64),
        sizeBytes: 90_000,
      };
      expect(issuesOf({ ...validEvent(), metadata: { truncated: true }, metadataRef })).toEqual([]);
      expect(
        issuesOf({ ...validEvent(), metadataRef: { ...metadataRef, sizeBytes: 100 } }),
      ).toContain('metadataRef.sizeBytes');
      expect(
        issuesOf({ ...validEvent(), metadataRef: { ...metadataRef, evidenceKey: 'a b' } }),
      ).toContain('metadataRef.evidenceKey');
    });

    it('rejects non-JSON metadata values', () => {
      for (const value of [Number.NaN, Number.POSITIVE_INFINITY, undefined, new Date(0), 1n]) {
        expect(issuesOf({ ...validEvent(), metadata: { value } })).not.toEqual([]);
      }
    });
  });

  it('orders by seq and the chain, not wall time: an earlier occurredAt is still valid', () => {
    const first = AuditEventSchema.parse({
      ...minimalEvent(),
      seq: 1,
      occurredAt: '2026-01-02T00:00:00.000Z',
    });
    const second = AuditEventSchema.parse({
      ...minimalEvent(),
      seq: 2,
      occurredAt: '2026-01-01T00:00:00.000Z',
    });
    expect(second.seq).toBeGreaterThan(first.seq);
    expect(second.occurredAt < first.occurredAt).toBe(true);
    // seq is part of the hashed subset, so reordering by seq is tamper-evident.
    expect(auditEventHashInput(first)).toContain('"seq":1');
  });

  it('hashes every field but hash, with absent optionals omitted', () => {
    const event = AuditEventSchema.parse(minimalEvent());
    const input = auditEventHashInput(event);
    expect(input).not.toContain('"hash"');
    expect(input).toContain('"prevHash"');
    expect(input).not.toContain('reason');
    expect(JSON.parse(input)).toEqual(
      Object.fromEntries(Object.entries(event).filter(([key]) => key !== 'hash')),
    );
    expect(input).toBe(canonicalJson(JSON.parse(input)));
  });
});

describe('action catalogue', () => {
  it('has unique, well-formed names with metadata for every entry', () => {
    expect(new Set(AUDIT_ACTIONS).size).toBe(AUDIT_ACTIONS.length);
    for (const entry of AUDIT_ACTION_CATALOGUE) {
      expect(entry.action).toMatch(
        /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*\.[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/,
      );
      expect(auditSeveritySchema.safeParse(entry.defaultSeverity).success).toBe(true);
      expect(typeof entry.isAlwaysAudited).toBe('boolean');
      expect(entry.description.length).toBeGreaterThan(0);
    }
  });

  it('gives every AuditAction enum value catalogue metadata (lint)', () => {
    for (const action of auditActionSchema.options) {
      expect(auditActionEntry(action).action).toBe(action);
    }
    expect([...auditActionSchema.options]).toEqual([...AUDIT_ACTIONS]);
  });

  it('covers every §8.8 action class, and those actions are always audited', () => {
    for (const actionClass of AUDIT_ACTION_CLASSES) {
      const inClass = AUDIT_ACTION_CATALOGUE.filter(
        (entry) => 'actionClass' in entry && entry.actionClass === actionClass,
      );
      expect(inClass.length, actionClass).toBeGreaterThan(0);
      for (const entry of inClass) {
        expect(entry.isAlwaysAudited, entry.action).toBe(true);
      }
      for (const required of SECTION_8_8[actionClass]) {
        const entry = auditActionEntry(auditActionSchema.parse(required));
        expect('actionClass' in entry ? entry.actionClass : undefined, required).toBe(actionClass);
      }
    }
  });

  it('includes every action named by the AUDIT-001 issue', () => {
    for (const action of [
      'auth.login',
      'auth.sso_link',
      'authz.denied',
      'sa.approved',
      'gate1.decided',
      'gate2.decided',
      'gate3.released',
      'run.state_changed',
      'tool.invoked',
      'egress.blocked',
      'kill.fired',
      'finding.released',
      'export.generated',
      'secret.resolved',
      'config.changed',
      'connector.configured',
    ]) {
      expect(AUDIT_ACTIONS).toContain(action);
    }
  });

  it('is additive-only: released actions keep their name and position', () => {
    expect(AUDIT_ACTIONS.slice(0, RELEASED_ACTIONS.length)).toEqual([...RELEASED_ACTIONS]);
    expect(AUDIT_ACTIONS.length, 'append new actions to RELEASED_ACTIONS too').toBe(
      RELEASED_ACTIONS.length,
    );
  });

  it('throws for a name outside the catalogue', () => {
    expect(() => auditActionEntry('auth.unknown' as never)).toThrow(/unknown audit action/);
  });
});
