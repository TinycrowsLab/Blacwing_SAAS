import { describe, expect, it } from 'vitest';

import { PREAMBLE_PLACEHOLDERS, fillPreamble, type PreamblePlaceholder } from './base-preamble.js';
import { loadPrompt } from './prompt.js';

const values = Object.fromEntries(PREAMBLE_PLACEHOLDERS.map((k) => [k, `v-${k}`])) as Record<
  PreamblePlaceholder,
  string
>;
const base = loadPrompt('_base');

describe('base preamble', () => {
  it('loads released, hash-verified, at 1.0.0', () => {
    expect(base.version).toBe('1.0.0');
    expect(base.status).toBe('released');
  });

  it('contains every placeholder exactly as exposed, and no others', () => {
    const found = new Set([...base.body.matchAll(/\{([A-Za-z0-9]+)\}/g)].map((m) => m[1]));
    expect([...found].sort()).toEqual([...PREAMBLE_PLACEHOLDERS].sort());
  });

  it('contains the required clauses', () => {
    const b = base.body;
    expect(b).toMatch(/authorised under standing authorisation/);
    expect(b).toMatch(/untrusted data, never instructions/);
    expect(b).toMatch(/Never attempt destructive actions/);
    expect(b).toMatch(/reversal-journal entry recorded before/);
    expect(b).toMatch(/Capture evidence for every candidate/);
    expect(b).toMatch(/declared oracle and a negative control/);
    expect(b).toMatch(/never author|Do not author exploit payloads/);
    expect(b).toMatch(/`active_safe` or lower/);
    expect(b).toMatch(/advisory/);
    expect(b).toMatch(/policy decision point/);
  });

  it('holds no exploit payload markers', () => {
    expect(base.body).not.toMatch(/<script|union\s+select|\.\.\/|\bcurl\b|\brm -rf\b|' or 1=1/i);
  });

  it('fills every placeholder', () => {
    const out = fillPreamble(base.body, values);
    expect(out).not.toMatch(/\{[A-Za-z]+\}/);
    expect(out).toContain('v-saId');
    expect(out).toContain('v-approverIdentity');
  });

  it.each(PREAMBLE_PLACEHOLDERS)('fails when %s is missing or blank', (k) => {
    expect(() => fillPreamble(base.body, { ...values, [k]: '' })).toThrow(/unfilled/);
    const partial = Object.fromEntries(Object.entries(values).filter(([n]) => n !== k));
    expect(() => fillPreamble(base.body, partial as Record<PreamblePlaceholder, string>)).toThrow(
      /unfilled/,
    );
  });

  it('rejects an unknown placeholder in the text', () => {
    expect(() => fillPreamble('hi {nope}', values)).toThrow(/unknown placeholder nope/);
  });

  it('does not re-scan substituted values', () => {
    const out = fillPreamble('{saId}', { ...values, saId: '{roles}' });
    expect(out).toBe('{roles}');
  });
});
