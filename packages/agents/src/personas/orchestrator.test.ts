import { describe, expect, it } from 'vitest';

import { PREAMBLE_PLACEHOLDERS, fillPreamble, type PreamblePlaceholder } from '../base-preamble.js';
import { PERSONA_NAMES, loadPersona, parsePersonaDefinition } from '../persona.js';
import { loadPrompt } from '../prompt.js';
import { ORCHESTRATOR_ALLOWED_TOOLS, orchestratorPersona } from './orchestrator.js';

describe('orchestrator persona', () => {
  it('is registered and re-validates against the persona schema', () => {
    expect(loadPersona('orchestrator')).toBe(orchestratorPersona);
    expect(parsePersonaDefinition(orchestratorPersona).name).toBe('orchestrator');
    expect(PERSONA_NAMES).toContain('orchestrator');
  });

  it('allows only engagement MCP tools by their exact names', () => {
    expect(orchestratorPersona.allowedTools).toEqual(ORCHESTRATOR_ALLOWED_TOOLS);
    expect(orchestratorPersona.allowedTools).toHaveLength(7);
    for (const t of orchestratorPersona.allowedTools) {
      expect(t).toMatch(/^mcp__blackwing_engagement__[a-z_]+$/);
    }
    expect(orchestratorPersona.allowedTools).toContain(
      'mcp__blackwing_engagement__dispatch_subtask',
    );
  });

  it('disallows Bash, networked built-ins and the native Agent tool', () => {
    for (const t of ['Bash', 'WebFetch', 'WebSearch', 'Agent']) {
      expect(orchestratorPersona.disallowedTools).toContain(t);
      expect(orchestratorPersona.allowedTools).not.toContain(t);
    }
  });

  it('declares no oracle and no submission, passive ceiling, deep/high, 200 turns', () => {
    expect(orchestratorPersona.requiresSubmission).toBe(false);
    expect(orchestratorPersona.declaredOracleTypes).toEqual([]);
    expect(orchestratorPersona.intrusivenessCeiling).toBe('passive');
    expect(orchestratorPersona.tierAlias).toBe('deep');
    expect(orchestratorPersona.effort).toBe('high');
    expect(orchestratorPersona.maxTurns).toBe(200);
    expect(orchestratorPersona.guardrails).toEqual({
      scopeEnforced: true,
      treatToolOutputAsUntrusted: true,
    });
  });

  it('rejects a mutated definition that adds a networked tool', () => {
    expect(() =>
      parsePersonaDefinition({
        ...orchestratorPersona,
        allowedTools: [...orchestratorPersona.allowedTools, 'WebFetch'],
      }),
    ).toThrow(/PERSONA_FORBIDDEN_TOOL/);
  });

  it('has a released v1.0.0 prompt that matches the lock in production mode', () => {
    const p = loadPrompt('orchestrator', undefined, { mode: 'production' });
    expect(p.version).toBe('1.0.0');
    expect(p.status).toBe('released');
    expect(p.meta.tierHint).toBe(orchestratorPersona.tierAlias);
    expect(orchestratorPersona.promptRef).toEqual({ persona: 'orchestrator', version: '1.0.0' });
    expect(p.body).toContain('dispatch_subtask');
    expect(p.body).toContain('untrusted');
    expect(p.body).not.toMatch(/Bash|WebFetch|WebSearch/);
  });

  it('composes with the filled base preamble without stray placeholders', () => {
    const values = Object.fromEntries(PREAMBLE_PLACEHOLDERS.map((k) => [k, `v-${k}`])) as Record<
      PreamblePlaceholder,
      string
    >;
    const persona = loadPrompt('orchestrator');
    const composed = `${fillPreamble(loadPrompt('_base').body, values)}\n${persona.body}`;
    expect(composed).not.toMatch(/\{[A-Za-z][A-Za-z0-9]*\}/);
    expect(composed).toContain('v-saId');
    expect(composed).toContain('dispatch_subtask');
    expect(fillPreamble(persona.body, values)).toBe(persona.body);
  });
});
