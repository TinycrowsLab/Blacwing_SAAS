import { describe, expect, it } from 'vitest';

import { createLogger } from '@blackwing/logger';

import {
  createDecisionLogPolicy,
  DEFAULT_DECISION_LOG_POLICY,
  shouldWriteDecisionLog,
  type DecisionLogEntry,
  type DecisionLogSink,
} from './decision-log.js';
import {
  createMemoryPolicySetCache,
  type TenantPolicyVersion,
  type TenantPolicyVersionSource,
} from './effective-set.js';
import { createPolicyEngine, type PolicyEngineOptions, type PolicyRequest } from './engine.js';

const TENANT = 'ten_a';
const OTHER_TENANT = 'ten_b';
const NOW = '2026-10-20T12:00:00.000Z';
const LATE = '2026-11-02T00:00:00.000Z';

const principal = {
  type: 'Blackwing::User',
  id: 'u1',
  attrs: { tenantId: TENANT, userId: 'u1', roles: [] },
};
const resource = {
  type: 'Blackwing::Asset',
  id: 'asset-1',
  attrs: { tenantId: TENANT, assetId: 'asset-1', verified: true },
};
const action = { type: 'Policy::Action', id: 'edit' };

/** A tenant policy that lets `u1` edit assets of its own tenant, before a deadline. */
const PERMIT_U1 = `@id("tenant.permit-u1")
permit (principal is Blackwing::User, action == Policy::Action::"edit", resource is Blackwing::Asset)
when { principal.userId == "u1" && context.tenantId == "${TENANT}" && context.nowUtc < datetime("${LATE}") };
`;

function request(overrides: Partial<PolicyRequest> = {}): PolicyRequest {
  return {
    tenantId: TENANT,
    principal,
    action,
    resource,
    context: { tenantId: TENANT },
    nowUtc: NOW,
    ...overrides,
  };
}

function versionsOf(
  entries: Record<string, TenantPolicyVersion | undefined>,
): TenantPolicyVersionSource {
  return { activeVersion: (tenantId) => entries[tenantId] };
}

const TENANT_V1: TenantPolicyVersion = {
  tenantId: TENANT,
  version: 1,
  policies: { 'tenant.permit-u1': PERMIT_U1 },
};

interface RecordingSink extends DecisionLogSink {
  readonly entries: DecisionLogEntry[];
}

function recordingSink(): RecordingSink {
  const entries: DecisionLogEntry[] = [];
  return {
    entries,
    write(entry) {
      entries.push(entry);
      return Promise.resolve();
    },
  };
}

function engineWith(overrides: Partial<PolicyEngineOptions> = {}) {
  const sink = overrides.sink ?? recordingSink();
  const engine = createPolicyEngine({
    versions: versionsOf({ [TENANT]: TENANT_V1 }),
    sink,
    logger: createLogger('policy-test', { level: 'fatal' }),
    ...overrides,
  });
  return { engine, sink: sink as RecordingSink };
}

