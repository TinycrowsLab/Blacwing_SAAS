import { describe, expect, it } from 'vitest';

import { ValidationError } from '@blackwing/errors';

import {
  type ReconInputManifest,
  type ReconRequest,
  decideReconPlan,
  InvalidAssessmentModeError,
} from './mode-decision.js';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const SHA_C = 'c'.repeat(64);

const BUDGETS = { costCapUsd: 100, maxRequests: 10_000, maxDurationMs: 3_600_000 };

/** In scope: app.example.com, any one-label subdomain of lab.example.com, and 10.20.0.0/24. */
const RULES = {
  rules: [
    { effect: 'include' as const, host: 'app.example.com' },
    { effect: 'include' as const, host: '*.lab.example.com' },
    { effect: 'include' as const, cidr: '10.20.0.0/24' },
  ],
};

const request = (mode: string, overrides: Partial<ReconRequest> = {}): ReconRequest =>
  ({ mode, budgets: BUDGETS, scopeRules: RULES, ...overrides }) as ReconRequest;

const manifest = (overrides: Partial<ReconInputManifest> = {}): ReconInputManifest => ({
  suppliedTargets: [{ kind: 'url', value: 'https://app.example.com' }],
  specObjects: [],
  credentialRefs: [],
  sourceRepo: null,
  ...overrides,
});

type SpecObject = NonNullable<ReconInputManifest['specObjects']>[number];

const cleanOpenApi = (
  sha256 = SHA_A,
  coveredTargets: SpecObject['coveredTargets'] = [
    { kind: 'url', value: 'https://app.example.com' },
  ],
): SpecObject => ({
  kind: 'openapi',
  objectKey: 'specs/openapi.json',
  sha256,
  sizeBytes: 2048,
  status: 'clean',
  coveredTargets,
});

const personaNames = (plan: { personas: { persona: string }[] }): string[] =>
  plan.personas.map((p) => p.persona);

