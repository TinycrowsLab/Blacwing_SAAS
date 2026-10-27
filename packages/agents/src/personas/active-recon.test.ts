import { describe, expect, it } from 'vitest';

import { composePrompt } from '../compose.js';
import { loadPersona, parsePersonaDefinition, personaDefinitionSchema } from '../persona.js';
import { loadPrompt } from '../prompt.js';
import { activeReconPersona as def, SUBMIT_CANDIDATE_TOOL } from './active-recon.js';

describe('active-recon persona', () => {
  it('validates, registers and resolves tier, effort and step ceiling', () => {
    expect(parsePersonaDefinition(structuredClone(def))).toEqual(def);
    expect(loadPersona('active-recon')).toBe(def);
    expect(def.tierAlias).toBe('standard');
    expect(def.effort).toBe('medium');
    expect(def.maxTurns).toBe(60);
  });

  it('is capped at active_safe, declares no oracle and submits nothing', () => {
    expect(def.intrusivenessCeiling).toBe('active_safe');
    expect(def.declaredOracleTypes).toEqual([]);
    expect(def.requiresSubmission).toBe(false);
  });

  it('allows exactly the recon tools and excludes networked built-ins and submit_candidate', () => {
    expect(def.allowedTools).toEqual([
      'Bash',
      'mcp__blackwing__http_request',
      'mcp__blackwing__tcp_probe',
      'mcp__blackwing__dns_lookup',
      'mcp__playwright__*',
      'mcp__blackwing__write_surface',
      'mcp__blackwing__get_engagement_state',
      'mcp__blackwing__mark_test_case_status',
    ]);
    for (const t of ['WebFetch', 'WebSearch', SUBMIT_CANDIDATE_TOOL]) {
      expect(def.allowedTools).not.toContain(t);
      expect(def.disallowedTools).toContain(t);
    }
  });

  it('cannot be redefined to allow a forbidden tool', () => {
    const bad = { ...structuredClone(def), allowedTools: [...def.allowedTools, 'WebFetch'] };
    expect(personaDefinitionSchema.safeParse(bad).success).toBe(false);
  });

  it('has a released prompt that composes and states the guardrails', () => {
    const prompt = loadPrompt('active-recon');
    expect(prompt.version).toBe(def.promptRef.version);
    expect(prompt.status).toBe('released');
    expect(prompt.body).toMatch(/active_safe/);
    expect(prompt.body).toMatch(/proxychains-ng/);
    expect(prompt.body).toMatch(/untrusted data/);
    const composed = composePrompt(
      prompt,
      {
        saId: 'sa-1',
        approverIdentity: 'alice@example.com',
        assetScope: ['example.com'],
        testWindow: { start: '2026-01-01T00:00:00Z', end: '2026-01-02T00:00:00Z' },
        maxIntrusiveness: 'active_safe',
        roles: [],
      },
      { preamble: loadPrompt('_base').body },
    );
    expect(composed.systemPrompt).toContain(prompt.body.trim());
  });
});
