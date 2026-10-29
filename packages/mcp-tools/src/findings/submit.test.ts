import { createHash } from 'node:crypto';

import { Registry } from 'prom-client';
import { describe, expect, it } from 'vitest';

import { createCandidateMetrics } from './metrics.js';
import { createSubmitCandidateTool, type DeclaredTestCase } from './submit-candidate.js';
import {
  type CaptureSource,
  type GatewayCapture,
  submitWebApiCandidate,
  type WebApiSubmitDeps,
} from './submit.js';
import { createToolMetrics } from '../metrics.js';

import type { BrokerClient } from '../broker-client.js';
import type { ToolRuntime } from '../tool.js';

const TEST_CASE = '01890a5d-ac96-774b-bcce-b302099a8059';
const SUBTASK = '01890a5d-ac96-774b-bcce-b302099a8058';
const FINDING = '01890a5d-ac96-774b-bcce-b302099a8071';
const EV1 = '01890a5d-ac96-774b-bcce-b302099a8101';
const EV2 = '01890a5d-ac96-774b-bcce-b302099a8102';
const EV3 = '01890a5d-ac96-774b-bcce-b302099a8103';
const EXCHANGE = 'exch-1';
const oracle = { type: 'marker', params: { token: 'PWNED-7f3a' } };
const control = 'benign_value';
const sha = (content: string): string => createHash('sha256').update(content, 'utf8').digest('hex');

/** A gateway capture whose digests are correct for its bytes. */
function capture(exchangeId = EXCHANGE, overrides: Partial<GatewayCapture> = {}): GatewayCapture {
  const part = (content: string) => ({ content, sha256: sha(content) });
  return {
    exchangeId,
    har: part('{"log":{"entries":[]}}'),
    request: part('GET /api/orders/2 HTTP/1.1\nHost: lab.test'),
    response: part('HTTP/1.1 200 OK\n\n{"id":2}'),
    ...overrides,
  };
}

const validCandidate = (over: Record<string, unknown> = {}) => ({
  testCaseId: TEST_CASE,
  class: 'reflected_xss',
  wstgRefs: ['WSTG-INPV-01'],
  cweId: 'CWE-79',
  owaspCategory: 'A03:2021',
  location: {
    method: 'GET',
    urlTemplate: '/search?q={q}',
    parameter: 'q',
    file: null,
    line: null,
  },
  role: 'web-api-specialist',
  declaredOracle: oracle,
  negativeControlRef: control,
  positiveFired: true,
  negativeControlFired: false,
  captures: [{ exchangeId: EXCHANGE }],
  confidence: 0.7,
  summary: 'Search parameter reflects the marker (CWE-79).',
  ...over,
});

const declared = (over: Partial<DeclaredTestCase> = {}): DeclaredTestCase => ({
  id: TEST_CASE,
  class: 'active_safe',
  status: 'executing',
  oracle,
  negativeControl: { type: control, params: {} },
  ...over,
});

interface Harness {
  readonly deps: WebApiSubmitDeps;
  readonly runtime: ToolRuntime;
  readonly posted: { suffix: string; body: Record<string, unknown> }[];
  readonly stored: { content: string; contentType: string; description: string }[];
  readonly controller: AbortController;
  readonly registry: Registry;
}

function harness(
  options: {
    testCase?: DeclaredTestCase;
    source?: CaptureSource;
    redact?: (text: string) => string;
    broker?: BrokerClient['post'];
  } = {},
): Harness {
  const registry = new Registry();
  const controller = new AbortController();
  const posted: Harness['posted'] = [];
  const stored: Harness['stored'] = [];
  const evidenceIds = new Set<string>();
  const broker: BrokerClient = {
    get: () => Promise.reject(new Error('unused')),
    post: (options.broker ??
      ((suffix: string, body: unknown) => {
        posted.push({ suffix, body: body as Record<string, unknown> });
        return Promise.resolve(
          suffix === 'candidates' ? { findingId: FINDING, status: 'candidate' } : undefined,
        );
      })) as BrokerClient['post'],
  };
  let counter = 0;
  const runtime: ToolRuntime = {
    broker,
    evidence: {
      store: (item) => {
        counter += 1;
        const id = `01890a5d-ac96-774b-bcce-b302099a81${String(counter).padStart(2, '0')}`;
        evidenceIds.add(id);
        stored.push(item);
        return Promise.resolve(id);
      },
    },
    metrics: createToolMetrics(registry),
    signal: controller.signal,
    subtaskId: SUBTASK,
    testCaseId: TEST_CASE,
    roleId: 'web-api-specialist',
    ...(options.redact === undefined ? {} : { redact: options.redact }),
  };
  const metrics = createCandidateMetrics(registry);
  const submitTool = createSubmitCandidateTool({
    testCase: options.testCase ?? declared(),
    evidenceExists: (ids) => Promise.resolve(ids.every((id) => evidenceIds.has(id))),
    hasReversalEntry: () => Promise.resolve(true),
    metrics,
  });
  const deps: WebApiSubmitDeps = {
    runtime,
    submitTool,
    captures: options.source ?? { fetch: (id) => Promise.resolve(capture(id)) },
    metrics,
  };
  return { deps, runtime, posted, stored, controller, registry };
}