describe('decideReconPlan: mode matrix (CONTEXT_PACK §3.2 step 2)', () => {
  it('black box runs passive-recon, osint, active-recon and threat-intel, and skips nothing', () => {
    const plan = decideReconPlan(request('black'), manifest());
    expect(plan.mode).toBe('black');
    expect(personaNames(plan)).toEqual(['passive-recon', 'osint', 'active-recon', 'threat-intel']);
    expect(plan.skipped).toEqual([]);
    expect(plan.warnings).toEqual([]);
    const active = plan.personas.find((p) => p.persona === 'active-recon');
    expect(active?.inputs.scope).toBe('full-discovery');
    expect(active?.inputs.suppliedSurfaceCovered).toBe(false);
  });

  it('grey box with a clean OpenAPI covering every target skips black-box discovery and keeps the confirm steps', () => {
    const plan = decideReconPlan(
      request('grey'),
      manifest({
        specObjects: [cleanOpenApi()],
        credentialRefs: [{ role: 'user', secretRef: 'sec://user' }],
      }),
    );
    expect(personaNames(plan)).toEqual([
      'active-recon',
      'threat-intel',
      'source-spec-ingestion',
      'session-setup',
    ]);
    expect(plan.skipped.map((s) => s.persona)).toEqual(['passive-recon', 'osint']);
    for (const s of plan.skipped) expect(s.reason).toContain('F7');
    const active = plan.personas.find((p) => p.persona === 'active-recon');
    expect(active?.reason).toBe('grey box: active recon to confirm the supplied surface');
    expect(active?.inputs.suppliedSurfaceCovered).toBe(true);
    expect(active?.inputs.scope).toBe('full-discovery');
  });

  it('white box with a clean spec and credentials runs the ingestion set and a minimal active-recon', () => {
    const plan = decideReconPlan(
      request('white'),
      manifest({
        specObjects: [cleanOpenApi()],
        credentialRefs: [{ role: 'admin', secretRef: 'sec://admin' }],
      }),
    );
    expect(personaNames(plan)).toEqual([
      'source-spec-ingestion',
      'threat-intel',
      'session-setup',
      'active-recon',
    ]);
    expect(plan.skipped.map((s) => s.persona)).toEqual(['passive-recon', 'osint']);
    const active = plan.personas.find((p) => p.persona === 'active-recon');
    expect(active?.inputs.scope).toBe('confirm-deployed-surface');
    expect(active?.reason).toBe('white box: minimal active recon to confirm the deployed surface');
    const ingest = plan.personas.find((p) => p.persona === 'source-spec-ingestion');
    expect(ingest?.inputs.specObjects).toEqual([{ kind: 'openapi', sha256: SHA_A }]);
    expect(plan.personas.find((p) => p.persona === 'session-setup')?.inputs.roles).toEqual([
      'admin',
    ]);
  });

  it('white box with a spec that does not cover every target does not skip discovery (F7 needs full coverage)', () => {
    const plan = decideReconPlan(
      request('white'),
      manifest({
        suppliedTargets: [
          { kind: 'url', value: 'https://app.example.com' },
          { kind: 'host', value: 'other.lab.example.com' },
        ],
        specObjects: [cleanOpenApi()],
      }),
    );
    expect(plan.skipped).toEqual([
      { persona: 'session-setup', reason: 'no credential references supplied' },
    ]);
    expect(personaNames(plan)).toContain('source-spec-ingestion');
  });

  it('a clean spec for a different host does not count as coverage', () => {
    const plan = decideReconPlan(
      request('grey'),
      manifest({
        specObjects: [cleanOpenApi(SHA_A, [{ kind: 'host', value: 'elsewhere.example.net' }])],
      }),
    );
    expect(plan.skipped.map((s) => s.persona)).not.toContain('passive-recon');
  });

  it('a Postman or GraphQL spec counts as coverage, a HAR capture does not', () => {
    const postman = decideReconPlan(
      request('grey'),
      manifest({
        specObjects: [{ ...cleanOpenApi(SHA_B), kind: 'postman' }],
      }),
    );
    expect(postman.skipped.map((s) => s.persona)).toEqual([
      'passive-recon',
      'osint',
      'session-setup',
    ]);

    const har = decideReconPlan(
      request('grey'),
      manifest({ specObjects: [{ ...cleanOpenApi(SHA_B), kind: 'har' }] }),
    );
    expect(har.skipped.map((s) => s.persona)).not.toContain('passive-recon');
  });

  it('black box ignores coverage: its discovery personas always run', () => {
    const plan = decideReconPlan(request('black'), manifest({ specObjects: [cleanOpenApi()] }));
    expect(personaNames(plan)).toEqual(['passive-recon', 'osint', 'active-recon', 'threat-intel']);
    expect(plan.skipped).toEqual([]);
  });
});

