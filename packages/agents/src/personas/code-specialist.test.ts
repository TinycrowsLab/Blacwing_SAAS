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
import { codeSpecialistPersona as def } from './code-specialist.js';
import { ORACLE_CATALOGUE } from './oracles.js';

const values = Object.fromEntries(PREAMBLE_PLACEHOLDERS.map((k) => [k, `v-${k}`])) as Record<
  PreamblePlaceholder,
  string
>;

describe('code-specialist persona definition', () => {
  it('validates, is registered and is in the fixed roster', () => {
    expect(PERSONA_NAMES).toContain('code-specialist');
    expect(parsePersonaDefinition(structuredClone(def)).name).toBe('code-specialist');
    expect(loadPersona('code-specialist')).toBe(def);
  });

  it('matches the template fields and resolves deep to claude-opus-5-5 at high effort', () => {
    expect(def.tierAlias).toBe('deep');
    expect(def.effort).toBe('high');
    expect(def.maxTurns).toBe(80);
    expect(def.maxBudgetUsdDefault).toBeGreaterThan(0);
    expect(resolveTier(def.tierAlias, 'anthropic')).toBe('claude-opus-5-5');
  });

  it('is capped at active_safe, never destructive, and requires submission', () => {
    expect(def.intrusivenessCeiling).toBe('active_safe');
    expect(def.intrusivenessCeiling).not.toBe('destructive');
    expect(def.requiresSubmission).toBe(true);
  });

  it('declares the marker, file-read and status-diff oracles, each from the catalogue', () => {
    expect(def.declaredOracleTypes).toEqual(
      expect.arrayContaining(['reflected_marker', 'file_read', 'status_diff']),
    );
    for (const t of def.declaredOracleTypes) {
      expect((ORACLE_CATALOGUE as readonly string[]).includes(t)).toBe(true);
    }
  });

  it('allows read-only source tools, Bash scanners, http_request and the findings tools', () => {
    expect(def.allowedTools).toEqual([
      'Read',
      'Grep',
      'Glob',
      'Bash',
      'mcp__blackwing_target__http_request',
      'mcp__blackwing_findings__submit_candidate',
      'mcp__blackwing_findings__attach_evidence',
    ]);
    expect(def.allowedTools).not.toContain('Write');
    expect(def.allowedTools).not.toContain('Edit');
    expect(def.allowedTools).not.toContain('Agent');
  });

  it('disallows networked built-ins and cannot be redefined to allow them', () => {
    for (const t of ['WebFetch', 'WebSearch']) {
      expect(def.allowedTools).not.toContain(t);
      expect(def.disallowedTools).toContain(t);
    }
    const bad = { ...structuredClone(def), allowedTools: [...def.allowedTools, 'WebFetch'] };
    expect(personaDefinitionSchema.safeParse(bad).success).toBe(false);
  });

  it('has a released prompt that composes with the base preamble and keeps source read-only', () => {
    const p = loadPrompt(def.name);
    expect(p.version).toBe(def.promptRef.version);
    expect(p.status).toBe('released');
    const composed = `${fillPreamble(loadPrompt('_base').body, values)}\n${p.body}`;
    expect(composed).not.toMatch(/\{[A-Za-z]+\}/);
    expect(composed).toContain('v-saId');
    expect(p.body).toMatch(/read-only/);
    expect(p.body).toMatch(/never use, test, print or repeat a secret/i);
    expect(p.body).toMatch(/Do not use the Semgrep registry/);
    expect(p.body).toMatch(/do not run `nmap`/);
    expect(p.body).toMatch(/untrusted data/);
    expect(p.body).not.toMatch(/<script|union\s+select|\bcurl\b|\brm -rf\b|' or 1=1/i);
  });
});
