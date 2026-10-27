import { describe, expect, it } from 'vitest';

import { PREAMBLE_PLACEHOLDERS, fillPreamble, type PreamblePlaceholder } from '../base-preamble.js';
import { PERSONA_NAMES, loadPersona, parsePersonaDefinition } from '../persona.js';
import { loadPrompt } from '../prompt.js';
import { ADVISORY_DISALLOWED_TOOLS, TRANSCRIPT_SUMMARY_READ_TOOL } from './advisory.js';
import { mentorPersona } from './mentor.js';
import { JOURNAL_LESSONS_READ_TOOL, reflectorPersona } from './reflector.js';

const values = Object.fromEntries(PREAMBLE_PLACEHOLDERS.map((k) => [k, `v-${k}`])) as Record<
  PreamblePlaceholder,
  string
>;

describe.each([
  [mentorPersona, [TRANSCRIPT_SUMMARY_READ_TOOL]],
  [reflectorPersona, [TRANSCRIPT_SUMMARY_READ_TOOL, JOURNAL_LESSONS_READ_TOOL]],
] as const)('$name advisory persona', (def, allowed) => {
  it('is registered and re-validates against the persona schema', () => {
    expect(PERSONA_NAMES).toContain(def.name);
    expect(loadPersona(def.name)).toBe(def);
    expect(parsePersonaDefinition(structuredClone(def)).name).toBe(def.name);
  });

  it('matches the 8-field template: standard/medium, 15 turns, advisory only', () => {
    expect(def.tierAlias).toBe('standard');
    expect(def.effort).toBe('medium');
    expect(def.maxTurns).toBe(15);
    expect(def.requiresSubmission).toBe(false);
    expect(def.structuredOutputSchemaId).toBeUndefined();
    expect(def.declaredOracleTypes).toEqual([]);
    expect(def.intrusivenessCeiling).toBe('passive');
    expect(def.guardrails).toEqual({ scopeEnforced: true, treatToolOutputAsUntrusted: true });
  });

  it('allows only the read-only tools by their exact MCP names', () => {
    expect(def.allowedTools).toEqual(allowed);
    for (const t of def.allowedTools) {
      expect(t).toMatch(/^mcp__blackwing_[a-z]+__[a-z_]+$/);
    }
  });

  it('cannot use shell, networked built-ins, subagents, writes, target or engagement mutation', () => {
    for (const t of [
      'Bash',
      'WebFetch',
      'WebSearch',
      'Agent',
      'Write',
      'Edit',
      'mcp__blackwing__http_request',
      'mcp__blackwing_target__http_batch',
      'mcp__blackwing_engagement__dispatch_subtask',
      'mcp__blackwing_findings__submit_candidate',
    ]) {
      expect(def.disallowedTools).toContain(t);
      expect(def.allowedTools).not.toContain(t);
    }
    expect(def.disallowedTools).toEqual(ADVISORY_DISALLOWED_TOOLS);
  });

  it('never has a destructive ceiling and declares no oracle', () => {
    expect(def.intrusivenessCeiling).not.toBe('destructive');
    expect(def.declaredOracleTypes).toEqual([]);
  });

  it('rejects a mutated definition that adds WebFetch to allowedTools', () => {
    expect(() =>
      parsePersonaDefinition({ ...def, allowedTools: [...def.allowedTools, 'WebFetch'] }),
    ).toThrow(/PERSONA_FORBIDDEN_TOOL/);
  });

  it('rejects a mutated definition that allows a tool it also disallows', () => {
    expect(() =>
      parsePersonaDefinition({ ...def, allowedTools: [...def.allowedTools, 'Bash'] }),
    ).toThrow(/PERSONA_INVALID/);
  });

  it('loads a released prompt that matches the lock and composes with the base preamble', () => {
    const p = loadPrompt(def.name, undefined, { mode: 'production' });
    expect(p.version).toBe(def.promptRef.version);
    expect(p.status).toBe('released');
    expect(p.meta.tierHint).toBe(def.tierAlias);
    expect(p.body).not.toMatch(/\bcurl\b|\brm -rf\b|<script|union\s+select/i);
    const composed = `${fillPreamble(loadPrompt('_base').body, values)}\n${p.body}`;
    expect(composed).not.toMatch(/\{[A-Za-z][A-Za-z0-9]*\}/);
    expect(composed).toContain('v-saId');
    expect(fillPreamble(p.body, values)).toBe(p.body);
  });
});

describe('mentor specifics', () => {
  it('states that policy wins, never decides and never recommends destructive actions', () => {
    const body = loadPrompt('mentor').body;
    expect(body).toMatch(/Policy wins over your advice/);
    expect(body).toMatch(/Never recommend a `destructive` action/);
    expect(body).toMatch(/operator pause/);
    expect(body).toMatch(/too thin to judge/);
  });
});

describe('reflector specifics', () => {
  it('reads prior lessons but cannot write the journal itself', () => {
    expect(reflectorPersona.allowedTools).toContain('mcp__blackwing_journal__lessons_read');
    expect(reflectorPersona.allowedTools.some((t) => /journal__(?!lessons_read)/.test(t))).toBe(
      false,
    );
  });

  it('requires redaction of secrets and never invents a cause', () => {
    const body = loadPrompt('reflector').body;
    expect(body).toMatch(/Redact every secret/);
    expect(body).toMatch(/redacts known secret values before the journal write/);
    expect(body).toMatch(/Do not invent one/);
    expect(body).toMatch(/Never write a `destructive` action/);
  });
});
