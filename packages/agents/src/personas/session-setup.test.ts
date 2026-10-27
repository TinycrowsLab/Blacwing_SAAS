import { describe, expect, it } from 'vitest';

import { PREAMBLE_PLACEHOLDERS, fillPreamble, type PreamblePlaceholder } from '../base-preamble.js';
import { PERSONA_NAMES, loadPersona, parsePersonaDefinition } from '../persona.js';
import { loadPrompt } from '../prompt.js';
import { SESSION_SETUP_ALLOWED_TOOLS, sessionSetupPersona } from './session-setup.js';

const values = Object.fromEntries(PREAMBLE_PLACEHOLDERS.map((k) => [k, `v-${k}`])) as Record<
  PreamblePlaceholder,
  string
>;

describe.each([['session-setup', sessionSetupPersona, 30]] as const)(
  '%s persona',
  (name, persona, turns) => {
    it('is registered and re-validates against the persona schema', () => {
      expect(loadPersona(name)).toBe(persona);
      expect(parsePersonaDefinition(persona).name).toBe(name);
      expect(PERSONA_NAMES).toContain(name);
    });

    it('is standard/medium, active_safe (never destructive), no oracle, no submission', () => {
      expect(persona.tierAlias).toBe('standard');
      expect(persona.effort).toBe('medium');
      expect(persona.maxTurns).toBe(turns);
      expect(persona.intrusivenessCeiling).toBe('active_safe');
      expect(persona.declaredOracleTypes).toEqual([]);
      expect(persona.requiresSubmission).toBe(false);
      expect(persona.guardrails).toEqual({ scopeEnforced: true, treatToolOutputAsUntrusted: true });
    });

    it('disallows WebFetch and WebSearch and never allows them', () => {
      for (const t of ['WebFetch', 'WebSearch']) {
        expect(persona.disallowedTools).toContain(t);
        expect(persona.allowedTools).not.toContain(t);
      }
      expect(() =>
        parsePersonaDefinition({
          ...persona,
          allowedTools: [...persona.allowedTools, 'WebSearch'],
        }),
      ).toThrow(/PERSONA_FORBIDDEN_TOOL/);
    });

    it('has a released v1.0.0 prompt that matches the lock and composes with the preamble', () => {
      const p = loadPrompt(name, undefined, { mode: 'production' });
      expect(p.version).toBe('1.0.0');
      expect(p.status).toBe('released');
      expect(p.meta.tierHint).toBe(persona.tierAlias);
      expect(persona.promptRef).toEqual({ persona: name, version: '1.0.0' });
      expect(p.body).toContain('untrusted');
      expect(p.body).toContain('active_safe');
      const composed = `${fillPreamble(loadPrompt('_base').body, values)}\n${p.body}`;
      expect(composed).not.toMatch(/\{[A-Za-z][A-Za-z0-9]*\}/);
      expect(composed).toContain('v-saId');
      expect(fillPreamble(p.body, values)).toBe(p.body);
    });
  },
);

describe('session-setup tools and credential handling', () => {
  it('uses session-manager tools and the browser only', () => {
    expect(sessionSetupPersona.allowedTools).toEqual(SESSION_SETUP_ALLOWED_TOOLS);
    expect(sessionSetupPersona.allowedTools).toEqual([
      'mcp__blackwing_session__*',
      'mcp__playwright__*',
    ]);
  });

  it('states credentials are by reference and the lockout guard', () => {
    const body = loadPrompt('session-setup').body;
    expect(body).toMatch(/by reference only/);
    expect(body).toMatch(/lockout guard/);
    expect(sessionSetupPersona.inputs).toContain('credential_references');
  });
});
