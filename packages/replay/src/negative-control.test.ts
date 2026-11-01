import { describe, expect, it, vi } from 'vitest';

import { replaySpecSchema, type ReplaySpec } from '@blackwing/contracts';
import { ScopeViolationError } from '@blackwing/errors';

import { createOracleDispatcher } from './dispatch.js';
import {
  type AuthorisationGate,
  type Egress,
  type EvidenceCapture,
  type EvidenceReader,
  ReplayEngine,
  type ReplayEngineDeps,
  type Sandbox,
  type SandboxProvider,
  type RawObservation,
  type ReplayStatus,
} from './engine.js';
import {
  type NegativeControlAuditEvent,
  type NegativeControlDeps,
  type NegativeControlMetrics,
  type NegativeControlSpec,
  runWithNegativeControl,
} from './negative-control.js';
import { bodyDigest } from './oracle.js';
import { createDeterministicEvaluators } from './oracles/index.js';

const DIGEST = `sha256:${'a'.repeat(64)}`;
const SHA = 'b'.repeat(64);
const ASSET = '0190a000-0000-7000-8000-000000000003';
const SPEC_ID = '0190a000-0000-7000-8000-000000000001';
const CANDIDATE_ID = '0190a000-0000-7000-8000-000000000002';
const TEST_CASE_ID = '0190a000-0000-7000-8000-000000000004';
const PROBE_URL = 'http://127.0.0.1:13000/rest/products/search?q=a%27';
const CONTROL_URL = 'http://127.0.0.1:13000/rest/products/search?q=apple';
const SIGNATURE = 'SQLITE_ERROR';
const FIRED_BODY = 'SQLITE_ERROR: near "a"';
const CLEAN_BODY = 'ok';

const PINS = {
  modelIds: ['claude-haiku-5-5'],
  personaPromptHashes: {},
  sdkVersion: '1.0.0',
  claudeCodeVersion: '1.0.0',
  sandboxImageDigest: DIGEST,
  toolVersions: {},
  nucleiTemplateCommit: 'c'.repeat(40),
  policyHash: SHA,
  envelopeHash: SHA,
  priceTableVersion: '1',
};

/** A valid spec with a negative control. Tests derive the missing or empty variants from it. */
function specFixture(): ReplaySpec {
  const endpoint = (urlTemplate: string) => ({ assetId: ASSET, urlTemplate });
  return replaySpecSchema.parse({
    id: SPEC_ID,
    candidateId: CANDIDATE_ID,
    testCaseId: TEST_CASE_ID,
    intrusivenessClass: 'active_safe',
    targets: [endpoint(PROBE_URL)],
    steps: [
      {
        kind: 'http_request',
        method: 'GET',
        endpoint: endpoint(PROBE_URL),
        roleKey: 'anonymous',
        inputRef: null,
      },
    ],
    oracle: {
      type: 'error_signature',
      declaredAt: '2026-10-01T00:00:00.000Z',
      params: { signatures: [SIGNATURE] },
    },
    testStartedAt: '2026-10-02T00:00:00.000Z',
    negativeControl: {
      strategy: 'benign_value',
      steps: [
        {
          kind: 'http_request',
          method: 'GET',
          endpoint: endpoint(CONTROL_URL),
          roleKey: 'anonymous',
          inputRef: null,
        },
      ],
    },
    pins: PINS,
    inputsRef: [],
  });
}

/** A recorded observation for one replay: a completed probe carries one exchange with `body`. */
function observation(status: ReplayStatus, body: string, replayId: string): RawObservation {
  const completed = status === 'completed';
  return {
    replayId,
    candidateId: CANDIDATE_ID,
    testCaseId: TEST_CASE_ID,
    oracleType: 'error_signature',
    status,
    exchanges: completed
      ? [
          {
            stepIndex: 0,
            kind: 'http_request',
            status: 500,
            body,
            bodySha256: bodyDigest(body),
            truncated: false,
            evidenceRef: `evidence/${replayId}`,
          },
        ]
      : [],
    evidenceRefs: completed ? [`evidence/${replayId}`] : [],
    replayMs: 1,
    attempts: 1,
    pins: PINS,
  };
}