describe('decideReconPlan: nothing supplied (edge cases)', () => {
  it('grey or white with no clean specs and no credentials falls back to confirm steps with reasons, never an empty plan', () => {
    for (const mode of ['grey', 'white']) {
      const plan = decideReconPlan(request(mode), manifest());
      expect(personaNames(plan)).toContain('active-recon');
      expect(personaNames(plan)).toContain('threat-intel');
      expect(plan.skipped).toEqual([
        { persona: 'source-spec-ingestion', reason: 'no spec or source object supplied' },
        { persona: 'session-setup', reason: 'no credential references supplied' },
      ]);
    }
  });

  it('white box with nothing supplied runs a full active discovery and warns about the fallback', () => {
    const plan = decideReconPlan(request('white'), manifest());
    const active = plan.personas.find((p) => p.persona === 'active-recon');
    expect(active?.inputs.scope).toBe('full-discovery');
    expect(active?.reason).toBe(
      'no supplied surface: full active discovery to confirm the surface',
    );
    expect(plan.warnings).toEqual(['RECON_MANIFEST_MISSING_FELL_BACK_TO_ACTIVE_RECON']);
  });

  it('a blocked spec object is excluded from source-spec-ingestion with a reason', () => {
    const plan = decideReconPlan(
      request('white'),
      manifest({ specObjects: [{ ...cleanOpenApi(SHA_C), status: 'blocked' }] }),
    );
    expect(personaNames(plan)).not.toContain('source-spec-ingestion');
    expect(plan.skipped).toContainEqual({
      persona: 'source-spec-ingestion',
      reason:
        'no clean spec or source object supplied; the supplied objects are excluded until they are scanned',
    });
    expect(plan.excluded.objects).toEqual([
      {
        kind: 'openapi',
        sha256: SHA_C,
        status: 'blocked',
        reason:
          'blocked spec object is excluded from source-spec-ingestion (only clean objects are fed)',
      },
    ]);
  });

  it('a pending_scan spec object is excluded too, and so is a source repository with no scan status', () => {
    const plan = decideReconPlan(
      request('white'),
      manifest({
        specObjects: [{ ...cleanOpenApi(SHA_B), status: 'pending_scan' }],
        sourceRepo: { url: 'https://git.example.com/app.git', ref: 'main' },
      }),
    );
    expect(personaNames(plan)).not.toContain('source-spec-ingestion');
    expect(plan.excluded.objects.map((o) => [o.kind, o.status])).toEqual([
      ['openapi', 'pending_scan'],
      ['source_repo', 'pending_scan'],
    ]);
  });

  it('a clean source repository alone feeds source-spec-ingestion', () => {
    const plan = decideReconPlan(
      request('white'),
      manifest({
        sourceRepo: { url: 'https://git.example.com/app.git', ref: 'main', status: 'clean' },
      }),
    );
    const ingest = plan.personas.find((p) => p.persona === 'source-spec-ingestion');
    expect(ingest?.reason).toBe(
      'ingest 0 clean spec object(s) and one clean source repository into the surface model',
    );
    expect(ingest?.inputs.sourceRepo).toMatchObject({
      url: 'https://git.example.com/app.git',
      ref: 'main',
    });
    expect(plan.excluded.objects).toEqual([]);
  });

  it('a blocked duplicate taints a clean copy with the same sha256 (fail closed)', () => {
    const plan = decideReconPlan(
      request('grey'),
      manifest({
        specObjects: [cleanOpenApi(SHA_A), { ...cleanOpenApi(SHA_A), status: 'blocked' }],
      }),
    );
    expect(personaNames(plan)).not.toContain('source-spec-ingestion');
    expect(plan.skipped.map((s) => s.persona)).not.toContain('passive-recon');
    expect(plan.excluded.objects).toHaveLength(1);
    expect(plan.excluded.objects[0]?.status).toBe('blocked');
  });

  it('identical clean duplicates count once', () => {
    const plan = decideReconPlan(
      request('white'),
      manifest({ specObjects: [cleanOpenApi(SHA_A), cleanOpenApi(SHA_A)] }),
    );
    expect(
      plan.personas.find((p) => p.persona === 'source-spec-ingestion')?.inputs.specObjects,
    ).toEqual([{ kind: 'openapi', sha256: SHA_A }]);
  });

  it('credential references feed session-setup by role only, with no secret in the plan', () => {
    const plan = decideReconPlan(
      request('grey'),
      manifest({
        credentialRefs: [
          { role: 'user', secretRef: 'sec://tenant/user-password' },
          { role: 'admin', secretRef: 'sec://tenant/admin-password' },
          { role: 'user', secretRef: 'sec://tenant/user-token' },
        ],
      }),
    );
    const session = plan.personas.find((p) => p.persona === 'session-setup');
    expect(session?.inputs.roles).toEqual(['admin', 'user']);
    expect(JSON.stringify(plan)).not.toContain('sec://');
  });
});