const candidatePosts = (posted: Harness['posted']) =>
  posted.filter((entry) => entry.suffix === 'candidates');

describe('submitWebApiCandidate', () => {
  it('captures, stores and submits a candidate bound to the declared oracle', async () => {
    const h = harness();
    const result = await submitWebApiCandidate(validCandidate(), h.deps);
    expect(result).toMatchObject({ ok: true, findingId: FINDING });
    expect(h.stored.map((item) => item.description)).toEqual([
      `har capture of ${EXCHANGE} for role web-api-specialist`,
      `request capture of ${EXCHANGE} for role web-api-specialist`,
      `response capture of ${EXCHANGE} for role web-api-specialist`,
    ]);
    const [body] = candidatePosts(h.posted).map((entry) => entry.body);
    expect(body).toMatchObject({
      testCaseId: TEST_CASE,
      vulnClass: 'reflected_xss',
      oracleBinding: oracle,
      negativeControlRef: control,
      evidenceIds: [EV1, EV2, EV3],
    });
  });

  it('attaches each evidence object with the sha256 of the bytes it stored', async () => {
    const h = harness();
    const result = await submitWebApiCandidate(validCandidate(), h.deps);
    if (!result.ok) throw new Error('expected a submission');
    expect(result.evidence.map((item) => item.sha256)).toEqual(
      h.stored.map((item) => sha(item.content)),
    );
    expect(result.evidence.map((item) => item.kind)).toEqual(['har', 'request', 'response']);
  });

  it('rejects a candidate with no pre-declared oracle, and submits nothing', async () => {
    const h = harness();
    const result = await submitWebApiCandidate(validCandidate({ declaredOracle: null }), h.deps);
    expect(result).toMatchObject({ ok: false, reason: 'missing_oracle' });
    expect(candidatePosts(h.posted)).toHaveLength(0);
    expect(h.stored).toHaveLength(0);
    expect(await h.registry.metrics()).toContain(
      'mcp_candidate_rejections_total{reason="missing_oracle"} 1',
    );
  });

  it('rejects a candidate with no negative control', async () => {
    const h = harness();
    const result = await submitWebApiCandidate(
      validCandidate({ negativeControlRef: null }),
      h.deps,
    );
    expect(result).toMatchObject({ ok: false, reason: 'missing_negative_control' });
    expect(candidatePosts(h.posted)).toHaveLength(0);
  });

  it('rejects when the positive did not fire or the negative control fired (false positive)', async () => {
    const h = harness();
    expect(
      await submitWebApiCandidate(validCandidate({ positiveFired: false }), h.deps),
    ).toMatchObject({ ok: false, reason: 'positive_not_fired' });
    expect(
      await submitWebApiCandidate(validCandidate({ negativeControlFired: true }), h.deps),
    ).toMatchObject({ ok: false, reason: 'negative_control_fired' });
    expect(candidatePosts(h.posted)).toHaveLength(0);
  });

  it('rejects a post-hoc oracle: the submit tool refuses an oracle other than the declared one', async () => {
    const h = harness();
    const result = await submitWebApiCandidate(
      validCandidate({ declaredOracle: { type: 'marker', params: { token: 'other' } } }),
      h.deps,
    );
    expect(result).toMatchObject({ ok: false, reason: 'submit_rejected' });
    if (result.ok) throw new Error('expected a rejection');
    expect(result.message).toContain('oracle_not_predeclared');
    expect(candidatePosts(h.posted)).toHaveLength(0);
  });

  it('rejects invalid candidates: missing standards refs, no location target, bad exchange id', async () => {
    const h = harness();
    const noWstg = await submitWebApiCandidate(validCandidate({ wstgRefs: [] }), h.deps);
    expect(noWstg).toMatchObject({ ok: false, reason: 'invalid_candidate' });
    const noTarget = await submitWebApiCandidate(
      validCandidate({
        location: { method: 'GET', urlTemplate: null, parameter: null, file: null, line: null },
      }),
      h.deps,
    );
    expect(noTarget).toMatchObject({ ok: false, reason: 'invalid_candidate' });
    const badExchange = await submitWebApiCandidate(
      validCandidate({ captures: [{ exchangeId: '../etc' }] }),
      h.deps,
    );
    expect(badExchange).toMatchObject({ ok: false, reason: 'invalid_candidate' });
    const extra = await submitWebApiCandidate(validCandidate({ status: 'confirmed' }), h.deps);
    expect(extra).toMatchObject({ ok: false, reason: 'invalid_candidate' });
    expect(candidatePosts(h.posted)).toHaveLength(0);
  });

  it('rejects a non-object input without throwing', async () => {
    const h = harness();
    expect(await submitWebApiCandidate('not a candidate', h.deps)).toMatchObject({
      ok: false,
      reason: 'invalid_candidate',
    });
  });

  it('fails closed when the gateway has no capture for an exchange', async () => {
    const h = harness({ source: { fetch: () => Promise.resolve(null) } });
    const result = await submitWebApiCandidate(validCandidate(), h.deps);
    expect(result).toMatchObject({ ok: false, reason: 'evidence_capture_failed' });
    expect(candidatePosts(h.posted)).toHaveLength(0);
    expect(h.stored).toHaveLength(0);
  });

  it('fails closed when the capture source throws, and when it answers for another exchange', async () => {
    const thrown = harness({
      source: { fetch: () => Promise.reject(new Error('gateway down: 10.0.0.9 token')) },
    });
    const throwing = await submitWebApiCandidate(validCandidate(), thrown.deps);
    expect(throwing).toMatchObject({ ok: false, reason: 'evidence_capture_failed' });
    if (throwing.ok) throw new Error('expected a rejection');
    expect(throwing.message).not.toContain('10.0.0.9');
    expect(candidatePosts(thrown.posted)).toHaveLength(0);

    const wrong = harness({ source: { fetch: () => Promise.resolve(capture('other-exchange')) } });
    expect(await submitWebApiCandidate(validCandidate(), wrong.deps)).toMatchObject({
      ok: false,
      reason: 'evidence_capture_failed',
    });
  });

  it('fails closed when a gateway digest does not match the captured bytes', async () => {
    const tampered = harness({
      source: {
        fetch: (id) =>
          Promise.resolve(
            capture(id, {
              response: { content: 'HTTP/1.1 200 OK\n\nforged', sha256: sha('HTTP/1.1 200 OK') },
            }),
          ),
      },
    });
    const result = await submitWebApiCandidate(validCandidate(), tampered.deps);
    expect(result).toMatchObject({ ok: false, reason: 'evidence_capture_failed' });
    expect(candidatePosts(tampered.posted)).toHaveLength(0);

    const malformed = harness({
      source: {
        fetch: (id) =>
          Promise.resolve(capture(id, { har: { content: '{}', sha256: 'not-a-digest' } })),
      },
    });
    expect(await submitWebApiCandidate(validCandidate(), malformed.deps)).toMatchObject({
      ok: false,
      reason: 'evidence_capture_failed',
    });
  });

  it('redacts built-in and registry secrets from stored evidence and the summary (§8.7)', async () => {
    const secret = 'hunter2-registry-value';
    const leaky = capture(EXCHANGE, {
      request: {
        content: `GET /x HTTP/1.1\nAuthorization: Bearer abcdefghijklmnop\nX-Api: ${secret}`,
        sha256: '',
      },
    });
    const withDigest = {
      ...leaky,
      request: { content: leaky.request.content, sha256: sha(leaky.request.content) },
    };
    const h = harness({
      source: { fetch: () => Promise.resolve(withDigest) },
      redact: (text) => text.split(secret).join('[REDACTED]'),
    });
    const result = await submitWebApiCandidate(
      validCandidate({ summary: `leaked ${secret} in reply` }),
      h.deps,
    );
    expect(result).toMatchObject({ ok: true });
    const requestStored = h.stored.find((item) => item.description.startsWith('request capture'));
    expect(requestStored?.content).not.toContain('abcdefghijklmnop');
    expect(requestStored?.content).not.toContain(secret);
    expect(requestStored?.content).toContain('[REDACTED]');
    for (const item of h.stored) expect(item.content).not.toContain(secret);
    const [body] = candidatePosts(h.posted).map((entry) => entry.body);
    expect(String(body?.summary)).not.toContain(secret);
  });

  it('stops before submitting when the run is killed during capture', async () => {
    const h = harness({
      source: {
        fetch: (id) => {
          h.controller.abort();
          return Promise.resolve(capture(id));
        },
      },
    });
    const result = await submitWebApiCandidate(validCandidate(), h.deps);
    expect(result).toMatchObject({ ok: false, reason: 'killed' });
    expect(candidatePosts(h.posted)).toHaveLength(0);
  });

  it('refuses before any capture when the run was already killed', async () => {
    const h = harness();
    h.controller.abort();
    expect(await submitWebApiCandidate(validCandidate(), h.deps)).toMatchObject({
      ok: false,
      reason: 'killed',
    });
    expect(h.stored).toHaveLength(0);
  });

  it('is idempotent for the same candidate: one finding, not a duplicate', async () => {
    const h = harness();
    const first = await submitWebApiCandidate(validCandidate(), h.deps);
    const second = await submitWebApiCandidate(
      validCandidate({ summary: 'again', confidence: 0.9 }),
      h.deps,
    );
    expect(second).toMatchObject({ ok: true, findingId: FINDING });
    expect(first).toMatchObject({ ok: true, findingId: FINDING });
    expect(candidatePosts(h.posted)).toHaveLength(1);
  });

  it('counts accepted submissions in the candidate metrics', async () => {
    const h = harness();
    await submitWebApiCandidate(validCandidate(), h.deps);
    expect(await h.registry.metrics()).toContain(
      'mcp_candidates_submitted_total{class="reflected_xss"} 1',
    );
  });
});