type Run = (spec: ReplaySpec) => Promise<RawObservation>;

/** A fake engine that answers by the spec's endpoint: the probe URL and the control URL get their own result. */
function fakeEngine(answers: { positive: Run; negative: Run }) {
  return {
    run: vi.fn((spec: ReplaySpec) => {
      const endpoint = spec.steps[0];
      const isControl =
        endpoint?.kind === 'http_request' && endpoint.endpoint.urlTemplate === CONTROL_URL;
      return isControl ? answers.negative(spec) : answers.positive(spec);
    }),
  };
}

const firedRun: Run = (spec) => Promise.resolve(observation('completed', FIRED_BODY, spec.id));
const cleanRun: Run = (spec) => Promise.resolve(observation('completed', CLEAN_BODY, spec.id));

function deps(engine: NegativeControlDeps['engine'], overrides: Partial<NegativeControlDeps> = {}) {
  const record = vi.fn<(event: NegativeControlAuditEvent) => Promise<void>>(() =>
    Promise.resolve(),
  );
  const audit = { record };
  const metrics: NegativeControlMetrics = {
    negativeControlRun: vi.fn(),
    confirmRule: vi.fn(),
  };
  const built: NegativeControlDeps = {
    engine,
    dispatch: createOracleDispatcher(createDeterministicEvaluators()),
    audit,
    metrics,
    ...overrides,
  };
  return { deps: built, record, metrics };
}

describe('runWithNegativeControl: the confirm rule', () => {
  // Truth table: confirmable = positiveFired && negativeControlClean.
  it.each([
    ['positive fires, negative clean', firedRun, cleanRun, true, true],
    ['positive fires, negative also fires', firedRun, firedRun, true, false],
    ['positive does not fire, negative clean', cleanRun, cleanRun, false, true],
    ['positive does not fire, negative fires', cleanRun, firedRun, false, false],
  ] as const)('%s', async (_name, positive, negative, positiveFired, negativeControlClean) => {
    const { deps: d } = deps(fakeEngine({ positive, negative }));
    const result = await runWithNegativeControl(specFixture(), d);

    expect(result.positiveFired).toBe(positiveFired);
    expect(result.negativeControlClean).toBe(negativeControlClean);
    expect(result.confirmable).toBe(positiveFired && negativeControlClean);
    expect(result.outcome).toBe(positiveFired && negativeControlClean ? 'confirmed' : 'suspected');
  });

  it('confirms only when the positive fires and the negative control is clean, with no reasons', async () => {
    const { deps: d } = deps(fakeEngine({ positive: firedRun, negative: cleanRun }));
    const result = await runWithNegativeControl(specFixture(), d);

    expect(result).toMatchObject({
      candidateId: CANDIDATE_ID,
      positiveFired: true,
      negativeControlClean: true,
      confirmable: true,
      outcome: 'confirmed',
      reasons: [],
    });
  });

  it('marks a candidate Suspected with the negative reason when the control also fires, keeping both evidences', async () => {
    const { deps: d } = deps(fakeEngine({ positive: firedRun, negative: firedRun }));
    const result = await runWithNegativeControl(specFixture(), d);

    expect(result.confirmable).toBe(false);
    expect(result.outcome).toBe('suspected');
    expect(result.reasons).toEqual(['negative_control_fired']);
    expect(result.positive.evidenceRefs).toHaveLength(1);
    expect(result.negative?.evidenceRefs).toHaveLength(1);
    expect(result.negative?.evidenceRefs[0]).not.toBe(result.positive.evidenceRefs[0]);
  });

  it('marks a candidate Suspected when the positive does not fire, and reports why', async () => {
    const { deps: d } = deps(fakeEngine({ positive: cleanRun, negative: cleanRun }));
    const result = await runWithNegativeControl(specFixture(), d);

    expect(result.outcome).toBe('suspected');
    expect(result.reasons).toEqual(['positive_not_fired']);
  });
});