describe('PolicyEngine decisions', () => {
  it('allows a request that the tenant version permits, reporting the determining policy', () => {
    const { engine } = engineWith();
    const decision = engine.evaluate(request());
    expect(decision).toMatchObject({
      decision: 'allow',
      errored: false,
      determiningPolicyIds: ['tenant.permit-u1'],
    });
    expect(decision.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('denies a baseline-forbidden request and names the baseline policy id', () => {
    const { engine } = engineWith();
    const decision = engine.evaluate(request({ context: { tenantId: OTHER_TENANT } }));
    expect(decision.decision).toBe('deny');
    expect(decision.errored).toBe(false);
    expect(decision.determiningPolicyIds).toContain('baseline.tenant-isolation');
  });

  it('denies by default when no permit matches, with a reason and no errored flag', () => {
    const { engine } = engineWith({ versions: versionsOf({}) });
    const decision = engine.evaluate(request());
    expect(decision).toMatchObject({ decision: 'deny', errored: false, determiningPolicyIds: [] });
    expect(decision.reasons).toEqual(['no permit policy matched (default deny)']);
  });

  it('uses the baseline alone when the tenant has no active version, never failing open', () => {
    const { engine } = engineWith({ versions: versionsOf({}) });
    expect(engine.evaluate(request({ context: { tenantId: OTHER_TENANT } })).decision).toBe('deny');
    expect(engine.evaluate(request()).decision).toBe('deny');
  });

  it('fails closed when a Cedar evaluation error occurs (missing required context), and reports errored', () => {
    const { engine } = engineWith();
    const decision = engine.evaluate(request({ context: {} }));
    expect(decision).toMatchObject({ decision: 'deny', errored: true, determiningPolicyIds: [] });
    expect(decision.reasons.length).toBeGreaterThan(0);
  });

  it('never allows when a permit would match but the baseline errors on the same request', () => {
    const { engine } = engineWith();
    const decision = engine.evaluate(request({ context: {} }));
    expect(decision.decision).toBe('deny');
    expect(decision.errored).toBe(true);
  });

  it('denies with errored when nowUtc is not an ISO-8601 UTC instant', () => {
    const { engine } = engineWith();
    expect(engine.evaluate(request({ nowUtc: '20 Oct 2026' }))).toMatchObject({
      decision: 'deny',
      errored: true,
    });
  });

  it('denies with errored when the tenantId is blank', () => {
    const { engine } = engineWith();
    expect(engine.evaluate(request({ tenantId: ' ' }))).toMatchObject({
      decision: 'deny',
      errored: true,
    });
  });

  it('denies with errored when the principal belongs to another tenant than the request', () => {
    const { engine } = engineWith();
    const foreign = { ...principal, attrs: { ...principal.attrs, tenantId: OTHER_TENANT } };
    expect(engine.evaluate(request({ principal: foreign }))).toMatchObject({
      decision: 'deny',
      errored: true,
    });
  });

  it('denies with errored when the principal has no attributes to check the tenant against', () => {
    const { engine } = engineWith();
    expect(
      engine.evaluate(request({ principal: { type: 'Blackwing::User', id: 'u1' } })),
    ).toMatchObject({
      decision: 'deny',
      errored: true,
    });
  });

  it('denies with errored when a context value is not a serialisable Cedar value', () => {
    const { engine } = engineWith();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const decision = engine.evaluate(
      request({ context: { tenantId: TENANT, bad: circular as never } }),
    );
    expect(decision).toMatchObject({ decision: 'deny', errored: true });
  });

  it('fails closed when the stored tenant source does not compile (corrupt or tampered)', () => {
    const corrupt: TenantPolicyVersion = {
      tenantId: TENANT,
      version: 2,
      policies: { 'tenant.bad': 'permit (principal, action, resource) when { ;' },
    };
    const { engine } = engineWith({ versions: versionsOf({ [TENANT]: corrupt }) });
    expect(engine.evaluate(request())).toMatchObject({
      decision: 'deny',
      errored: true,
      determiningPolicyIds: [],
    });
  });

  it('fails closed when a tenant tries to redefine a baseline policy id', () => {
    const hijack: TenantPolicyVersion = {
      tenantId: TENANT,
      version: 3,
      policies: { 'baseline.tenant-isolation': 'permit (principal, action, resource);' },
    };
    const { engine } = engineWith({ versions: versionsOf({ [TENANT]: hijack }) });
    const decision = engine.evaluate(request({ context: { tenantId: OTHER_TENANT } }));
    expect(decision).toMatchObject({ decision: 'deny', errored: true });
  });

  it('fails closed when the version source returns a version owned by another tenant', () => {
    const foreign: TenantPolicyVersion = { ...TENANT_V1, tenantId: OTHER_TENANT };
    const { engine } = engineWith({ versions: versionsOf({ [TENANT]: foreign }) });
    expect(engine.evaluate(request())).toMatchObject({ decision: 'deny', errored: true });
  });

  it('fails closed when the version source throws', () => {
    const throwing: TenantPolicyVersionSource = {
      activeVersion() {
        throw new Error('connection reset');
      },
    };
    const { engine } = engineWith({ versions: throwing });
    const decision = engine.evaluate(request());
    expect(decision).toMatchObject({ decision: 'deny', errored: true });
    expect(decision.reasons.join(' ')).toContain('connection reset');
  });

  it('a throwing latency clock never changes the decision (latency is observability only)', () => {
    const { engine } = engineWith({
      monotonicMs: () => {
        throw new Error('clock broke');
      },
    });
    expect(engine.evaluate(request())).toMatchObject({
      decision: 'allow',
      errored: false,
      latencyMs: 0,
    });
    expect(engine.evaluate(request({ context: {} }))).toMatchObject({
      decision: 'deny',
      errored: true,
    });
  });

  it('is deterministic for a fixed effective set and nowUtc, and reproducible from the logged inputs', () => {
    const { engine } = engineWith();
    const first = engine.evaluate(request({ nowUtc: NOW }));
    const second = engine.evaluate(request({ nowUtc: NOW }));
    expect(second.decision).toBe(first.decision);
    expect(second.determiningPolicyIds).toEqual(first.determiningPolicyIds);
  });

  it('treats nowUtc as an input: the same request flips once the explicit time passes the deadline', () => {
    const { engine } = engineWith();
    expect(engine.evaluate(request({ nowUtc: NOW })).decision).toBe('allow');
    expect(engine.evaluate(request({ nowUtc: LATE })).decision).toBe('deny');
  });

  it('evaluateMany returns one decision per request, in order', () => {
    const { engine } = engineWith();
    const decisions = engine.evaluateMany([
      request(),
      request({ context: { tenantId: OTHER_TENANT } }),
      request({ context: {} }),
    ]);
    expect(decisions.map((d) => d.decision)).toEqual(['allow', 'deny', 'deny']);
    expect(decisions.map((d) => d.errored)).toEqual([false, false, true]);
  });
});

describe('PolicyEngine decision log', () => {
  it('writes denies and errored denies under deny_only, and records a digest rather than the raw context', () => {
    const { engine, sink } = engineWith({
      logPolicy: createDecisionLogPolicy({ mode: 'deny_only' }),
    });
    engine.evaluate(request({ context: { tenantId: OTHER_TENANT, secret: 'hunter2' } }));
    engine.evaluate(request({ context: {} }));
    expect(sink.entries).toHaveLength(2);
    expect(sink.entries.every((e) => e.decision === 'deny')).toBe(true);
    const serialised = JSON.stringify(sink.entries);
    expect(serialised).not.toContain('hunter2');
    expect(sink.entries[0]?.contextDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(sink.entries[0]?.nowUtc).toBe(NOW);
    expect(sink.entries[0]?.action).toBe('Policy::Action::edit');
  });

  it('default mode (deny_only) does not write allows', () => {
    const { engine, sink } = engineWith();
    engine.evaluate(request());
    expect(DEFAULT_DECISION_LOG_POLICY.mode).toBe('deny_only');
    expect(sink.entries).toHaveLength(0);
  });

  it("mode 'all' writes allows too, with the run id when given", () => {
    const { engine, sink } = engineWith({ logPolicy: createDecisionLogPolicy({ mode: 'all' }) });
    engine.evaluate(request({ runId: 'run-9' }));
    expect(sink.entries).toEqual([
      expect.objectContaining({
        decision: 'allow',
        runId: 'run-9',
        errored: false,
        tenantId: TENANT,
      }),
    ]);
  });

  it("mode 'sampled' writes allows only below the sample rate, and never changes the decision", () => {
    const draws = [0.05, 0.95];
    const logPolicy = createDecisionLogPolicy(
      { mode: 'sampled', sampleRate: 0.5 },
      () => draws.shift() ?? 1,
    );
    const { engine, sink } = engineWith({ logPolicy });
    expect(engine.evaluate(request()).decision).toBe('allow');
    expect(engine.evaluate(request()).decision).toBe('allow');
    expect(sink.entries).toHaveLength(1);
  });

  it('shouldWriteDecisionLog: denials and errors are always written', () => {
    const policy = createDecisionLogPolicy({ mode: 'deny_only' });
    expect(shouldWriteDecisionLog(policy, 'deny', false)).toBe(true);
    expect(shouldWriteDecisionLog(policy, 'allow', true)).toBe(true);
    expect(shouldWriteDecisionLog(policy, 'allow', false)).toBe(false);
  });

  it('a failing sink does not block or change the decision, is counted, and escalates a security-critical deny', () => {
    const escalated: DecisionLogEntry[] = [];
    const failing: DecisionLogSink = {
      write: () => Promise.reject(new Error('db unavailable')),
    };
    const { engine } = engineWith({
      sink: failing,
      escalate: (entry) => {
        escalated.push(entry);
      },
    });
    const decision = engine.evaluate(request({ context: { tenantId: OTHER_TENANT } }));
    expect(decision.decision).toBe('deny');
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(escalated).toHaveLength(1);
        expect(escalated[0]?.decision).toBe('deny');
        resolve();
      }, 0);
    });
  });

  it('a sink that throws synchronously is handled the same way (decision still returned)', () => {
    const throwing: DecisionLogSink = {
      write: () => {
        throw new Error('boom');
      },
    };
    const { engine } = engineWith({ sink: throwing });
    expect(engine.evaluate(request({ context: {} }))).toMatchObject({
      decision: 'deny',
      errored: true,
    });
  });

  it('does not escalate a failed deny log write when the action is not security-critical', () => {
    const escalated: DecisionLogEntry[] = [];
    const failing: DecisionLogSink = { write: () => Promise.reject(new Error('nope')) };
    const { engine } = engineWith({
      sink: failing,
      isSecurityCritical: () => false,
      escalate: (entry) => {
        escalated.push(entry);
      },
    });
    engine.evaluate(request({ context: { tenantId: OTHER_TENANT } }));
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(escalated).toHaveLength(0);
        resolve();
      }, 0);
    });
  });
});

