import { describe, expect, it } from 'vitest';

import { PREAMBLE_PLACEHOLDERS, fillPreamble, type PreamblePlaceholder } from '../base-preamble.js';
import {
  PERSONA_NAMES,
  loadPersona,
  parsePersonaDefinition,
  personaDefinitionSchema,
} from '../persona.js';
import { loadPrompt } from '../prompt.js';
import { resolveTier } from '../tier.js';
import { infrastructureSpecialistPersona as def } from './infrastructure-specialist.js';
import { ORACLE_CATALOGUE } from './oracles.js';

const values = Object.fromEntries(PREAMBLE_PLACEHOLDERS.map((k) => [k, `v-${k}`])) as Record<
  PreamblePlaceholder,
  string
>;

describe('infrastructure-specialist persona definition', () => {
  it('validates, is registered and is in the fixed roster', () => {
    expect(PERSONA_NAMES).toContain('infrastructure-specialist');
    expect(parsePersonaDefinition(structuredClone(def)).name).toBe('infrastructure-specialist');
    expect(loadPersona('infrastructure-specialist')).toBe(def);
  });

  it('matches the template fields and resolves standard to claude-opus-5-5 at medium effort', () => {
    expect(def.tierAlias).toBe('standard');
    expect(def.effort).toBe('medium');
    expect(def.maxTurns).toBe(50);
    expect(def.maxBudgetUsdDefault).toBeGreaterThan(0);
    expect(resolveTier(def.tierAlias, 'anthropic')).toBe('claude-opus-5-5');
  });

  it('is capped at active_safe, never destructive, and requires submission', () => {
    expect(def.intrusivenessCeiling).toBe('active_safe');
    expect(def.intrusivenessCeiling).not.toBe('destructive');
    expect(def.requiresSubmission).toBe(true);
  });

  it('declares only catalogue oracles, including the status and error-signature oracles', () => {
    expect(def.declaredOracleTypes).toEqual(
      expect.arrayContaining(['status_diff', 'error_signature']),
    );
    for (const t of def.declaredOracleTypes) {
      expect((ORACLE_CATALOGUE as readonly string[]).includes(t)).toBe(true);
    }
  });

  it('allows the pinned Bash scanners, tcp_probe and the findings tools by exact name', () => {
    expect(def.allowedTools).toEqual([
      'Bash',
      'mcp__blackwing_target__tcp_probe',
      'mcp__blackwing_findings__submit_candidate',
      'mcp__blackwing_findings__attach_evidence',
    ]);
  });

  it('disallows networked built-ins and cannot be redefined to allow them', () => {
    for (const t of ['WebFetch', 'WebSearch']) {
      expect(def.allowedTools).not.toContain(t);
      expect(def.disallowedTools).toContain(t);
    }
    const bad = { ...structuredClone(def), allowedTools: [...def.allowedTools, 'WebSearch'] };
    expect(personaDefinitionSchema.safeParse(bad).success).toBe(false);
    const unguarded = { ...structuredClone(def), disallowedTools: ['WebFetch'] };
    expect(personaDefinitionSchema.safeParse(unguarded).success).toBe(false);
  });

  it('denies nmap through a scoped Bash rule, since naabu and fingerprintx replace it', () => {
    expect(def.disallowedTools).toContain('Bash(*nmap*)');
    expect(def.allowedTools).toContain('Bash');
  });

  it('has a released prompt that composes with the base preamble and stays in its altitude', () => {
    const p = loadPrompt(def.name);
    expect(p.version).toBe(def.promptRef.version);
    expect(p.status).toBe('released');
    const composed = `${fillPreamble(loadPrompt('_base').body, values)}\n${p.body}`;
    expect(composed).not.toMatch(/\{[A-Za-z]+\}/);
    expect(composed).toContain('v-saId');
    expect(p.body).toMatch(/active_safe/);
    expect(p.body).toMatch(/Suspected/);
    expect(p.body).toMatch(/untrusted data/);
    expect(p.body).toMatch(/Do not try credentials/);
    expect(p.body).not.toMatch(/<script|union\s+select|\bcurl\b|\brm -rf\b|hydra|msfconsole/i);
  });
});
