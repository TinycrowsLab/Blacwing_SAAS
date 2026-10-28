import { describe, expect, it } from 'vitest';

import { AppError, ValidationError } from '@blackwing/errors';

import {
  PERSONA_OVERRIDE_FIELDS,
  parsePersonaOverride,
  PersonaOverrideFieldError,
  resolveEffectivePersona,
} from './persona-overrides.js';
import { parsePersonaDefinition, type PersonaDefinition } from './persona.js';

function definition(over: Record<string, unknown> = {}): PersonaDefinition {
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
    ...over,
  });
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return e instanceof AppError ? e.code : 'OTHER';
  }
  return undefined;
}

describe('persona override whitelist', () => {
  it('whitelists exactly effort, maxTurns, maxBudgetUsd and lowerStandardTier', () => {
    expect([...PERSONA_OVERRIDE_FIELDS]).toEqual([
      'effort',
      'maxTurns',
      'maxBudgetUsd',
      'lowerStandardTier',
    ]);
  });

  it('applies a whitelisted override', () => {
    expect(parsePersonaOverride({ effort: 'low', maxTurns: 10 })).toEqual({
      effort: 'low',
      maxTurns: 10,
    });
  });

  it('accepts an empty override (resets every field to the base)', () => {
    expect(parsePersonaOverride({})).toEqual({});
  });

  it.each([
    'allowedTools',
    'disallowedTools',
    'intrusivenessCeiling',
    'tierAlias',
    'mandate',
    'name',
    'promptRef',
    'helpers',
    'requiresSubmission',
  ])('rejects forbidden field %s with OVERRIDE_FIELD_FORBIDDEN', (field) => {
    expect(codeOf(() => parsePersonaOverride({ [field]: 'anything' }))).toBe(
      'OVERRIDE_FIELD_FORBIDDEN',
    );
  });

  it('rejects a forbidden field even when a whitelisted field is valid', () => {
    expect(() => parsePersonaOverride({ effort: 'low', allowedTools: ['Bash'] })).toThrow(
      PersonaOverrideFieldError,
    );
  });

  it('reports the forbidden key before judging its value', () => {
    expect(codeOf(() => parsePersonaOverride({ intrusivenessCeiling: 'destructive' }))).toBe(
      'OVERRIDE_FIELD_FORBIDDEN',
    );
  });

  it('rejects a prototype-pollution key parsed from JSON', () => {
    const body = JSON.parse('{"__proto__": {"allowedTools": ["Bash"]}}') as unknown;
    expect(codeOf(() => parsePersonaOverride(body))).toBe('OVERRIDE_FIELD_FORBIDDEN');
  });

  it('truncates a long forbidden key in the error', () => {
    const key = `x${'y'.repeat(500)}`;
    const err = (() => {
      try {
        parsePersonaOverride({ [key]: 1 });
      } catch (e) {
        return e;
      }
      return undefined;
    })();
    expect(err).toBeInstanceOf(PersonaOverrideFieldError);
    expect((err as PersonaOverrideFieldError).fields[0]?.length).toBe(64);
  });

  it.each([
    ['a non-object body', 'effort'],
    ['an array body', []],
    ['null', null],
  ])('rejects %s with VALIDATION_FAILED', (_label, body) => {
    expect(codeOf(() => parsePersonaOverride(body))).toBe('VALIDATION_FAILED');
  });

  it.each([
    { effort: 'extreme' },
    { maxTurns: 0 },
    { maxTurns: 1.5 },
    { maxTurns: 10_001 },
    { maxBudgetUsd: 0 },
    { maxBudgetUsd: -1 },
    { maxBudgetUsd: Number.NaN },
    { maxBudgetUsd: 10_001 },
    { lowerStandardTier: 'yes' },
    { effort: null },
  ])('rejects an out-of-range value %j with VALIDATION_FAILED', (body) => {
    expect(() => parsePersonaOverride(body)).toThrow(ValidationError);
  });
});

describe('resolveEffectivePersona', () => {
  it('returns the base definition when there is no override', () => {
    const effective = resolveEffectivePersona(definition(), null);
    expect(effective).toEqual({
      name: 'osint',
      tierAlias: 'standard',
      effort: 'medium',
      maxTurns: 30,
      maxBudgetUsd: 2,
      evalFlags: {},
      overridden: [],
      clamped: [],
    });
  });

  it('applies a whitelisted override with override precedence', () => {
    const effective = resolveEffectivePersona(definition(), {
      effort: 'high',
      maxTurns: 12,
      maxBudgetUsd: 0.5,
    });
    expect(effective.effort).toBe('high');
    expect(effective.maxTurns).toBe(12);
    expect(effective.maxBudgetUsd).toBe(0.5);
    expect(effective.overridden).toEqual(['effort', 'maxTurns', 'maxBudgetUsd']);
    expect(effective.clamped).toEqual([]);
  });

  it('clamps maxTurns to the persona ceiling and reports it', () => {
    const effective = resolveEffectivePersona(definition(), { maxTurns: 500 });
    expect(effective.maxTurns).toBe(30);
    expect(effective.clamped).toEqual([{ field: 'maxTurns', requested: 500, applied: 30 }]);
    expect(effective.overridden).toEqual(['maxTurns']);
  });

  it('clamps maxBudgetUsd to the persona default, never above it', () => {
    const effective = resolveEffectivePersona(definition(), { maxBudgetUsd: 9 });
    expect(effective.maxBudgetUsd).toBe(2);
    expect(effective.clamped).toEqual([{ field: 'maxBudgetUsd', requested: 9, applied: 2 }]);
  });

  it('leaves a value exactly at the ceiling unclamped', () => {
    const effective = resolveEffectivePersona(definition(), { maxTurns: 30, maxBudgetUsd: 2 });
    expect(effective.clamped).toEqual([]);
  });

  it('lowers a standard-tier persona only when asked', () => {
    const lowered = resolveEffectivePersona(definition(), { lowerStandardTier: true });
    expect(lowered.evalFlags).toEqual({ lowerStandard: true });
    expect(lowered.overridden).toEqual(['lowerStandardTier']);

    const kept = resolveEffectivePersona(definition(), { lowerStandardTier: false });
    expect(kept.evalFlags).toEqual({});
    expect(kept.overridden).toEqual([]);
  });

  it('ignores lowerStandardTier for a non-standard persona', () => {
    const deep = definition({ tierAlias: 'deep', effort: 'high' });
    const effective = resolveEffectivePersona(deep, { lowerStandardTier: true });
    expect(effective.evalFlags).toEqual({});
    expect(effective.overridden).toEqual([]);
  });

  it('never changes tools, the ceiling or the tier alias', () => {
    const base = definition();
    const effective = resolveEffectivePersona(base, { effort: 'max', maxTurns: 1 });
    expect(effective).not.toHaveProperty('allowedTools');
    expect(effective).not.toHaveProperty('intrusivenessCeiling');
    expect(effective.tierAlias).toBe(base.tierAlias);
  });
});
