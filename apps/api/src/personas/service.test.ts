import { describe, expect, it } from 'vitest';

import {
  parsePersonaDefinition,
  PERSONA_OVERRIDE_FIELDS,
  PersonaError,
  type PersonaDefinition,
} from '@blackwing/agents';
import { AppError, ForbiddenError } from '@blackwing/errors';

import { principal, rolesWithout, TENANT_A, TENANT_B } from './fixtures.test-helpers.js';
import { createInMemoryPersonaOverrideStore, RecordingPersonaAudit } from './memory.js';
import { createPersonaOverrideMetrics } from './metrics.js';
import { PERSONA_OVERRIDE_CHANGED_ACTION, PersonaOverrideService } from './service.js';

import type { PersonaPrincipal } from './ports.js';

function osint(): PersonaDefinition {
  return parsePersonaDefinition({
    name: 'osint',
    mandate: 'Gather public information about approved assets.',
    tierAlias: 'standard',
    effort: 'medium',
    maxTurns: 30,
    maxBudgetUsdDefault: 2,
    allowedTools: ['Read'],
    disallowedTools: ['WebFetch', 'WebSearch'],
    declaredOracleTypes: [],
    inputs: ['scope'],
    intrusivenessCeiling: 'passive',
    requiresSubmission: false,
    promptRef: { persona: 'osint', version: '1.0.0' },
    guardrails: { scopeEnforced: true, treatToolOutputAsUntrusted: true },
  });
}

function harness(over: { failAudit?: boolean } = {}) {
  const store = createInMemoryPersonaOverrideStore();
  const audit = new RecordingPersonaAudit();
  const metrics = createPersonaOverrideMetrics();
  const logs: { fields: object; message: string }[] = [];
  const service = new PersonaOverrideService({
    store,
    writeAudit: async (tx, event) => {
      if (over.failAudit === true) throw new Error('ledger unavailable');
      await audit.write(tx, event);
    },
    metrics,
    logger: { warn: (fields, message) => logs.push({ fields, message }) },
  });
  return { store, audit, metrics, service, logs };
}

const admin = (over: Partial<PersonaPrincipal> = {}) => principal(['org_admin'], over);