describe('decideReconPlan: targets and scope (SCOPE-002 is authoritative)', () => {
  it('drops targets outside the request scope with a reason and keeps the in-scope ones', () => {
    const plan = decideReconPlan(
      request('black'),
      manifest({
        suppliedTargets: [
          { kind: 'url', value: 'https://app.example.com/login' },
          { kind: 'url', value: 'https://evil.example.org' },
          { kind: 'cidr', value: '10.99.0.1/32' },
        ],
      }),
    );
    expect(plan.excluded.targets.map((t) => t.value)).toEqual([
      'https://evil.example.org/',
      '10.99.0.1/32',
    ]);
    for (const t of plan.excluded.targets)
      expect(t.reason).toMatch(/outside the request scope|default-deny/);
    const active = plan.personas.find((p) => p.persona === 'active-recon');
    expect(active?.inputs.targets).toEqual(['https://app.example.com/login']);
  });

  it('refuses malformed targets with a reason and never echoes credentials from a URL', () => {
    const plan = decideReconPlan(
      request('black'),
      manifest({
        suppliedTargets: [
          { kind: 'url', value: 'ftp://app.example.com' },
          { kind: 'url', value: 'https://admin:hunter2@app.example.com' },
          { kind: 'cidr', value: '10.20.0.0/16' },
          { kind: 'host', value: '10.20.0.5' },
          { kind: 'url', value: 'not a url' },
        ],
      }),
    );
    expect(plan.excluded.targets.map((t) => t.reason)).toEqual([
      'url scheme must be http or https',
      'url carries credentials',
      'cidr range wider than one address; list the addresses or hosts instead',
      'ip address: use kind cidr for addresses',
      'malformed url',
    ]);
    expect(JSON.stringify(plan)).not.toContain('hunter2');
  });

  it('canonicalises and de-duplicates targets before scoping', () => {
    const plan = decideReconPlan(
      request('black'),
      manifest({
        suppliedTargets: [
          { kind: 'url', value: 'HTTPS://APP.example.com:443/' },
          { kind: 'url', value: 'https://app.example.com' },
          { kind: 'host', value: 'App.Example.com.' },
        ],
      }),
    );
    expect(plan.excluded.targets).toEqual([]);
    const active = plan.personas.find((p) => p.persona === 'active-recon');
    expect(active?.inputs.targets).toEqual(['app.example.com', 'https://app.example.com/']);
  });

  it('a single-address cidr target is scoped by its address', () => {
    const plan = decideReconPlan(
      request('black'),
      manifest({ suppliedTargets: [{ kind: 'cidr', value: '10.20.0.7' }] }),
    );
    const active = plan.personas.find((p) => p.persona === 'active-recon');
    expect(active?.inputs.targets).toEqual(['10.20.0.7/32']);
    expect(plan.excluded.targets).toEqual([]);
  });

  it('with no in-scope target the plan still returns, with a warning rather than an empty silent plan', () => {
    const plan = decideReconPlan(request('black', { scopeRules: { rules: [] } }), manifest());
    expect(plan.warnings).toEqual(['RECON_NO_IN_SCOPE_TARGETS']);
    expect(plan.excluded.targets).toHaveLength(1);
    expect(personaNames(plan)).toContain('active-recon');
  });

  it('a supplied-target list that is empty is allowed and warns', () => {
    const plan = decideReconPlan(request('black'), manifest({ suppliedTargets: [] }));
    expect(plan.warnings).toEqual(['RECON_NO_IN_SCOPE_TARGETS']);
  });
});

