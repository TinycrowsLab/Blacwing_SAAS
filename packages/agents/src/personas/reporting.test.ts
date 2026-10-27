import { describe, expect, it } from 'vitest';

import { PREAMBLE_PLACEHOLDERS, fillPreamble, type PreamblePlaceholder } from '../base-preamble.js';
import { loadPersona, parsePersonaDefinition, PersonaError } from '../persona.js';
import { loadPrompt } from '../prompt.js';
import { remediationPersona, reporterPersona } from './index.js';

const values = Object.fromEntries(PREAMBLE_PLACEHOLDERS.map((k) => [k, `v-${k}`])) as Record<
  PreamblePlaceholder,
  string
>;

describe.each([
  [reporterPersona, 'deep', 'high', 'finding-report.v1'],
  [remediationPersona, 'standard', 'medium', undefined],
] as const)('$name persona', (def, tier, effort, schemaId) => {
  it('validates against the persona schema and is registered', () => {
    expect(parsePersonaDefinition(structuredClone(def)).name).toBe(def.name);
    expect(loadPersona(def.name)).toBe(def);
  });

  it('matches the template fields', () => {
    expect(def.tierAlias).toBe(tier);
    expect(def.effort).toBe(effort);
    expect(def.maxTurns).toBe(30);
    expect(def.structuredOutputSchemaId).toBe(schemaId);
    expect(def.requiresSubmission).toBe(false);
    expect(def.declaredOracleTypes).toEqual([]);
    expect(def.intrusivenessCeiling).toBe('passive');
  });

  it('is read-only: no shell, networked built-ins, native subagents or target tools', () => {
    for (const t of [
      'Bash',
      'WebFetch',
      'WebSearch',
      'Agent',
      'Write',
      'Edit',
      'mcp__blackwing__http_request',
      'mcp__blackwing__tcp_probe',
    ]) {
      expect(def.allowedTools).not.toContain(t);
    }
    expect(def.allowedTools.every((t) => t.startsWith('mcp__blackwing_'))).toBe(true);
    expect(def.disallowedTools).toEqual(
      expect.arrayContaining(['Bash', 'WebFetch', 'WebSearch', 'Agent']),
    );
  });

  it('never has a destructive or state-changing ceiling', () => {
    expect(def.intrusivenessCeiling).not.toBe('destructive');
    expect(def.intrusivenessCeiling).not.toBe('state_changing');
  });

  it('has a released prompt skeleton that composes with the base preamble without payloads', () => {
    const p = loadPrompt(def.name);
    expect(p.version).toBe(def.promptRef.version);
    expect(p.status).toBe('released');
    const composed = `${fillPreamble(loadPrompt('_base').body, values)}\n${p.body}`;
    expect(composed).not.toMatch(/\{[A-Za-z]+\}/);
    expect(composed).toContain('v-saId');
    expect(p.body).not.toMatch(/<script|union\s+select|\bcurl\b|\brm -rf\b|' or 1=1/i);
  });
});

describe('reporter specifics', () => {
  it('returns structured output matching finding-report.v1', () => {
    expect(loadPrompt('reporter').body).toContain(reporterPersona.structuredOutputSchemaId);
  });

  it('reads only the finding and evidence tools', () => {
    expect(reporterPersona.allowedTools).toEqual([
      'mcp__blackwing_findings__finding_read',
      'mcp__blackwing_findings__evidence_read',
    ]);
  });

  it('derives CVSS from the stored vector and never invents scores or severity', () => {
    const body = loadPrompt('reporter').body;
    expect(body).toMatch(/CVSS v4\.0 interpretation read from the stored vector/);
    expect(body).toMatch(/Never invent or adjust a score/);
    expect(body).toMatch(/`pending vector`/);
  });

  it('refuses findings that are not confirmed and released, and writes no payloads', () => {
    const body = loadPrompt('reporter').body;
    expect(body).toMatch(/Gate 3/);
    expect(body).toMatch(/Never write exploit payloads/);
    expect(body).toMatch(/built only from captured evidence/);
  });

  it('rejects a reporter that would be granted a networked built-in', () => {
    const bad = structuredClone(reporterPersona) as Record<string, unknown>;
    bad.allowedTools = [...reporterPersona.allowedTools, 'WebFetch'];
    expect(() => parsePersonaDefinition(bad)).toThrow(PersonaError);
    expect(() => parsePersonaDefinition(bad)).toThrow(/PERSONA_FORBIDDEN_TOOL/);
  });

  it('rejects a destructive ceiling', () => {
    const bad = { ...reporterPersona, intrusivenessCeiling: 'destructive' };
    expect(() => parsePersonaDefinition(bad)).toThrow(PersonaError);
  });
});

describe('remediation specifics', () => {
  it('reads findings, evidence and white-box source only', () => {
    expect(remediationPersona.allowedTools).toEqual([
      'mcp__blackwing_findings__finding_read',
      'mcp__blackwing_findings__evidence_read',
      'mcp__blackwing_source__source_read',
    ]);
  });

  it('cites standard IDs only and degrades to class-level guidance without source', () => {
    const body = loadPrompt('remediation').body;
    expect(body).toMatch(/Cite standard IDs/);
    expect(body).toMatch(/Without source, give class-level guidance only/);
    expect(body).toMatch(/Source is read-only/);
  });

  it('keeps retest plans in words, never requests or payloads', () => {
    expect(loadPrompt('remediation').body).toMatch(/Describe the check in words/);
  });

  it('rejects a remediation that would be granted WebSearch', () => {
    const bad = { ...remediationPersona, allowedTools: ['WebSearch'] };
    expect(() => parsePersonaDefinition(bad)).toThrow(/PERSONA_FORBIDDEN_TOOL/);
  });
});
