import { describe, expect, it } from 'vitest';

import { PREAMBLE_PLACEHOLDERS, fillPreamble, type PreamblePlaceholder } from '../base-preamble.js';
import { loadPersona, parsePersonaDefinition } from '../persona.js';
import { loadPrompt } from '../prompt.js';
import { plannerPersona, subPlannerPersona } from './index.js';
import { ORACLE_CATALOGUE } from './oracles.js';

const values = Object.fromEntries(PREAMBLE_PLACEHOLDERS.map((k) => [k, `v-${k}`])) as Record<
  PreamblePlaceholder,
  string
>;

describe.each([
  [plannerPersona, 'plan.v1', 'deep', 'high', 40],
  [subPlannerPersona, 'subtasks.v1', 'standard', 'medium', 20],
] as const)('$name persona', (def, schemaId, tier, effort, turns) => {
  it('validates and is registered', () => {
    expect(parsePersonaDefinition(structuredClone(def)).name).toBe(def.name);
    expect(loadPersona(def.name)).toBe(def);
  });

  it('matches the template fields', () => {
    expect(def.tierAlias).toBe(tier);
    expect(def.effort).toBe(effort);
    expect(def.maxTurns).toBe(turns);
    expect(def.structuredOutputSchemaId).toBe(schemaId);
    expect(def.requiresSubmission).toBe(false);
  });

  it('is read-only with no networked or target tools', () => {
    for (const t of ['Bash', 'WebFetch', 'WebSearch', 'Agent', 'Write', 'Edit']) {
      expect(def.allowedTools).not.toContain(t);
    }
    expect(def.allowedTools.every((t) => t.startsWith('mcp__blackwing_'))).toBe(true);
    expect(def.allowedTools).toContain('mcp__blackwing_surface__surface_query');
    expect(def.disallowedTools).toEqual(expect.arrayContaining(['Bash', 'WebFetch', 'WebSearch']));
  });

  it('never has a destructive ceiling and covers the oracle catalogue', () => {
    expect(def.intrusivenessCeiling).not.toBe('destructive');
    expect([...def.declaredOracleTypes].sort()).toEqual([...ORACLE_CATALOGUE].sort());
  });

  it('prompt skeleton loads hash-verified and composes with the base preamble', () => {
    const p = loadPrompt(def.name);
    expect(p.version).toBe(def.promptRef.version);
    expect(p.status).toBe('released');
    const composed = `${fillPreamble(loadPrompt('_base').body, values)}\n${p.body}`;
    expect(composed).not.toMatch(/\{[A-Za-z]+\}/);
    expect(composed).toContain('v-saId');
    expect(composed).toContain(`# ${def.name === 'planner' ? 'Planner' : 'Sub-planner'}`);
    expect(p.body).toContain(schemaId);
    expect(p.body).not.toMatch(/<script|union\s+select|\bcurl\b|\brm -rf\b|' or 1=1/i);
  });
});

describe('planner specifics', () => {
  it('also reads the test-case library', () => {
    expect(plannerPersona.allowedTools).toContain(
      'mcp__blackwing_testcases__test_case_library_read',
    );
  });

  it('sub-planner has surface_query only', () => {
    expect(subPlannerPersona.allowedTools).toEqual(['mcp__blackwing_surface__surface_query']);
  });

  it('prompts cover edge cases and the no-new-oracle rule', () => {
    const planner = loadPrompt('planner').body;
    expect(planner).toMatch(/empty or too thin/);
    expect(planner).toMatch(/Gate 1/);
    expect(planner).toMatch(/Never propose a `destructive`/);
    expect(loadPrompt('sub-planner').body).toMatch(/Do not declare a new oracle/);
  });
});
