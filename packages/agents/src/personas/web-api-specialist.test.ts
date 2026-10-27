import { describe, expect, it } from 'vitest';

import { PREAMBLE_PLACEHOLDERS, fillPreamble, type PreamblePlaceholder } from '../base-preamble.js';
import { composePrompt } from '../compose.js';
import { loadPersona, parsePersonaDefinition, personaDefinitionSchema } from '../persona.js';
import { loadPrompt } from '../prompt.js';
import { ORACLE_CATALOGUE } from './oracles.js';
import {
  WEB_API_HELPERS,
  WEB_API_ORACLE_TYPES,
  webApiSpecialistPersona as def,
} from './web-api-specialist.js';

const FORBIDDEN = ['WebFetch', 'WebSearch'];

describe('web-api-specialist persona', () => {
  it('validates, registers and resolves tier, effort and step ceiling', () => {
    expect(parsePersonaDefinition(structuredClone(def))).toEqual(def);
    expect(loadPersona('web-api-specialist')).toBe(def);
    expect(def.tierAlias).toBe('deep');
    expect(def.effort).toBe('high');
    expect(def.maxTurns).toBe(80);
    expect(def.maxBudgetUsdDefault).toBeGreaterThan(0);
  });

  it('is capped at active_safe, never destructive, and requires submission', () => {
    expect(def.intrusivenessCeiling).toBe('active_safe');
    expect(def.intrusivenessCeiling).not.toBe('destructive');
    expect(def.requiresSubmission).toBe(true);
  });

  it('declares exactly the marker, status-diff, out-of-band, error-signature and header-flag oracles', () => {
    expect([...def.declaredOracleTypes].sort()).toEqual(
      ['reflected_marker', 'status_diff', 'out_of_band', 'error_signature', 'header_flag'].sort(),
    );
    expect(def.declaredOracleTypes).toEqual([...WEB_API_ORACLE_TYPES]);
    for (const t of def.declaredOracleTypes) {
      expect(ORACLE_CATALOGUE).toContain(t);
    }
  });

  it('allows exactly the detection tools, with submit_candidate and the oob, journal and browser tools', () => {
    expect(def.allowedTools).toEqual([
      'Bash',
      'mcp__blackwing_target__http_request',
      'mcp__blackwing_target__http_batch',
      'mcp__playwright__*',
      'mcp__blackwing_oob__oob_allocate',
      'mcp__blackwing_oob__oob_check',
      'mcp__blackwing_journal__*',
      'mcp__blackwing_findings__submit_candidate',
      'mcp__blackwing_findings__attach_evidence',
    ]);
    expect(def.allowedTools).toContain('mcp__blackwing_findings__submit_candidate');
  });

  it('disallows WebFetch and WebSearch and never allows them', () => {
    for (const t of FORBIDDEN) {
      expect(def.disallowedTools).toContain(t);
      expect(def.allowedTools).not.toContain(t);
    }
  });

  it('declares the payload-crafter and response-differ helpers under the same forbidden-tool rule', () => {
    expect(def.helpers?.map((h) => h.name)).toEqual(['payload-crafter', 'response-differ']);
    for (const helper of WEB_API_HELPERS) {
      expect(helper.allowedTools).toEqual([]);
    }
    for (const helper of def.helpers ?? []) {
      for (const t of helper.allowedTools) {
        expect(def.allowedTools).toContain(t);
        expect(FORBIDDEN).not.toContain(t);
      }
    }
  });

  it('cannot be redefined to allow a networked built-in, in the persona or in a helper', () => {
    const personaBad = { ...structuredClone(def), allowedTools: [...def.allowedTools, 'WebFetch'] };
    expect(personaDefinitionSchema.safeParse(personaBad).success).toBe(false);

    const helperBad = structuredClone(def);
    helperBad.helpers = [{ ...WEB_API_HELPERS[0], allowedTools: ['WebSearch'] }];
    const result = personaDefinitionSchema.safeParse(helperBad);
    expect(result.success).toBe(false);
  });

  it('cannot be redefined to a destructive ceiling', () => {
    const destructive = { ...structuredClone(def), intrusivenessCeiling: 'destructive' };
    expect(personaDefinitionSchema.safeParse(destructive).success).toBe(false);
  });
});

describe('web-api-specialist prompt', () => {
  const prompt = loadPrompt('web-api-specialist');

  it('is a released, hash-verified prompt that matches the definition', () => {
    expect(prompt.version).toBe(def.promptRef.version);
    expect(prompt.status).toBe('released');
  });

  it('cites the owned classes by standard identifier', () => {
    for (const id of [
      'CWE-89',
      'WSTG-INPV-05',
      'CWE-79',
      'CWE-918',
      'WSTG-INPV-19',
      'CWE-611',
      'WSTG-INPV-07',
      'CWE-1336',
      'WSTG-INPV-18',
      'CWE-22',
      'WSTG-ATHZ-01',
      'WSTG-CLNT-07',
      'WSTG-APIT',
      'API3',
      'CWE-915',
      'WSTG-BUSL-09',
    ]) {
      expect(prompt.body).toContain(id);
    }
  });

  it('states the no-self-confirmation, oracle-binding and negative-control rules', () => {
    expect(prompt.body).toMatch(/never confirm a finding yourself/);
    expect(prompt.body).toMatch(/negative control/);
    expect(prompt.body).toMatch(/out-of-band/);
    expect(prompt.body).toMatch(/submit_candidate/);
  });

  it('keeps the ceiling and the untrusted-data rule', () => {
    expect(prompt.body).toMatch(/`active_safe`/);
    expect(prompt.body).toMatch(/Never send `state_changing` or `destructive`/);
    expect(prompt.body).toMatch(/untrusted data/);
    expect(prompt.body).toMatch(/no web fetch and no web search/);
  });

  it('contains no payload lists or exploit material', () => {
    expect(prompt.body).not.toMatch(
      /<script|union\s+select|\bcurl\b|\brm -rf\b|' or 1=1|\.\.\/\.\.\//i,
    );
  });

  it('composes with the base preamble without leaving placeholders', () => {
    const values = Object.fromEntries(PREAMBLE_PLACEHOLDERS.map((k) => [k, `v-${k}`])) as Record<
      PreamblePlaceholder,
      string
    >;
    const composed = `${fillPreamble(loadPrompt('_base').body, values)}\n${prompt.body}`;
    expect(composed).not.toMatch(/\{[A-Za-z]+\}/);
    expect(composed).toContain('v-saId');
    expect(composed).toContain('# Web and API specialist');
  });

  it('composes into a system prompt that carries the authorisation context', () => {
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
    expect(composed.systemPrompt).toContain('untrusted');
  });
});
