import { describe, expect, it } from 'vitest';

import { createUuidV7Generator } from '@blackwing/ids';

import { InMemoryPdpFactsReader } from './memory.js';
import { createPdpService, decidePdp, type PdpEnvelope, type PdpFacts } from './pdp.js';

import type { BrokerPdpEvaluateRequest } from '@blackwing/contracts';

const gen = createUuidV7Generator();
const TENANT = gen();
const RUN = gen();
const NOW = new Date('2026-10-30T12:00:00.000Z');
const IN_SCOPE = 'https://lab.example.test/login';

const envelope = (overrides: Partial<PdpEnvelope> = {}): PdpEnvelope => ({
  validFrom: new Date('2026-10-30T00:00:00.000Z'),
  expiresAt: new Date('2026-10-31T00:00:00.000Z'),
  revoked: false,
  maxIntrusiveness: 'active_safe',
  ...overrides,
});

const facts = (overrides: Partial<PdpFacts> = {}): PdpFacts => ({
  envelope: envelope(),
  sessionCeiling: 'active_safe',
  testCaseClass: null,
  reversalJournalPresent: false,
  inScope: (target) => target === IN_SCOPE,
  ...overrides,
});

const request = (overrides: Partial<BrokerPdpEvaluateRequest> = {}): BrokerPdpEvaluateRequest => ({
  toolName: 'Bash',
  toolUseId: 'toolu_1',
  targets: [IN_SCOPE],
  subtaskId: null,
  testCaseId: null,
  roleId: null,
  ...overrides,
});

