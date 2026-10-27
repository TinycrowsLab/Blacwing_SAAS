import { describe, expect, it } from 'vitest';

import { PREAMBLE_PLACEHOLDERS, fillPreamble, type PreamblePlaceholder } from '../base-preamble.js';
import { PERSONA_NAMES, loadPersona, parsePersonaDefinition } from '../persona.js';
import { loadPrompt } from '../prompt.js';
import { SUBMIT_CANDIDATE_TOOL } from './active-recon.js';
import { ORACLE_CATALOGUE } from './oracles.js';
import { TEST_CASE_LIBRARY_READ_TOOL } from './planner.js';
import {
  CANDIDATE_READ_TOOL,
  EVIDENCE_READ_TOOL,
  validatorAssistantPersona as def,
} from './validator-assistant.js';

const values = Object.fromEntries(PREAMBLE_PLACEHOLDERS.map((k) => [k, `v-${k}`])) as Record<
  PreamblePlaceholder,
  string
>;

describe('validator-assistant persona', () => {
  it('validates, is registered on the fixed roster and resolves tier, effort and step ceiling', () => {
    expect(parsePersonaDefinition(structuredClone(def))).toEqual(def);
    expect(loadPersona('validator-assistant')).toBe(def);
    expect(PERSONA_NAMES).toContain('validator-assistant');
    expect(def.tierAlias).toBe('deep');
    expect(def.effort).toBe('high');
    expect(def.maxTurns).toBe(30);
    expect(def.requiresSubmission).toBe(false);
  });

  it('emits the replay-spec.v1 structured output', () => {
    expect(def.structuredOutputSchemaId).toBe('replay-spec.v1');
    expect(def.promptRef).toEqual({ persona: 'validator-assistant', version: '1.0.0' });
  });

  it('is capped at passive and is never destructive', () => {
    expect(def.intrusivenessCeiling).toBe('passive');
    expect(def.intrusivenessCeiling).not.toBe('destructive');
  });

  it('allows only read-only candidate, evidence and test-case tools by their MCP names', () => {
    expect(def.allowedTools).toEqual([
      'mcp__blackwing_findings__candidate_read',
      'mcp__blackwing_findings__evidence_read',
      'mcp__blackwing_testcases__test_case_library_read',
    ]);
    expect(def.allowedTools).toEqual([
      CANDIDATE_READ_TOOL,
      EVIDENCE_READ_TOOL,
      TEST_CASE_LIBRARY_READ_TOOL,
    ]);
    for (const t of def.allowedTools) {
      expect(t).toMatch(/^mcp__blackwing_[a-z]+__[a-z_]+$/);
    }
  });

  it('excludes shell, networked built-ins, native subagents, writes, target tools and submission', () => {
    for (const t of [
      'Bash',
      'WebFetch',
      'WebSearch',
      'Agent',
      'Write',
      'Edit',
      'mcp__blackwing__http_request',
      'mcp__blackwing__tcp_probe',
      SUBMIT_CANDIDATE_TOOL,
    ]) {
      expect(def.allowedTools).not.toContain(t);
    }
    for (const t of [
      'Bash',
      'WebFetch',
      'WebSearch',
      'Agent',
      'mcp__blackwing__http_request',
      'mcp__blackwing__tcp_probe',
      SUBMIT_CANDIDATE_TOOL,
    ]) {
      expect(def.disallowedTools).toContain(t);
    }
  });

  it('binds exactly the oracle catalogue and declares no oracle of its own', () => {
    expect([...def.declaredOracleTypes].sort()).toEqual([...ORACLE_CATALOGUE].sort());
    expect(def.declaredOracleTypes).not.toContain('post_hoc_check');
  });

  it('declares the inputs the replay spec needs, including the oracle and negative control', () => {
    expect(def.inputs).toEqual(
      expect.arrayContaining([
        'candidate_finding',
        'evidence',
        'test_case_oracle',
        'negative_control',
      ]),
    );
  });

  it('cannot be redefined to allow a networked tool or submission', () => {
    expect(() =>
      parsePersonaDefinition({
        ...structuredClone(def),
        allowedTools: [...def.allowedTools, 'WebFetch'],
      }),
    ).toThrow(/PERSONA_FORBIDDEN_TOOL/);
    expect(() =>
      parsePersonaDefinition({
        ...structuredClone(def),
        allowedTools: [...def.allowedTools, SUBMIT_CANDIDATE_TOOL],
      }),
    ).toThrow(/both allowed and disallowed/);
  });

  it('cannot be redefined with a destructive ceiling', () => {
    expect(() =>
      parsePersonaDefinition({ ...structuredClone(def), intrusivenessCeiling: 'destructive' }),
    ).toThrow();
  });

  it('has a released v1.0.0 prompt that matches the lock in production mode', () => {
    const p = loadPrompt('validator-assistant', undefined, { mode: 'production' });
    expect(p.version).toBe(def.promptRef.version);
    expect(p.status).toBe('released');
    expect(p.meta.tierHint).toBe(def.tierAlias);
  });

  it('prompt skeleton composes with the base preamble and names the output schema', () => {
    const p = loadPrompt('validator-assistant');
    const composed = `${fillPreamble(loadPrompt('_base').body, values)}\n${p.body}`;
    expect(composed).not.toMatch(/\{[A-Za-z]+\}/);
    expect(composed).toContain('v-saId');
    expect(composed).toContain('# Validator assistant');
    expect(p.body).toContain('replay-spec.v1');
    expect(p.body).not.toMatch(/<script|union\s+select|\bcurl\b|\brm -rf\b|' or 1=1/i);
  });

  it('prompt states the bind-never-judge rule, the oracle and negative-control edge cases', () => {
    const body = loadPrompt('validator-assistant').body;
    expect(body).toMatch(/never decide or state that a finding is confirmed, suspected or false/i);
    expect(body).toMatch(/pre-declared oracle/);
    expect(body).toMatch(/no pre-declared oracle, produce no spec/);
    expect(body).toMatch(/negative control is missing, produce no spec/);
    expect(body).toMatch(/Never invent a new oracle/);
    expect(body).toMatch(/Never propose a `destructive` step/);
  });

  it('prompt treats candidate, evidence and target output as untrusted data', () => {
    expect(loadPrompt('validator-assistant').body).toMatch(/untrusted data/);
  });
});