describe('decideReconPlan: validation and failure modes', () => {
  it('rejects an unknown mode with SCOPE_INVALID_MODE before anything else is read', () => {
    for (const bad of ['red', '', 'BLACK', undefined, null, 42]) {
      expect(() => decideReconPlan({ mode: bad }, { not: 'a manifest' })).toThrow(
        InvalidAssessmentModeError,
      );
    }
    const error: unknown = (() => {
      try {
        decideReconPlan(request('purple'), manifest());
        return undefined;
      } catch (caught) {
        return caught;
      }
    })();
    expect(error).toBeInstanceOf(InvalidAssessmentModeError);
    expect(error).toHaveProperty('code', 'SCOPE_INVALID_MODE');
  });

  it('rejects a malformed request or manifest with VALIDATION_FAILED and a generic detail', () => {
    expect(() =>
      decideReconPlan(request('black', { budgets: { costCapUsd: -1 } as never }), manifest()),
    ).toThrow(ValidationError);
    expect(() =>
      decideReconPlan(request('black'), manifest({ specObjects: [{ kind: 'zip' } as never] })),
    ).toThrow(ValidationError);
    expect(() => decideReconPlan(request('black'), { suppliedTargets: 'x' })).toThrow(
      ValidationError,
    );
    expect(() =>
      decideReconPlan(
        request('black'),
        manifest({ sourceRepo: null, credentialRefs: [{ role: '', secretRef: 'x' }] }),
      ),
    ).toThrow(ValidationError);
  });

  it('rejects a spec with a malformed sha256 instead of counting it as coverage', () => {
    expect(() =>
      decideReconPlan(
        request('grey'),
        manifest({ specObjects: [{ ...cleanOpenApi(), sha256: 'not-a-digest' }] }),
      ),
    ).toThrow(ValidationError);
  });
});

describe('decideReconPlan: purity and determinism', () => {
  it('the same input gives an identical plan, and the input is never mutated', () => {
    const req = request('white');
    const man = manifest({
      specObjects: [cleanOpenApi(SHA_B), cleanOpenApi(SHA_A)],
      credentialRefs: [{ role: 'user', secretRef: 'sec://u' }],
    });
    const reqBefore = structuredClone(req);
    const manBefore = structuredClone(man);
    const first = decideReconPlan(req, man);
    const second = decideReconPlan(req, man);
    expect(second).toEqual(first);
    expect(req).toEqual(reqBefore);
    expect(man).toEqual(manBefore);
  });

  it('target and spec order in the manifest does not change the plan', () => {
    const targets = [
      { kind: 'url' as const, value: 'https://app.example.com' },
      { kind: 'cidr' as const, value: '10.20.0.9' },
      { kind: 'host' as const, value: 'x.lab.example.com' },
    ];
    const a = decideReconPlan(
      request('grey'),
      manifest({
        suppliedTargets: targets,
        specObjects: [cleanOpenApi(SHA_A), cleanOpenApi(SHA_B)],
      }),
    );
    const b = decideReconPlan(
      request('grey'),
      manifest({
        suppliedTargets: [...targets].reverse(),
        specObjects: [cleanOpenApi(SHA_B), cleanOpenApi(SHA_A)],
      }),
    );
    expect(b).toEqual(a);
  });

  it('pins the white-box plan shape (snapshot of the decision, not of the input)', () => {
    const plan = decideReconPlan(
      request('white'),
      manifest({
        specObjects: [cleanOpenApi()],
        credentialRefs: [{ role: 'user', secretRef: 'sec://u' }],
      }),
    );
    expect(plan.personas.map((p) => ({ persona: p.persona, reason: p.reason })))
      .toMatchInlineSnapshot(`
      [
        {
          "persona": "source-spec-ingestion",
          "reason": "ingest 1 clean spec object(s) and no clean source repository into the surface model",
        },
        {
          "persona": "threat-intel",
          "reason": "CVE/KEV/EPSS/GHSA/OSV enrichment for detected components",
        },
        {
          "persona": "session-setup",
          "reason": "log in and verify 1 role(s) from the supplied credential references",
        },
        {
          "persona": "active-recon",
          "reason": "white box: minimal active recon to confirm the deployed surface",
        },
      ]
    `);
  });
});
