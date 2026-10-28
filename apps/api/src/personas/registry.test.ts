import { describe, expect, it } from 'vitest';

import { loadPersona, PERSONA_NAMES, type ModelProvider } from '@blackwing/agents';
import { ROLES } from '@blackwing/contracts';
import { AppError, ForbiddenError } from '@blackwing/errors';

import { principal, TENANT_B } from './fixtures.test-helpers.js';
import { createInMemoryPersonaOverrideStore, RecordingPersonaAudit } from './memory.js';
import { createPersonaOverrideMetrics, createPersonaRegistryMetrics } from './metrics.js';
import { PersonaRegistryService, type PersonaRegistryView } from './registry.js';
import { PersonaOverrideService } from './service.js';

import type { PersonaPrincipal } from './ports.js';

/** The exact keys a registry view may carry. Anything else is an internal field and must stay unpublished. */
const VIEW_KEYS = [
  'allowedTools',
  'declaredOracleTypes',
  'disallowedTools',
  'effective',
  'helpers',
  'inputs',
  'intrusivenessCeiling',
  'mandate',
  'name',
  'overridden',
  'promptVersion',
  'requiresSubmission',
  'tierAlias',
].sort();

function harness(provider: ModelProvider = 'anthropic') {
  const overrideMetrics = createPersonaOverrideMetrics();
  const overrides = new PersonaOverrideService({
    store: createInMemoryPersonaOverrideStore(),
    writeAudit: (tx, event) => new RecordingPersonaAudit().write(tx, event),
    metrics: overrideMetrics,
  });
  const registryMetrics = createPersonaRegistryMetrics();
  const registry = new PersonaRegistryService({ overrides, provider, metrics: registryMetrics });
  return { overrides, overrideMetrics, registry, registryMetrics };
}

const reader = (over: Partial<PersonaPrincipal> = {}) => principal(['auditor'], over);
const admin = (over: Partial<PersonaPrincipal> = {}) => principal(['org_admin'], over);

/** The value of one labelled sample of a counter, or 0 when that label has never been incremented. */
async function countOf(
  counter: { get(): Promise<{ values: readonly { value: number; labels: object }[] }> },
  operation: string,
): Promise<number> {
  const { values } = await counter.get();
  return (
    values.find((v) => (v.labels as { operation?: string }).operation === operation)?.value ?? 0
  );
}

