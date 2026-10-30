import { describe, expect, it } from 'vitest';

import { toSiemRecord } from './normalise.js';
import { makeEvent, TENANT } from './test-support.js';

import type { AuditEvent } from '@blackwing/contracts';

describe('toSiemRecord', () => {
  it('maps the ECS-indexed fields from the canonical event', () => {
    const event = makeEvent(7, 'gate2.decided');
    const record = toSiemRecord(event);
    expect(record['@timestamp']).toBe('2026-01-01T00:00:00.000Z');
    expect(record.event).toEqual({
      id: event.id,
      action: 'gate2.decided',
      outcome: 'success',
      kind: 'event',
      category: ['audit'],
    });
    expect(record.organization).toEqual({ id: TENANT });
    expect(record.user).toEqual({
      id: 'usr_01j0000000000000000000000a',
      email: 'approver@example.test',
    });
    expect(record.blackwing).toMatchObject({
      seq: 7,
      hash: event.hash,
      prev_hash: event.prevHash,
      severity: 'notice',
      actor: { type: 'user' },
      target: { type: 'run', id: '01900000-0000-7000-8000-0000000000b1' },
      metadata: { n: 7 },
    });
    expect(record.raw).toBe(event);
  });

  it('maps a denied outcome to ECS failure and keeps the exact outcome in raw', () => {
    const denied: AuditEvent = { ...makeEvent(1), outcome: 'denied' };
    const record = toSiemRecord(denied);
    expect(record.event.outcome).toBe('failure');
    expect(record.raw.outcome).toBe('denied');
  });

  it('omits the optional blocks when the event does not carry them', () => {
    const system = { ...makeEvent(2), actor: { type: 'system' as const } };
    const record = toSiemRecord(system);
    expect(record.user).toBeUndefined();
    expect(record.source).toBeUndefined();
    expect(record.trace).toBeUndefined();
    expect(record.user_agent).toBeUndefined();
    expect(record.blackwing.run_id).toBeUndefined();
  });

  it('never exposes a service actor e-mail and carries ip, user agent and trace when present', () => {
    const service = {
      ...makeEvent(3),
      actor: { type: 'service' as const, id: 'egress-gateway' },
      ip: '192.0.2.10',
      userAgent: 'Mozilla/5.0',
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
      runId: '01900000-0000-7000-8000-0000000000b1',
      reason: 'timed out',
    } as AuditEvent;
    const record = toSiemRecord(service);
    expect(record.user).toEqual({ id: 'egress-gateway' });
    expect(record.source).toEqual({ ip: '192.0.2.10' });
    expect(record.user_agent).toEqual({ original: 'Mozilla/5.0' });
    expect(record.trace).toEqual({ id: '4bf92f3577b34da6a3ce929d0e0e4736' });
    expect(record.blackwing.run_id).toBe('01900000-0000-7000-8000-0000000000b1');
    expect(record.event.reason).toBe('timed out');
  });

  it('is deterministic: the same event maps to the same record, so re-delivery is identical', () => {
    const event = makeEvent(9);
    expect(toSiemRecord(event)).toEqual(toSiemRecord(event));
  });
});
