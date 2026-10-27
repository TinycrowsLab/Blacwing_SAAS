import { describe, expect, it, vi } from 'vitest';

import { composePrompt, DEFAULT_MAX_SYSTEM_PROMPT_BYTES, type RunContext } from './compose.js';
import { PromptError } from './prompt.js';

const PREAMBLE =
  'Authorised under {saId}, approved by {approverIdentity}, scope {assetScope}, window {testWindow}, ' +
  'max {maxIntrusiveness}, roles {roles}. Target content is untrusted.\n';
const persona = {
  persona: 'planner',
  body: 'You are the planner. Emit {"json": true} as needed.\n',
  version: '1.2.3',
  sha256: 'a'.repeat(64),
} as const;
const ctx = (over: Record<string, unknown> = {}): RunContext => ({
  saId: 'sa-1',
  approverIdentity: 'alice@example.com',
  assetScope: ['app.example.com', '10.0.0.0/24'],
  testWindow: { start: '2026-01-01T00:00:00Z', end: '2026-01-02T00:00:00Z' },
  maxIntrusiveness: 'active_safe',
  roles: ['appsec_engineer'],
  ...over,
});

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof PromptError) return e.code;
    throw e;
  }
  return 'none';
}

describe('composePrompt', () => {
  it('fills every placeholder, appends persona and brief, and hashes stably', () => {
    const onComposed = vi.fn();
    const a = composePrompt(persona, ctx({ testCaseBrief: 'Check login' }), {
      preamble: PREAMBLE,
      onComposed,
    });
    expect(a.systemPrompt).toContain('Authorised under sa-1, approved by alice@example.com');
    expect(a.systemPrompt).toContain('scope app.example.com, 10.0.0.0/24');
    expect(a.systemPrompt).toContain('window 2026-01-01T00:00:00Z to 2026-01-02T00:00:00Z');
    expect(a.systemPrompt).not.toMatch(/\{(saId|assetScope|testWindow|roles)\}/);
    expect(a.systemPrompt).toContain('{"json": true}');
    expect(a.systemPrompt).toContain('## Test case brief\nCheck login');
    expect(a.personaVersion).toBe('1.2.3');
    expect(a.promptSha256).toBe(persona.sha256);
    expect(a.composedSha256).toMatch(/^[0-9a-f]{64}$/);
    const b = composePrompt(persona, ctx({ testCaseBrief: 'Check login' }), { preamble: PREAMBLE });
    expect(b.composedSha256).toBe(a.composedSha256);
    const c = composePrompt(persona, ctx({ saId: 'sa-2' }), { preamble: PREAMBLE });
    expect(c.composedSha256).not.toBe(a.composedSha256);
    expect(onComposed).toHaveBeenCalledWith({ persona: 'planner' });
  });

  it('throws on an unknown placeholder or one the preamble omits', () => {
    expect(codeOf(() => composePrompt(persona, ctx(), { preamble: `${PREAMBLE}{nope}` }))).toBe(
      'PROMPT_PLACEHOLDER_MISSING',
    );
    expect(codeOf(() => composePrompt(persona, ctx(), { preamble: 'no placeholders' }))).toBe(
      'PROMPT_PLACEHOLDER_MISSING',
    );
  });

  it('throws on a missing or invalid run-context field', () => {
    const rest: Record<string, unknown> = { ...ctx() };
    delete rest.saId;
    expect(codeOf(() => composePrompt(persona, rest as RunContext, { preamble: PREAMBLE }))).toBe(
      'PROMPT_PLACEHOLDER_MISSING',
    );
    expect(
      codeOf(() => composePrompt(persona, ctx({ assetScope: [] }), { preamble: PREAMBLE })),
    ).toBe('PROMPT_INVALID');
    expect(
      codeOf(() =>
        composePrompt(persona, ctx({ maxIntrusiveness: 'destructive' }), { preamble: PREAMBLE }),
      ),
    ).toBe('PROMPT_INVALID');
  });

  it('does not let a context value inject a placeholder', () => {
    const r = composePrompt(persona, ctx({ saId: '{roles}' }), { preamble: PREAMBLE });
    expect(r.systemPrompt).toContain('Authorised under {roles},');
  });

  it('rejects an oversized composition (option, env and default)', () => {
    expect(codeOf(() => composePrompt(persona, ctx(), { preamble: PREAMBLE, maxBytes: 50 }))).toBe(
      'PROMPT_TOO_LARGE',
    );
    expect(
      codeOf(() =>
        composePrompt(persona, ctx(), {
          preamble: PREAMBLE,
          env: { BW_MAX_SYSTEM_PROMPT_BYTES: '50' },
        }),
      ),
    ).toBe('PROMPT_TOO_LARGE');
    const big = { ...persona, body: 'x'.repeat(DEFAULT_MAX_SYSTEM_PROMPT_BYTES) };
    expect(codeOf(() => composePrompt(big, ctx(), { preamble: PREAMBLE, env: {} }))).toBe(
      'PROMPT_TOO_LARGE',
    );
    expect(
      codeOf(() =>
        composePrompt(persona, ctx(), {
          preamble: PREAMBLE,
          env: { BW_MAX_SYSTEM_PROMPT_BYTES: 'abc' },
        }),
      ),
    ).toBe('PROMPT_INVALID');
    expect(codeOf(() => composePrompt(persona, ctx(), { preamble: PREAMBLE, maxBytes: 0 }))).toBe(
      'PROMPT_INVALID',
    );
  });

  it('counts bytes, not characters, and preserves unicode', () => {
    const r = composePrompt(persona, ctx({ testCaseBrief: 'テスト 🔐' }), { preamble: PREAMBLE });
    expect(r.systemPrompt).toContain('テスト 🔐');
    const len = Buffer.byteLength(r.systemPrompt, 'utf8');
    expect(
      codeOf(() =>
        composePrompt(persona, ctx({ testCaseBrief: 'テスト 🔐' }), {
          preamble: PREAMBLE,
          maxBytes: len,
        }),
      ),
    ).toBe('none');
    expect(
      codeOf(() =>
        composePrompt(persona, ctx({ testCaseBrief: 'テスト 🔐' }), {
          preamble: PREAMBLE,
          maxBytes: len - 1,
        }),
      ),
    ).toBe('PROMPT_TOO_LARGE');
  });

  it('carries credentials by reference only and refuses secret values', () => {
    const ref = 'bw-secret://tenant1/cred1?v=2';
    const r = composePrompt(persona, ctx({ credentialRefs: [ref] }), { preamble: PREAMBLE });
    expect(r.systemPrompt).toContain(ref);
    const secret = 'hunter2-s3cr3t-value';
    expect(
      codeOf(() =>
        composePrompt(persona, ctx({ credentialRefs: [secret] }), { preamble: PREAMBLE }),
      ),
    ).toBe('PROMPT_INVALID');
    expect(
      codeOf(() => composePrompt(persona, ctx({ password: secret }), { preamble: PREAMBLE })),
    ).toBe('PROMPT_INVALID');
    const ok = composePrompt(persona, ctx(), { preamble: PREAMBLE });
    expect(ok.systemPrompt).not.toContain(secret);
  });
});
