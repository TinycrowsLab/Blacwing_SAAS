import { describe, expect, it } from 'vitest';

import { PERSONA_NAMES } from '@blackwing/agents';
import { AGENT_BRIEF_MAX_BYTES, AGENT_SESSION_PERSONAS } from '@blackwing/contracts';
import { AppError } from '@blackwing/errors';

import { parseSessionDescriptor } from './descriptor.js';

const TENANT = '01920000-0000-7000-8000-000000000001';
const RUN = '01920000-0000-7000-8000-000000000002';
const SESSION = '01920000-0000-7000-8000-000000000003';
const SHA = 'b'.repeat(64);
const TOKEN = 'bwrun_c2VjcmV0LXRva2VuLXZhbHVl.c2lnbmF0dXJl';

function descriptor(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    runId: RUN,
    sessionId: SESSION,
    tenantId: TENANT,
    persona: 'planner',
    personaVersion: '1.0.0',
    promptSha256: SHA,
    model: 'claude-haiku-5-5',
    effort: 'low',
    maxTurns: 10,
    maxBudgetUsd: 1,
    allowedTools: ['Read'],
    disallowedTools: ['WebFetch'],
    brief: 'Plan the next subtask.',
    envelopeHash: SHA,
    brokerBaseUrl: 'http://127.0.0.1:8080',
    brokerToken: TOKEN,
    modelGatewayBaseUrl: 'http://model-gateway.internal:8443',
    virtualKeyRef: 'vk-run-1',
    caBundlePath: '/etc/bw/ca.pem',
    workspaceDir: '/workspace/a',
    ...overrides,
  };
}

function rejectionOf(raw: string): AppError {
  try {
    parseSessionDescriptor(raw);
  } catch (error) {
    if (error instanceof AppError) return error;
  }
  throw new Error('expected an AppError');
}

describe('parseSessionDescriptor', () => {
  it('returns a valid descriptor with the brief and workspace kept verbatim', () => {
    const raw = JSON.stringify(
      descriptor({ brief: 'Résumé ✓ 日本語 — ünïcode', workspaceDir: '/workspace/sessão-日本' }),
    );
    const parsed = parseSessionDescriptor(raw);
    expect(parsed.brief).toBe('Résumé ✓ 日本語 — ünïcode');
    expect(parsed.workspaceDir).toBe('/workspace/sessão-日本');
    expect(parsed.persona).toBe('planner');
  });

  it.each(['brokerToken', 'envelopeHash', 'virtualKeyRef'] as const)(
    'rejects a descriptor missing %s before any session starts',
    (field) => {
      const input = Object.fromEntries(
        Object.entries(descriptor()).filter(([key]) => key !== field),
      );
      const error = rejectionOf(JSON.stringify(input));
      expect(error.code).toBe('VALIDATION_FAILED');
      expect(error.detail).toContain(field);
    },
  );

  it('names field paths in the detail but never a value', () => {
    const error = rejectionOf(JSON.stringify(descriptor({ brokerToken: 'not-a-token' })));
    expect(error.code).toBe('VALIDATION_FAILED');
    expect(error.detail).toContain('brokerToken');
    expect(`${error.message} ${error.detail ?? ''}`).not.toContain('not-a-token');
  });

  it('rejects malformed JSON with no leak of its content', () => {
    const error = rejectionOf('{"brokerToken": "bwrun_leaky"');
    expect(error.code).toBe('VALIDATION_FAILED');
    expect(`${error.message} ${error.detail ?? ''}`).not.toContain('bwrun_leaky');
  });

  it('rejects an empty document', () => {
    expect(rejectionOf('').code).toBe('VALIDATION_FAILED');
  });

  it('rejects a brief over 256 KiB with AGENT_BRIEF_TOO_LARGE, counting UTF-8 bytes', () => {
    // 3 bytes per character: fewer characters than the limit, but more bytes.
    const brief = '日'.repeat(Math.floor(AGENT_BRIEF_MAX_BYTES / 3) + 1);
    expect(brief.length).toBeLessThan(AGENT_BRIEF_MAX_BYTES);
    expect(rejectionOf(JSON.stringify(descriptor({ brief }))).code).toBe('AGENT_BRIEF_TOO_LARGE');
  });

  it('accepts a brief of exactly 256 KiB', () => {
    const brief = 'a'.repeat(AGENT_BRIEF_MAX_BYTES);
    expect(parseSessionDescriptor(JSON.stringify(descriptor({ brief }))).brief).toHaveLength(
      AGENT_BRIEF_MAX_BYTES,
    );
  });

  it('keeps the persona list equal to the Agent Registry', () => {
    expect([...AGENT_SESSION_PERSONAS]).toEqual([...PERSONA_NAMES]);
  });
});