describe('runWithNegativeControl: fail-closed negative control', () => {
  it('treats a missing negative control as non-confirmable, without dropping the candidate', async () => {
    const engine = fakeEngine({ positive: firedRun, negative: cleanRun });
    const { deps: d } = deps(engine);
    const spec: NegativeControlSpec = { ...specFixture(), negativeControl: null };
    const result = await runWithNegativeControl(spec, d);

    expect(result.confirmable).toBe(false);
    expect(result.outcome).toBe('suspected');
    expect(result.reasons).toEqual(['negative_control_missing']);
    expect(result.negative).toBeUndefined();
    expect(engine.run).toHaveBeenCalledTimes(1);
  });

  it('treats an empty negative control as non-confirmable', async () => {
    const engine = fakeEngine({ positive: firedRun, negative: cleanRun });
    const { deps: d } = deps(engine);
    const spec: NegativeControlSpec = {
      ...specFixture(),
      negativeControl: { strategy: 'benign_value', steps: [] },
    };
    const result = await runWithNegativeControl(spec, d);

    expect(result.outcome).toBe('suspected');
    expect(result.reasons).toEqual(['negative_control_missing']);
  });

  it('treats an evaluator error on the positive as not fired, so the candidate is Suspected, not dropped', async () => {
    const real = createOracleDispatcher(createDeterministicEvaluators());
    let calls = 0;
    const { deps: d } = deps(fakeEngine({ positive: firedRun, negative: cleanRun }), {
      dispatch: (oracleType, observation, params) => {
        calls += 1;
        if (calls === 1) throw new Error('evaluator failed');
        return real(oracleType, observation, params);
      },
    });
    const result = await runWithNegativeControl(specFixture(), d);

    expect(result.positiveFired).toBe(false);
    expect(result.confirmable).toBe(false);
    expect(result.outcome).toBe('suspected');
    expect(result.reasons).toEqual(['positive_evaluator_error']);
  });

  it('does not treat a negative control with no observation as clean', async () => {
    const engine = fakeEngine({
      positive: firedRun,
      negative: (spec) => Promise.resolve(observation('no_observation', '', spec.id)),
    });
    const { deps: d } = deps(engine);
    const result = await runWithNegativeControl(specFixture(), d);

    expect(result.negativeControlClean).toBe(false);
    expect(result.confirmable).toBe(false);
    expect(result.reasons).toEqual(['negative_control_not_observed']);
  });

  it('treats a replay error on the negative control as Suspected and keeps the positive observation', async () => {
    const engine = fakeEngine({
      positive: firedRun,
      negative: () => {
        throw new ScopeViolationError('target out of scope');
      },
    });
    const { deps: d, record } = deps(engine);
    const result = await runWithNegativeControl(specFixture(), d);

    expect(result.outcome).toBe('suspected');
    expect(result.reasons).toEqual(['negative_control_error']);
    expect(result.positive.status).toBe('completed');
    expect(record).toHaveBeenCalledWith({
      type: 'validation.negative_control.run',
      candidateId: CANDIDATE_ID,
      clean: false,
    });
  });

  it('treats an evaluator error on the negative control as Suspected, not as clean', async () => {
    const real = createOracleDispatcher(createDeterministicEvaluators());
    let calls = 0;
    const { deps: d } = deps(fakeEngine({ positive: firedRun, negative: cleanRun }), {
      dispatch: (oracleType, observation, params) => {
        calls += 1;
        if (calls === 2) throw new Error('evaluator failed');
        return real(oracleType, observation, params);
      },
    });
    const result = await runWithNegativeControl(specFixture(), d);

    expect(result.negativeControlClean).toBe(false);
    expect(result.outcome).toBe('suspected');
    expect(result.reasons).toEqual(['negative_control_error']);
  });

  it('does not run the negative control when the budget is exhausted, and so cannot confirm', async () => {
    const engine = fakeEngine({ positive: firedRun, negative: cleanRun });
    const { deps: d } = deps(engine, { budget: { hasRemaining: () => false } });
    const result = await runWithNegativeControl(specFixture(), d);

    expect(result.outcome).toBe('suspected');
    expect(result.reasons).toEqual(['negative_control_budget_exhausted']);
    expect(engine.run).toHaveBeenCalledTimes(1);
  });

  it('runs the negative control when budget remains', async () => {
    const engine = fakeEngine({ positive: firedRun, negative: cleanRun });
    const { deps: d } = deps(engine, { budget: { hasRemaining: () => true } });
    const result = await runWithNegativeControl(specFixture(), d);

    expect(result.confirmable).toBe(true);
    expect(engine.run).toHaveBeenCalledTimes(2);
  });
});