describe('persona override service: writes', () => {
  it('stores a whitelisted override and audits the change in the same transaction', async () => {
    const h = harness();
    const view = await h.service.put(admin(), 'osint', { effort: 'low', maxTurns: 10 });

    expect(view.persona).toBe('osint');
    expect(view.override).toEqual({ effort: 'low', maxTurns: 10 });
    expect(view.updatedAt).toBeTypeOf('string');
    expect(h.audit.events).toHaveLength(1);
    const [event] = h.audit.events;
    expect(event).toMatchObject({
      tenantId: TENANT_A,
      action: PERSONA_OVERRIDE_CHANGED_ACTION,
      outcome: 'success',
      target: { type: 'config', id: 'persona:osint' },
      metadata: {
        persona: 'osint',
        fields: ['effort', 'maxTurns'],
        values: { effort: 'low', maxTurns: 10 },
      },
    });
    expect(event?.actor.type).toBe('user');
  });

  it('records a service caller as a service actor', async () => {
    const h = harness();
    await h.service.put(principal(['org_admin'], { type: 'service' }), 'osint', { maxTurns: 5 });
    expect(h.audit.events[0]?.actor.type).toBe('service');
  });

  it('replaces the whole override on each write', async () => {
    const h = harness();
    await h.service.put(admin(), 'osint', { effort: 'low', maxTurns: 10 });
    const view = await h.service.put(admin(), 'osint', { maxBudgetUsd: 1 });
    expect(view.override).toEqual({ maxBudgetUsd: 1 });
    expect((await h.service.get(admin(), 'osint')).override).toEqual({ maxBudgetUsd: 1 });
  });

  it('resets a persona to its base values with an empty body', async () => {
    const h = harness();
    await h.service.put(admin(), 'osint', { effort: 'low' });
    const view = await h.service.put(admin(), 'osint', {});
    expect(view.override).toEqual({});
    expect(h.audit.events.at(-1)?.metadata).toEqual({ persona: 'osint', fields: [], values: {} });
  });

  it('refuses a field outside the whitelist and writes nothing', async () => {
    const h = harness();
    for (const field of ['allowedTools', 'disallowedTools', 'intrusivenessCeiling', 'tierAlias']) {
      const err = await h.service
        .put(admin(), 'osint', { effort: 'low', [field]: ['x'] })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code, field).toBe('OVERRIDE_FIELD_FORBIDDEN');
    }
    expect(h.store.committed()).toHaveLength(0);
    expect(h.audit.events).toHaveLength(0);
  });

  it('refuses an invalid value with VALIDATION_FAILED and writes nothing', async () => {
    const h = harness();
    await expect(h.service.put(admin(), 'osint', { maxTurns: 0 })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    expect(h.store.committed()).toHaveLength(0);
  });

  it('refuses a persona outside the roster before reading the body (PERSONA_UNKNOWN)', async () => {
    const h = harness();
    const err = await h.service
      .put(admin(), 'planet-killer', { effort: 'low' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PersonaError);
    expect((err as PersonaError).code).toBe('PERSONA_UNKNOWN');
    expect(h.audit.events).toHaveLength(0);
  });

  it('rolls the change back when the audit write fails (no change without its record)', async () => {
    const h = harness({ failAudit: true });
    await expect(h.service.put(admin(), 'osint', { effort: 'low' })).rejects.toThrow(
      'ledger unavailable',
    );
    expect(await h.store.find(TENANT_A, 'osint')).toBeNull();
    expect(h.store.committed()).toHaveLength(0);
  });

  it('is admin-only: every other tenant role is refused with FORBIDDEN and writes nothing', async () => {
    const h = harness();
    const denied = rolesWithout('settings:write');
    expect(denied.length).toBeGreaterThan(0);
    for (const role of denied) {
      const err = await h.service
        .put(principal([role]), 'osint', { effort: 'low' })
        .catch((e: unknown) => e);
      expect(err, role).toBeInstanceOf(ForbiddenError);
      expect((err as AppError).code, role).toBe('FORBIDDEN');
    }
    expect(h.store.committed()).toHaveLength(0);
    expect(h.audit.events).toHaveLength(0);
  });

  it('refuses a caller with no tenant context (TENANT_CONTEXT_MISSING)', async () => {
    const h = harness();
    await expect(
      h.service.put(admin({ tenantId: null }), 'osint', { effort: 'low' }),
    ).rejects.toMatchObject({ code: 'TENANT_CONTEXT_MISSING' });
    await expect(h.service.get(admin({ tenantId: null }), 'osint')).rejects.toMatchObject({
      code: 'TENANT_CONTEXT_MISSING',
    });
  });

  it('checks RBAC before it reads the body, so a non-admin learns nothing about validity', async () => {
    const h = harness();
    await expect(
      h.service.put(principal(['developer']), 'osint', { allowedTools: ['Bash'] }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('persona override service: reads and isolation', () => {
  it('answers null when no override is set', async () => {
    const h = harness();
    expect(await h.service.get(admin(), 'osint')).toEqual({
      persona: 'osint',
      override: null,
      updatedAt: null,
    });
  });

  it('lets an auditor read an override only where the matrix grants settings:read', async () => {
    const h = harness();
    await h.service.put(admin(), 'osint', { effort: 'low' });
    for (const role of rolesWithout('settings:read')) {
      await expect(h.service.get(principal([role]), 'osint'), role).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
    }
  });

  it('never shows tenant A an override that tenant B set (cross-tenant)', async () => {
    const h = harness();
    await h.service.put(admin({ tenantId: TENANT_B }), 'osint', { maxTurns: 3 });

    expect(await h.service.get(admin({ tenantId: TENANT_A }), 'osint')).toEqual({
      persona: 'osint',
      override: null,
      updatedAt: null,
    });
    await h.service.put(admin({ tenantId: TENANT_A }), 'osint', { maxTurns: 9 });
    expect((await h.service.get(admin({ tenantId: TENANT_B }), 'osint')).override).toEqual({
      maxTurns: 3,
    });
  });

  it('refuses an unknown persona on read too', async () => {
    const h = harness();
    await expect(h.service.get(admin(), 'nope')).rejects.toMatchObject({ code: 'PERSONA_UNKNOWN' });
  });
});

describe('persona override service: resolution at run start', () => {
  it('returns the base values with no metric and no override', async () => {
    const h = harness();
    const effective = await h.service.resolveEffective(TENANT_A, osint());
    expect(effective).toMatchObject({
      effort: 'medium',
      maxTurns: 30,
      maxBudgetUsd: 2,
      overridden: [],
    });
    const text = await h.metrics.registry.metrics();
    expect(text).not.toContain('persona_override_applied_total{');
  });

  it('merges the tenant override and counts each applied field', async () => {
    const h = harness();
    await h.service.put(admin(), 'osint', { effort: 'high', maxTurns: 12 });
    const effective = await h.service.resolveEffective(TENANT_A, osint());
    expect(effective).toMatchObject({ effort: 'high', maxTurns: 12, maxBudgetUsd: 2 });
    const text = await h.metrics.registry.metrics();
    expect(text).toContain('persona_override_applied_total{persona="osint",field="effort"} 1');
    expect(text).toContain('persona_override_applied_total{persona="osint",field="maxTurns"} 1');
  });

  it('clamps an out-of-bound value, warns, and never exceeds the persona ceiling', async () => {
    const h = harness();
    await h.service.put(admin(), 'osint', { maxTurns: 500, maxBudgetUsd: 50 });
    const effective = await h.service.resolveEffective(TENANT_A, osint());
    expect(effective.maxTurns).toBe(30);
    expect(effective.maxBudgetUsd).toBe(2);
    expect(effective.clamped.map((c) => c.field).toSorted()).toEqual(['maxBudgetUsd', 'maxTurns']);
    expect(h.logs.map((l) => l.message)).toEqual([
      'persona override clamped to the persona bound',
      'persona override clamped to the persona bound',
    ]);
  });

  it('isolates resolution per tenant', async () => {
    const h = harness();
    await h.service.put(admin({ tenantId: TENANT_B }), 'osint', { effort: 'max' });
    const effective = await h.service.resolveEffective(TENANT_A, osint());
    expect(effective.effort).toBe('medium');
  });

  it('ignores a stored override left behind by a persona retired from the roster', async () => {
    const h = harness();
    await h.store.replace(
      TENANT_A,
      'retired-persona',
      { effort: 'max', maxTurns: 500, maxBudgetUsd: null, lowerStandardTier: null },
      () => Promise.resolve(),
    );
    const effective = await h.service.resolveEffective(TENANT_A, osint());
    expect(effective).toMatchObject({ effort: 'medium', maxTurns: 30, overridden: [] });
  });

  it('exposes the whitelist the service enforces', () => {
    expect([...PERSONA_OVERRIDE_FIELDS]).toEqual([
      'effort',
      'maxTurns',
      'maxBudgetUsd',
      'lowerStandardTier',
    ]);
  });
});
