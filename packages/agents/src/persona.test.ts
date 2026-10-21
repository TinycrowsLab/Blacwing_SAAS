import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  PERSONA_NAMES,
  PersonaError,
  loadPersona,
  parsePersonaDefinition,
  registerPersona,
} from './persona.js';

function valid(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'planner',
    mandate: 'Turn the surface model into test cases.',
    tierAlias: 'deep',
    effort: 'high',
    maxTurns: 40,
    maxBudgetUsdDefault: 5,
    allowedTools: ['Read', 'Grep'],
    disallowedTools: ['WebFetch', 'WebSearch'],
    declaredOracleTypes: ['reflected_marker'],
    inputs: ['surface_model'],
    intrusivenessCeiling: 'passive',
    requiresSubmission: false,
    promptRef: { persona: 'planner', version: '1.0.0' },
    guardrails: { scopeEnforced: true, treatToolOutputAsUntrusted: true },
    ...over,
  };
}

function codeOf(input: unknown): string | undefined {
  try {
    parsePersonaDefinition(input);
  } catch (e) {
    return e instanceof PersonaError ? e.code : 'OTHER';
  }
  return undefined;
}

describe('persona definition schema', () => {
  it('has the fixed 19 personas', () => {
    expect(new Set(PERSONA_NAMES).size).toBe(19);
  });

  it('parses a valid definition', () => {
    expect(parsePersonaDefinition(valid()).name).toBe('planner');
  });

  it('rejects WebFetch/WebSearch in allowedTools with PERSONA_FORBIDDEN_TOOL', () => {
    expect(codeOf(valid({ allowedTools: ['Read', 'WebFetch'] }))).toBe('PERSONA_FORBIDDEN_TOOL');
    expect(codeOf(valid({ allowedTools: ['WebSearch'] }))).toBe('PERSONA_FORBIDDEN_TOOL');
  });

  it('requires both networked built-ins in disallowedTools', () => {
    expect(codeOf(valid({ disallowedTools: ['WebFetch'] }))).toBe('PERSONA_FORBIDDEN_TOOL');
    expect(codeOf(valid({ disallowedTools: [] }))).toBe('PERSONA_FORBIDDEN_TOOL');
  });

  it('rejects forbidden tools in helper definitions', () => {
    const helpers = [
      { name: 'h', description: 'd', tierAlias: 'fast', allowedTools: ['WebSearch'] },
    ];
    expect(codeOf(valid({ helpers }))).toBe('PERSONA_FORBIDDEN_TOOL');
  });

  it('rejects a destructive or unknown intrusiveness ceiling', () => {
    expect(codeOf(valid({ intrusivenessCeiling: 'destructive' }))).toBe('PERSONA_INVALID');
    expect(codeOf(valid({ intrusivenessCeiling: 'Passive' }))).toBe('PERSONA_INVALID');
  });

  it('accepts every non-destructive ceiling', () => {
    for (const c of ['passive', 'active_safe', 'state_changing']) {
      expect(parsePersonaDefinition(valid({ intrusivenessCeiling: c })).intrusivenessCeiling).toBe(
        c,
      );
    }
  });

  it('rejects a 20th / unknown persona name with PERSONA_UNKNOWN', () => {
    expect(codeOf(valid({ name: 'persona-20' }))).toBe('PERSONA_UNKNOWN');
    expect(() => loadPersona('persona-20')).toThrowError(/PERSONA_UNKNOWN/);
  });

  it('allows empty allowedTools (read-only personas)', () => {
    expect(parsePersonaDefinition(valid({ allowedTools: [] })).allowedTools).toEqual([]);
  });

  it('normalises duplicate tool names', () => {
    const p = parsePersonaDefinition(valid({ allowedTools: ['Read', ' Read', 'Grep', 'Read'] }));
    expect(p.allowedTools).toEqual(['Read', 'Grep']);
  });

  it('does not require structuredOutputSchemaId (flagged at composition)', () => {
    expect(
      parsePersonaDefinition(valid({ requiresSubmission: true })).structuredOutputSchemaId,
    ).toBeUndefined();
  });

  it('rejects unknown fields, bad enums, bad numbers and mismatched promptRef', () => {
    expect(codeOf(valid({ extra: 1 }))).toBe('PERSONA_INVALID');
    expect(codeOf(valid({ tierAlias: 'huge' }))).toBe('PERSONA_INVALID');
    expect(codeOf(valid({ effort: 'ultra' }))).toBe('PERSONA_INVALID');
    expect(codeOf(valid({ maxTurns: 0 }))).toBe('PERSONA_INVALID');
    expect(codeOf(valid({ maxTurns: 1.5 }))).toBe('PERSONA_INVALID');
    expect(codeOf(valid({ maxBudgetUsdDefault: -1 }))).toBe('PERSONA_INVALID');
    expect(codeOf(valid({ promptRef: { persona: 'mentor', version: '1.0.0' } }))).toBe(
      'PERSONA_INVALID',
    );
    expect(codeOf(valid({ promptRef: { persona: 'planner', version: 'v1' } }))).toBe(
      'PERSONA_INVALID',
    );
    expect(codeOf(null)).toBe('PERSONA_INVALID');
  });

  it('rejects a tool that is both allowed and disallowed', () => {
    expect(
      codeOf(valid({ allowedTools: ['Bash'], disallowedTools: ['WebFetch', 'WebSearch', 'Bash'] })),
    ).toBe('PERSONA_INVALID');
  });

  it('property: forbidden tools allowed or not disallowed are always rejected', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom('Read', 'Grep', 'Bash', 'WebFetch', 'WebSearch')),
        fc.array(fc.constantFrom('Read', 'Bash', 'WebFetch', 'WebSearch')),
        (allowed, disallowed) => {
          const code = codeOf(valid({ allowedTools: allowed, disallowedTools: disallowed }));
          const hasForbidden = allowed.some((t) => t === 'WebFetch' || t === 'WebSearch');
          const missing = !(disallowed.includes('WebFetch') && disallowed.includes('WebSearch'));
          expect(!(hasForbidden || missing) || code !== undefined).toBe(true);
        },
      ),
    );
  });

  it('loadPersona returns registered definitions and fails for undefined ones', () => {
    expect(() => loadPersona('mentor')).toThrowError(/PERSONA_NOT_DEFINED/);
    registerPersona(valid({ name: 'mentor', promptRef: { persona: 'mentor', version: '1.0.0' } }));
    expect(loadPersona('mentor').name).toBe('mentor');
  });
});
