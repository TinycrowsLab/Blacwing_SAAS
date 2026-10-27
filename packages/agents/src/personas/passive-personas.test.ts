import { describe, expect, it } from 'vitest';

import { composePrompt } from '../compose.js';
import { loadPersona, parsePersonaDefinition } from '../persona.js';
import { loadPrompt } from '../prompt.js';
import { osintPersona } from './osint.js';
import { passiveReconPersona } from './passive-recon.js';

const cases = [
  ['passive-recon', passiveReconPersona],
  ['osint', osintPersona],
] as const;

describe.each(cases)('%s persona', (name, def) => {
  it('validates, registers and is passive-class', () => {
    expect(parsePersonaDefinition(def)).toEqual(def);
    expect(loadPersona(name)).toBe(def);
    expect(def.intrusivenessCeiling).toBe('passive');
    expect(def.tierAlias).toBe('standard');
    expect(def.effort).toBe('medium');
    expect(def.maxTurns).toBe(30);
  });

  it('uses only intel tools and disallows Bash and networked built-ins', () => {
    expect(def.allowedTools).toEqual(['mcp__blackwing_intel__*']);
    for (const t of ['Bash', 'WebFetch', 'WebSearch']) {
      expect(def.disallowedTools).toContain(t);
      expect(def.allowedTools).not.toContain(t);
    }
  });

  it('declares no oracle and requires no submission', () => {
    expect(def.declaredOracleTypes).toEqual([]);
    expect(def.requiresSubmission).toBe(false);
  });

  it('has a released prompt skeleton that composes with the base preamble', () => {
    const prompt = loadPrompt(name);
    expect(prompt.version).toBe(def.promptRef.version);
    expect(prompt.status).toBe('released');
    const composed = composePrompt(
      prompt,
      {
        saId: 'sa-1',
        approverIdentity: 'alice@example.com',
        assetScope: ['example.com'],
        testWindow: { start: '2026-01-01T00:00:00Z', end: '2026-01-02T00:00:00Z' },
        maxIntrusiveness: 'passive',
        roles: [],
      },
      { preamble: loadPrompt('_base').body },
    );
    expect(composed.systemPrompt).toContain(prompt.body.trim());
    expect(composed.systemPrompt).toContain('untrusted');
  });
});

describe('osint prompt', () => {
  it('forbids credential use', () => {
    const body = loadPrompt('osint').body;
    expect(body).toMatch(/metadata only/);
    expect(body).toMatch(/Never copy, store, test or use a credential/);
  });
});