describe('runWithNegativeControl: kill switch and refusals', () => {
  it('a positive abort is never confirmed, and the reason is aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const engine = fakeEngine({
      positive: (spec) => Promise.resolve(observation('aborted', '', spec.id)),
      negative: cleanRun,
    });
    const { deps: d } = deps(engine);
    const result = await runWithNegativeControl(specFixture(), d, { signal: controller.signal });

    expect(result.confirmable).toBe(false);
    expect(result.reasons).toEqual(['aborted']);
  });

  it('does not start the negative control once the kill switch has fired', async () => {
    const controller = new AbortController();
    const engine = fakeEngine({
      positive: (spec) => {
        controller.abort();
        return Promise.resolve(observation('completed', FIRED_BODY, spec.id));
      },
      negative: cleanRun,
    });
    const { deps: d } = deps(engine);
    const result = await runWithNegativeControl(specFixture(), d, { signal: controller.signal });

    expect(result.outcome).toBe('suspected');
    expect(result.reasons).toEqual(['aborted']);
    expect(engine.run).toHaveBeenCalledTimes(1);
  });

  it('propagates a positive refusal so the caller leaves the candidate Suspected', async () => {
    const engine = fakeEngine({
      positive: () => {
        throw new ScopeViolationError('not authorised');
      },
      negative: cleanRun,
    });
    const { deps: d, record } = deps(engine);

    await expect(runWithNegativeControl(specFixture(), d)).rejects.toBeInstanceOf(
      ScopeViolationError,
    );
    expect(engine.run).toHaveBeenCalledTimes(1);
    expect(record).not.toHaveBeenCalled();
  });
});

describe('runWithNegativeControl: audit and metrics', () => {
  it('records the negative control run and the confirm rule outcome', async () => {
    const {
      deps: d,
      metrics,
      record,
    } = deps(fakeEngine({ positive: firedRun, negative: cleanRun }));
    await runWithNegativeControl(specFixture(), d);

    expect(record.mock.calls.map(([event]) => event)).toEqual([
      { type: 'validation.negative_control.run', candidateId: CANDIDATE_ID, clean: true },
      { type: 'validation.confirm_rule', candidateId: CANDIDATE_ID, confirmable: true },
    ]);
    expect(metrics.negativeControlRun).toHaveBeenCalledWith({ clean: 'true' });
    expect(metrics.confirmRule).toHaveBeenCalledWith({ confirmable: 'true' });
  });

  it('records confirm_rule as false without a run event when the control is missing', async () => {
    const {
      deps: d,
      metrics,
      record,
    } = deps(fakeEngine({ positive: firedRun, negative: cleanRun }));
    await runWithNegativeControl({ ...specFixture(), negativeControl: null }, d);

    expect(record.mock.calls.map(([event]) => event)).toEqual([
      { type: 'validation.confirm_rule', candidateId: CANDIDATE_ID, confirmable: false },
    ]);
    expect(metrics.negativeControlRun).not.toHaveBeenCalled();
    expect(metrics.confirmRule).toHaveBeenCalledWith({ confirmable: 'false' });
  });
});