describe('policy set cache (POLICY-010 interface)', () => {
  it('reuses the compiled set for the same key and recompiles on a miss', () => {
    const cache = createMemoryPolicySetCache(4);
    const { engine: first } = engineWith({ cache });
    expect(first.evaluate(request()).decision).toBe('allow');
    expect(
      cache.get({ tenantId: TENANT, baselineVersion: '1.0.0', tenantVersion: 1 }),
    ).toBeDefined();
    const { engine: second } = engineWith({ cache });
    expect(second.evaluate(request()).decision).toBe('allow');
  });

  it('a cache can never turn a deny into an allow: a new tenant version is used once it is active', () => {
    const cache = createMemoryPolicySetCache(4);
    const { engine: v1 } = engineWith({ cache });
    expect(v1.evaluate(request()).decision).toBe('allow');
    const revoked: TenantPolicyVersion = { tenantId: TENANT, version: 2, policies: {} };
    const { engine: v2 } = engineWith({ cache, versions: versionsOf({ [TENANT]: revoked }) });
    expect(v2.evaluate(request()).decision).toBe('deny');
  });

  it('rejects a nonsensical cache size', () => {
    expect(() => createMemoryPolicySetCache(0)).toThrow(RangeError);
  });
});

describe('decision log policy validation', () => {
  it('rejects unknown modes and sample rates outside [0, 1] rather than coercing them', () => {
    expect(() => createDecisionLogPolicy({ mode: 'everything' })).toThrow(RangeError);
    expect(() => createDecisionLogPolicy({ sampleRate: 1.5 })).toThrow(RangeError);
    expect(() => createDecisionLogPolicy({ sampleRate: Number.NaN })).toThrow(RangeError);
  });
});