describe('persona registry: list and get (REGISTRY-011)', () => {
  it('lists all 19 personas in roster order, each with the resolved settings and no internal fields', async () => {
    const { registry } = harness();
    const { items } = await registry.list(reader());
    expect(items.map((i) => i.name)).toEqual([...PERSONA_NAMES]);
    expect(items).toHaveLength(19);
    for (const item of items) {
      expect(Object.keys(item).sort(), item.name).toEqual(VIEW_KEYS);
      expect(item.effective.model, item.name).toMatch(/^claude-/);
      expect(item.overridden, item.name).toEqual([]);
    }
  });

  it('resolves the tier to the model and the base effort and budgets for a tenant without an override', async () => {
    const { registry } = harness();
    const planner = await registry.get(reader(), 'planner');
    expect(planner).toMatchObject({
      name: 'planner',
      promptVersion: '1.0.0',
      tierAlias: 'deep',
      effective: { model: 'claude-opus-5-5', effort: 'high', maxTurns: 40, maxBudgetUsd: 5 },
      intrusivenessCeiling: 'state_changing',
      requiresSubmission: false,
    });
    expect(planner.declaredOracleTypes.length).toBeGreaterThan(0);
    expect(planner.allowedTools).toContain('mcp__blackwing_surface__surface_query');
    expect(planner.disallowedTools).toEqual(
      expect.arrayContaining(['Bash', 'WebFetch', 'WebSearch']),
    );
  });

  it('lists the helpers of a persona that spawns them, and none for one that does not', async () => {
    const { registry } = harness();
    const { items } = await registry.list(reader());
    const withHelpers = items.filter((i) => i.helpers.length > 0);
    expect(withHelpers.map((i) => i.name)).toContain('web-api-specialist');
    for (const helper of withHelpers.flatMap((i) => i.helpers)) {
      expect(Object.keys(helper).sort()).toEqual([
        'allowedTools',
        'description',
        'name',
        'tierAlias',
      ]);
    }
    expect((await registry.get(reader(), 'planner')).helpers).toEqual([]);
  });

  it('reflects the caller tenant override in the effective config, and never another tenant’s', async () => {
    const { overrides, registry } = harness();
    await overrides.put(admin(), 'sub-planner', {
      maxTurns: 5,
      effort: 'low',
      lowerStandardTier: true,
    });

    const base = loadPersona('sub-planner');
    const mine = await registry.get(reader(), 'sub-planner');
    expect(mine.effective).toEqual({
      model: 'claude-sonnet-5-5',
      effort: 'low',
      maxTurns: 5,
      maxBudgetUsd: base.maxBudgetUsdDefault,
    });
    expect(mine.overridden).toEqual(['effort', 'maxTurns', 'lowerStandardTier']);

    const other = await registry.get(reader({ tenantId: TENANT_B }), 'sub-planner');
    expect(other.effective).toEqual({
      model: 'claude-opus-5-5',
      effort: base.effort,
      maxTurns: base.maxTurns,
      maxBudgetUsd: base.maxBudgetUsdDefault,
    });
    expect(other.overridden).toEqual([]);
  });

  it('shows the clamped value, never a value above the persona bound', async () => {
    const { overrides, registry } = harness();
    await overrides.put(admin(), 'planner', { maxTurns: 9999, maxBudgetUsd: 9000 });
    const planner = await registry.get(reader(), 'planner');
    expect(planner.effective).toMatchObject({ maxTurns: 40, maxBudgetUsd: 5 });
  });

  it('does not move the run-start metrics or write clamp warnings on a read', async () => {
    const { overrides, overrideMetrics, registry } = harness();
    await overrides.put(admin(), 'planner', { maxTurns: 9999 });
    await registry.list(reader());
    expect((await overrideMetrics.applied.get()).values).toEqual([]);
  });

  it('resolves model IDs for the tenant provider, with the Bedrock prefix', async () => {
    const { registry } = harness('bedrock');
    expect((await registry.get(reader(), 'planner')).effective.model).toBe(
      'anthropic.claude-opus-5-5',
    );
  });

  it('serves every tenant role (viewer+) and refuses a caller with no tenant role', async () => {
    const { registry } = harness();
    for (const role of ROLES) {
      await expect(registry.list(principal([role])), role).resolves.toHaveProperty('items');
      await expect(registry.get(principal([role]), 'orchestrator'), role).resolves.toMatchObject({
        name: 'orchestrator',
      });
    }
    await expect(registry.list(principal([]))).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('fails closed with TENANT_CONTEXT_MISSING when the caller has no tenant', async () => {
    const { registry } = harness();
    const err = await registry.list(reader({ tenantId: null })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe('TENANT_CONTEXT_MISSING');
  });

  it('answers PERSONA_UNKNOWN for a name outside the roster and echoes at most 80 characters of it', async () => {
    const { registry } = harness();
    const err = await registry.get(reader(), 'x'.repeat(500)).catch((e: unknown) => e);
    expect((err as AppError).code).toBe('PERSONA_UNKNOWN');
    expect((err as AppError).message.length).toBeLessThanOrEqual(
      'PERSONA_UNKNOWN: '.length + 80 + 2,
    );
  });

  it('counts each authorised read and never a denied one', async () => {
    const { registry, registryMetrics } = harness();
    await registry.list(reader());
    await registry.get(reader(), 'planner');
    await registry.get(reader(), 'mentor');
    await registry.list(principal([])).catch(() => undefined);
    await registry.get(reader({ tenantId: null }), 'planner').catch(() => undefined);
    expect(await countOf(registryMetrics.reads, 'list')).toBe(1);
    expect(await countOf(registryMetrics.reads, 'get')).toBe(2);
  });

  it('keeps guardrail flags, the schema id and the prompt reference out of the view', async () => {
    const { registry } = harness();
    const serialised = JSON.stringify((await registry.list(reader())).items);
    expect(serialised).not.toContain('guardrails');
    expect(serialised).not.toContain('scopeEnforced');
    expect(serialised).not.toContain('structuredOutputSchemaId');
    expect(serialised).not.toContain('promptRef');
  });

  it('returns the same view from list and get', async () => {
    const { registry } = harness();
    const { items } = await registry.list(reader());
    const single: PersonaRegistryView = await registry.get(reader(), 'reporter');
    expect(items.find((i) => i.name === 'reporter')).toEqual(single);
  });
});