describe('decidePdp (RUNTIME-005)', () => {
  it('allows an in-envelope call whose targets are in scope', () => {
    expect(decidePdp(facts(), request(), NOW)).toEqual({
      decision: 'allow',
      reason: 'in_envelope',
    });
  });

  it('allows a call that names no target when its class is within the envelope', () => {
    expect(decidePdp(facts(), request({ targets: [] }), NOW)).toEqual({
      decision: 'allow',
      reason: 'in_envelope',
    });
  });

  it.each([
    ['another host', 'https://other.example.test/'],
    ['an IP outside scope', '10.0.0.9'],
  ])(
    'answers an out-of-scope target (%s) with an exception (Gate 2 may approve it)',
    (_name, target) => {
      expect(decidePdp(facts(), request({ targets: [IN_SCOPE, target] }), NOW)).toEqual({
        decision: 'exception',
        reason: 'out_of_scope',
        intrusiveness: 'active_safe',
      });
    },
  );

  it('answers a call above the envelope with an exception, not a hard deny', () => {
    const f = facts({ testCaseClass: 'state_changing', reversalJournalPresent: true });
    expect(decidePdp(f, request(), NOW)).toEqual({
      decision: 'exception',
      reason: 'intrusiveness_exceeds_envelope',
      intrusiveness: 'state_changing',
    });
  });

  it('keeps a destructive call a hard deny, never an exception (§8.3)', () => {
    const f = facts({ testCaseClass: 'destructive' });
    expect(decidePdp(f, request({ targets: [IN_SCOPE, '10.0.0.9'] }), NOW)).toEqual({
      decision: 'deny',
      reason: 'destructive_class',
    });
  });

  it('keeps a missing envelope a hard deny even for an out-of-scope target', () => {
    expect(decidePdp(facts({ envelope: null }), request({ targets: ['10.0.0.9'] }), NOW)).toEqual({
      decision: 'deny',
      reason: 'no_envelope',
    });
  });

  it('denies when the run has no envelope (no standing authorisation)', () => {
    expect(decidePdp(facts({ envelope: null }), request(), NOW)).toEqual({
      decision: 'deny',
      reason: 'no_envelope',
    });
  });

  it('denies a revoked envelope even inside its window', () => {
    expect(decidePdp(facts({ envelope: envelope({ revoked: true }) }), request(), NOW).reason).toBe(
      'envelope_revoked',
    );
  });

  it('denies before the window opens and at or after its end (half-open window)', () => {
    const early = facts({ envelope: envelope({ validFrom: new Date(NOW.getTime() + 1) }) });
    expect(decidePdp(early, request(), NOW).reason).toBe('envelope_not_yet_valid');
    const atEnd = facts({ envelope: envelope({ expiresAt: NOW }) });
    expect(decidePdp(atEnd, request(), NOW).reason).toBe('envelope_expired');
    const atStart = facts({ envelope: envelope({ validFrom: NOW }) });
    expect(decidePdp(atStart, request(), NOW).decision).toBe('allow');
  });

  it('denies every destructive call regardless of the envelope', () => {
    const f = facts({
      envelope: envelope({ maxIntrusiveness: 'destructive' }),
      sessionCeiling: 'destructive',
      testCaseClass: 'destructive',
    });
    expect(decidePdp(f, request(), NOW).reason).toBe('destructive_class');
  });

  it('denies a test case whose class is above the envelope maximum', () => {
    const f = facts({ testCaseClass: 'state_changing', reversalJournalPresent: true });
    expect(decidePdp(f, request(), NOW).reason).toBe('intrusiveness_exceeds_envelope');
  });

  it('denies a test case whose class is above the session ceiling', () => {
    const f = facts({
      envelope: envelope({ maxIntrusiveness: 'state_changing' }),
      sessionCeiling: 'passive',
      testCaseClass: 'active_safe',
    });
    expect(decidePdp(f, request(), NOW).reason).toBe('intrusiveness_exceeds_envelope');
  });

  it('denies a state_changing call without a reversal-journal entry (§8.3)', () => {
    const f = facts({
      envelope: envelope({ maxIntrusiveness: 'state_changing' }),
      sessionCeiling: 'state_changing',
      testCaseClass: 'state_changing',
      reversalJournalPresent: false,
    });
    expect(decidePdp(f, request(), NOW)).toEqual({
      decision: 'deny',
      reason: 'state_change_without_journal',
    });
  });

  it('allows a state_changing call once its journal entry exists', () => {
    const f = facts({
      envelope: envelope({ maxIntrusiveness: 'state_changing' }),
      sessionCeiling: 'state_changing',
      testCaseClass: 'state_changing',
      reversalJournalPresent: true,
    });
    expect(decidePdp(f, request(), NOW).decision).toBe('allow');
  });

  it('judges a call with no test case by the session ceiling', () => {
    const f = facts({
      envelope: envelope({ maxIntrusiveness: 'passive' }),
      sessionCeiling: 'state_changing',
    });
    expect(decidePdp(f, request(), NOW).reason).toBe('intrusiveness_exceeds_envelope');
  });
});

describe('createPdpService', () => {
  it('evaluates the facts loaded for the run and the instant of the call', async () => {
    const reader = new InMemoryPdpFactsReader();
    reader.set({ tenantId: TENANT, runId: RUN }, facts());
    const service = createPdpService({ facts: reader, now: () => NOW });
    await expect(service.evaluate({ tenantId: TENANT, runId: RUN }, request())).resolves.toEqual({
      decision: 'allow',
      reason: 'in_envelope',
    });
  });

  it('denies for a run of another tenant, as for an unknown run (no envelope)', async () => {
    const reader = new InMemoryPdpFactsReader();
    reader.set({ tenantId: TENANT, runId: RUN }, facts());
    const service = createPdpService({ facts: reader, now: () => NOW });
    await expect(service.evaluate({ tenantId: gen(), runId: RUN }, request())).resolves.toEqual({
      decision: 'deny',
      reason: 'no_envelope',
    });
  });

  it('lets a facts failure reject, so the caller fails closed', async () => {
    const service = createPdpService({
      facts: {
        load: () => Promise.reject(new Error('database unavailable')),
      },
      now: () => NOW,
    });
    await expect(service.evaluate({ tenantId: TENANT, runId: RUN }, request())).rejects.toThrow(
      'database unavailable',
    );
  });
});
