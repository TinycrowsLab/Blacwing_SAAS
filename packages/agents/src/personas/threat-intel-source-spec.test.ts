import { describe, expect, it } from 'vitest';

import { PREAMBLE_PLACEHOLDERS, fillPreamble, type PreamblePlaceholder } from '../base-preamble.js';
import { loadPersona, parsePersonaDefinition } from '../persona.js';
import { loadPrompt } from '../prompt.js';
import { SURFACE_UPSERT_TOOL, sourceSpecIngestionPersona } from './source-spec-ingestion.js';
import { threatIntelPersona } from './threat-intel.js';

const values = Object.fromEntries(PREAMBLE_PLACEHOLDERS.map((k) => [k, `v-${k}`])) as Record<
  PreamblePlaceholder,
  string
>;

const TARGET_TOOLS = ['mcp__blackwing__http_request', 'mcp__blackwing__tcp_probe'];
const NETWORKED_BUILTINS = ['Bash', 'WebFetch', 'WebSearch'];

describe.each([
  [threatIntelPersona, 'threat-intel', 'standard', 'medium', 30],
  [sourceSpecIngestionPersona, 'source-spec-ingestion', 'deep', 'high', 40],
] as const)('$name persona', (def, name, tier, effort, turns) => {
  it('validates, registers and matches the template fields', () => {
    expect(parsePersonaDefinition(structuredClone(def)).name).toBe(name);
    expect(loadPersona(name)).toBe(def);
    expect(def.tierAlias).toBe(tier);
    expect(def.effort).toBe(effort);
    expect(def.maxTurns).toBe(turns);
    expect(def.promptRef).toEqual({ persona: name, version: '1.0.0' });
  });

  it('is passive, never destructive, and submits nothing', () => {
    expect(def.intrusivenessCeiling).toBe('passive');
    expect(def.intrusivenessCeiling).not.toBe('destructive');
    expect(def.requiresSubmission).toBe(false);
    expect(def.declaredOracleTypes).toEqual([]);
  });

  it('never allows networked built-ins and disallows them explicitly', () => {
    for (const t of NETWORKED_BUILTINS) {
      expect(def.allowedTools).not.toContain(t);
      expect(def.disallowedTools).toContain(t);
    }
  });

  it('never allows target tools and disallows them', () => {
    for (const t of TARGET_TOOLS) {
      expect(def.allowedTools).not.toContain(t);
      expect(def.disallowedTools).toContain(t);
    }
  });

  it('has a released prompt skeleton that composes with the base preamble', () => {
    const prompt = loadPrompt(name);
    expect(prompt.version).toBe('1.0.0');
    expect(prompt.status).toBe('released');
    const composed = `${fillPreamble(loadPrompt('_base').body, values)}\n${prompt.body}`;
    expect(composed).not.toMatch(/\{[A-Za-z]+\}/);
    expect(composed).toContain('v-saId');
    expect(composed).toContain('untrusted');
    expect(prompt.body).toContain('Never');
  });
});

describe('threat-intel', () => {
  it('uses only intel tools', () => {
    expect(threatIntelPersona.allowedTools).toEqual(['mcp__blackwing_intel__*']);
    expect(
      threatIntelPersona.allowedTools.every((t) => t.startsWith('mcp__blackwing_intel__')),
    ).toBe(true);
  });

  it('maps to intelligence sources, CWE and A06 and never guesses a CVE', () => {
    const body = loadPrompt('threat-intel').body;
    for (const s of ['NVD', 'CISA KEV', 'EPSS', 'OSV', 'GHSA', 'CWE', 'A06']) {
      expect(body).toContain(s);
    }
    expect(body).toMatch(/record "no match"/);
    expect(body).toMatch(/Never guess a CVE/);
    expect(body).toMatch(/Never use EPSS as the only severity input/);
  });
});

describe('source-spec-ingestion', () => {
  it('reads mounted inputs and writes only through the surface upsert tool', () => {
    expect(sourceSpecIngestionPersona.allowedTools).toEqual([
      'Read',
      'Grep',
      'Glob',
      SURFACE_UPSERT_TOOL,
    ]);
    expect(SURFACE_UPSERT_TOOL).toBe('mcp__blackwing_surface__surface_upsert');
    for (const t of ['Write', 'Edit', 'Agent']) {
      expect(sourceSpecIngestionPersona.allowedTools).not.toContain(t);
    }
  });

  it('flags secrets without echoing or using them, and applies parse limits', () => {
    const body = loadPrompt('source-spec-ingestion').body;
    expect(body).toMatch(/Never echo its value/);
    expect(body).toMatch(/never use it/);
    expect(body).toMatch(/parse limit/);
    expect(body).toMatch(/never run code/);
  });
});