describe('runWithNegativeControl: real engine, fresh sandboxes and identical pins', () => {
  /** A real engine over stub ports: every probe is answered from the URL it names. */
  function realEngine() {
    const terminate = vi.fn(() => Promise.resolve());
    const provision = vi.fn((request: { imageDigest: string }) => {
      const sandbox: Sandbox = {
        id: `sandbox-${provision.mock.calls.length}`,
        imageDigest: request.imageDigest,
        terminate,
      };
      return Promise.resolve(sandbox);
    });
    const sandboxes: SandboxProvider = { provision };
    const egress: Egress = {
      request: vi.fn(({ url }: { url: string }) =>
        Promise.resolve(
          url === CONTROL_URL
            ? { status: 200, body: CLEAN_BODY }
            : { status: 500, body: FIRED_BODY },
        ),
      ),
      probe: vi.fn(() => Promise.resolve()),
    };
    const evidence: EvidenceReader = { read: vi.fn(() => Promise.resolve('')) };
    const capture: EvidenceCapture = {
      capture: vi.fn(({ replayId, stepIndex }: { replayId: string; stepIndex: number }) =>
        Promise.resolve(`evidence/${replayId}/${stepIndex}`),
      ),
    };
    const authorisation: AuthorisationGate = { assertValid: vi.fn() };
    const engineDeps: ReplayEngineDeps = {
      sandboxes,
      egress,
      evidence,
      capture,
      journal: { hasEntry: vi.fn(() => Promise.resolve(false)) },
      authorisation,
      audit: { record: vi.fn(() => Promise.resolve()) },
      egressProxyUrl: 'http://egress.local:3128',
      now: () => new Date('2026-10-30T00:00:00.000Z'),
    };
    return { engine: new ReplayEngine(engineDeps), provision, terminate, egress };
  }

  it('confirms through the real engine, with two fresh sandboxes pinned to the same digest', async () => {
    const real = realEngine();
    const { deps: d } = deps(real.engine);
    const result = await runWithNegativeControl(specFixture(), d);

    expect(result.outcome).toBe('confirmed');
    expect(real.provision).toHaveBeenCalledTimes(2);
    const digests = real.provision.mock.calls.map(([request]) => request.imageDigest);
    expect(digests).toEqual([DIGEST, DIGEST]);
    expect(real.terminate).toHaveBeenCalledTimes(2);
  });

  it('gives the negative control its own replay id, so its evidence never overwrites the positive one', async () => {
    const real = realEngine();
    const { deps: d } = deps(real.engine);
    const result = await runWithNegativeControl(specFixture(), d);

    expect(result.positive.replayId).toBe(SPEC_ID);
    expect(result.negative?.replayId).toBeDefined();
    expect(result.negative?.replayId).not.toBe(SPEC_ID);
    expect(result.negative?.pins).toEqual(result.positive.pins);
  });

  it('keeps a real negative control that fires as Suspected', async () => {
    const real = realEngine();
    const { deps: d } = deps(real.engine);
    const spec: NegativeControlSpec = {
      ...specFixture(),
      negativeControl: {
        strategy: 'benign_value',
        steps: [
          {
            kind: 'http_request',
            method: 'GET',
            endpoint: { assetId: ASSET, urlTemplate: PROBE_URL },
            roleKey: 'anonymous',
            inputRef: null,
          },
        ],
      },
    };
    const result = await runWithNegativeControl(spec, d);

    expect(result.outcome).toBe('suspected');
    expect(result.reasons).toEqual(['negative_control_fired']);
  });
});
