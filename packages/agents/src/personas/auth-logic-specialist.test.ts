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
import {
  authLogicSpecialistPersona as def,
  AUTH_LOGIC_SUBMIT_TOOL,
} from './auth-logic-specialist.js';
import { ORACLE_CATALOGUE } from './oracles.js';

const FORBIDDEN_NETWORK = ['WebFetch', 'WebSearch'];

describe('auth-logic-specialist persona definition', () => {
  it('validates, is registered and is in the fixed roster', () => {
    expect(PERSONA_NAMES).toContain('auth-logic-specialist');
    expect(parsePersonaDefinition(structuredClone(def)).name).toBe('auth-logic-specialist');
    expect(loadPersona('auth-logic-specialist')).toBe(def);
  });

  it('resolves deep to claude-opus-5-5 at high effort with an 80-turn ceiling', () => {
    expect(def.tierAlias).toBe('deep');
    expect(def.effort).toBe('high');
    expect(def.maxTurns).toBe(80);
    expect(resolveTier(def.tierAlias, 'anthropic')).toBe('claude-opus-5-5');
    expect(def.maxBudgetUsdDefault).toBeGreaterThan(0);
  });

  it('is capped at active_safe, never destructive, and requires submission', () => {
    expect(def.intrusivenessCeiling).toBe('active_safe');
    expect(def.intrusivenessCeiling).not.toBe('destructive');
    expect(def.requiresSubmission).toBe(true);
  });

  it('declares the access-matrix and status-diff oracles, each from the catalogue', () => {
    expect(def.declaredOracleTypes).toEqual(
      expect.arrayContaining(['access_matrix', 'status_diff']),
    );
    for (const t of def.declaredOracleTypes) {
      expect((ORACLE_CATALOGUE as readonly string[]).includes(t)).toBe(true);
    }
  });

  it('allows role-switching session tools, target tools and submit_candidate by exact name', () => {
    expect(def.allowedTools).toEqual(
      expect.arrayContaining([
        'mcp__blackwing_session__use_role',
        'mcp__blackwing_session__check_session',
        'mcp__blackwing_target__http_request',
        'mcp__blackwing_target__http_batch',
        'mcp__blackwing_oob__*',
        'mcp__blackwing_journal__*',
        AUTH_LOGIC_SUBMIT_TOOL,
      ]),
    );
    for (const t of def.allowedTools) {
      expect(t).toMatch(/^(Bash|mcp__[a-z_]+__[a-z_*]+)$/);
    }
  });

  it('disallows the networked built-ins and never allows them in allowedTools', () => {
    for (const t of FORBIDDEN_NETWORK) {
      expect(def.disallowedTools).toContain(t);
      expect(def.allowedTools).not.toContain(t);
    }
  });

  it('rejects a mutated definition that allows WebFetch or a destructive ceiling', () => {
    expect(
      personaDefinitionSchema.safeParse({
        ...structuredClone(def),
        allowedTools: [...def.allowedTools, 'WebFetch'],
      }).success,
    ).toBe(false);
    expect(
      personaDefinitionSchema.safeParse({
        ...structuredClone(def),
        intrusivenessCeiling: 'destructive',
      }).success,
    ).toBe(false);
  });

  it('keeps the prompt reference aligned with the released 1.0.0 skeleton', () => {
    expect(def.promptRef).toEqual({ persona: 'auth-logic-specialist', version: '1.0.0' });
  });
});

describe('auth-logic-specialist prompt skeleton', () => {
  const prompt = loadPrompt('auth-logic-specialist', undefined, { mode: 'production' });

  it('loads hash-verified as released and composes with the base preamble', () => {
    expect(prompt.version).toBe('1.0.0');
    expect(prompt.status).toBe('released');
    expect(prompt.meta.tierHint).toBe(def.tierAlias);
    const values = Object.fromEntries(PREAMBLE_PLACEHOLDERS.map((k) => [k, `v-${k}`])) as Record<
      PreamblePlaceholder,
      string
    >;
    const composed = `${fillPreamble(loadPrompt('_base').body, values)}\n${prompt.body}`;
    expect(composed).not.toMatch(/\{[A-Za-z][A-Za-z0-9]*\}/);
    expect(composed).toContain('v-saId');
  });

  it('cites standard IDs for the mandate and the required authorisation classes', () => {
    for (const id of [
      'A01',
      'API01',
      'API05',
      'CWE-639',
      'CWE-862',
      'CWE-269',
      'WSTG-BUSL',
      'CWE-362',
    ]) {
      expect(prompt.body).toContain(id);
    }
  });

  it('states the edge-case rules: negative control, role sessions, race gating, no judging', () => {
    expect(prompt.body).toMatch(/negative control/);
    expect(prompt.body).toMatch(/not confirmable/);
    expect(prompt.body).toMatch(/Cross-role access needs two valid role sessions/);
    expect(prompt.body).toMatch(/Race conditions are `state_changing`/);
    expect(prompt.body).toMatch(/reversal-journal entry/);
    expect(prompt.body).toMatch(/never decide whether a candidate is a finding|You never decide/);
    expect(prompt.body).toMatch(/untrusted/);
    expect(prompt.body).toMatch(/Never send destructive traffic/);
  });

  it('contains no exploit payloads or attack walkthroughs', () => {
    expect(prompt.body).not.toMatch(/<script|union\s+select|\bcurl\b|\brm -rf\b|' or 1=1/i);
    expect(prompt.body).not.toMatch(/WebFetch|WebSearch/);
  });
});
