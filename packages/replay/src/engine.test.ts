import { describe, expect, it, vi } from 'vitest';

import { replaySpecSchema, type ReplaySpec } from '@blackwing/contracts';
import { ScopeViolationError, ValidationError } from '@blackwing/errors';

import {
  type AuthorisationGate,
  type Egress,
  type EvidenceCapture,
  type EvidenceReader,
  MAX_EXCHANGE_BODY_BYTES,
  MAX_PROVISION_ATTEMPTS,
  ReplayEngine,
  type ReplayEngineDeps,
  type Sandbox,
  type SandboxProvider,
  createExpiryGate,
} from './engine.js';
import { bodyDigest } from './oracle.js';

const DIGEST = `sha256:${'a'.repeat(64)}`;
const SHA = 'b'.repeat(64);
const SPEC_ID = '0190a000-0000-7000-8000-000000000001';

function specFixture(overrides: Partial<Record<string, unknown>> = {}): ReplaySpec {
  return replaySpecSchema.parse({
    id: SPEC_ID,
    candidateId: '0190a000-0000-7000-8000-000000000002',
    testCaseId: '0190a000-0000-7000-8000-000000000004',
    intrusivenessClass: 'active_safe',
    targets: [
      {
        assetId: '0190a000-0000-7000-8000-000000000003',
        urlTemplate: 'http://127.0.0.1:13000/rest/products/search?q=a%27',
      },
    ],
    steps: [
      {
        kind: 'http_request',
        method: 'GET',
        endpoint: {
          assetId: '0190a000-0000-7000-8000-000000000003',
          urlTemplate: 'http://127.0.0.1:13000/rest/products/search?q=a%27',
        },
        roleKey: 'anonymous',
        inputRef: null,
      },
      { kind: 'tcp_probe', host: '127.0.0.1', port: 13000 },
    ],
    oracle: {
      type: 'error_signature',
      declaredAt: '2026-10-01T00:00:00.000Z',
      params: { signature: 'SQLITE_ERROR' },
    },
    testStartedAt: '2026-10-02T00:00:00.000Z',
    negativeControl: {
      strategy: 'benign_value',
      steps: [
        {
          kind: 'http_request',
          method: 'GET',
          endpoint: {
            assetId: '0190a000-0000-7000-8000-000000000003',
            urlTemplate: 'http://127.0.0.1:13000/rest/products/search?q=apple',
          },
          roleKey: 'anonymous',
          inputRef: null,
        },
      ],
    },
    pins: {
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
    },
    inputsRef: [],
    ...overrides,
  });
}

interface Harness {
  deps: ReplayEngineDeps;
  sandboxes: SandboxProvider & { provision: ReturnType<typeof vi.fn> };
  egress: { request: ReturnType<typeof vi.fn>; probe: ReturnType<typeof vi.fn> } & Egress;
  terminated: ReturnType<typeof vi.fn>;
  audit: ReturnType<typeof vi.fn>;
  capture: ReturnType<typeof vi.fn> & EvidenceCapture['capture'];
  journal: { hasEntry: ReturnType<typeof vi.fn> };
  authorisation: AuthorisationGate;
  now: Date;
}

/** A harness whose every port succeeds, with spies so each test can assert what was (not) called. */
function harness(overrides: Partial<ReplayEngineDeps> = {}): Harness {
  const terminated = vi.fn(() => Promise.resolve());
  const provision = vi.fn((request: { imageDigest: string }) => {
    const sandbox: Sandbox = {
      id: 'sandbox-1',
      imageDigest: request.imageDigest,
      terminate: terminated,
    };
    return Promise.resolve(sandbox);
  });
  const sandboxes = { provision } as Harness['sandboxes'];
  const egress = {
    request: vi.fn(() => Promise.resolve({ status: 500, body: 'SQLITE_ERROR: near "a"' })),
    probe: vi.fn(() => Promise.resolve()),
  };
  const audit = vi.fn(() => Promise.resolve());
  const capture = vi.fn(() => Promise.resolve('evidence/step')) as Harness['capture'];
  const evidenceCapture: EvidenceCapture = { capture };
  const journal = { hasEntry: vi.fn(() => Promise.resolve(false)) };
  const authorisation: AuthorisationGate = { assertValid: vi.fn() };
  const now = new Date('2026-10-30T00:00:00.000Z');
  const evidence: EvidenceReader = { read: vi.fn(() => Promise.resolve('{}')) };
  const deps: ReplayEngineDeps = {
    sandboxes,
    egress,
    evidence,
    capture: evidenceCapture,
    journal,
    authorisation,
    audit: { record: audit },
    egressProxyUrl: 'http://egress.local:3128',
    now: () => now,
    ...overrides,
  };
  return { deps, sandboxes, egress, terminated, audit, capture, journal, authorisation, now };
}

describe('ReplayEngine.run', () => {
  it('runs the steps in order through egress and returns the observation with evidence refs', async () => {
    const h = harness();
    const observation = await new ReplayEngine(h.deps).run(specFixture());

    expect(h.egress.request).toHaveBeenCalledTimes(1);
    expect(h.egress.request).toHaveBeenCalledWith({
      method: 'GET',
      url: 'http://127.0.0.1:13000/rest/products/search?q=a%27',
      body: null,
    });
    expect(h.egress.probe).toHaveBeenCalledWith('127.0.0.1', 13000);
    expect(observation.status).toBe('completed');
    expect(observation.exchanges.map((exchange) => exchange.kind)).toEqual([
      'http_request',
      'tcp_probe',
    ]);
    expect(observation.evidenceRefs).toEqual(['evidence/step', 'evidence/step']);
    expect(observation.exchanges[0]?.status).toBe(500);
    expect(observation.exchanges[0]?.bodySha256).toBe(bodyDigest('SQLITE_ERROR: near "a"'));
    expect(observation.exchanges[0]?.truncated).toBe(false);
  });

  it('starts a fresh sandbox pinned to the spec digest for every run and terminates it', async () => {
    const h = harness();
    const engine = new ReplayEngine(h.deps);
    await engine.run(specFixture());
    await engine.run(specFixture());

    expect(h.sandboxes.provision).toHaveBeenCalledTimes(2);
    expect(h.sandboxes.provision).toHaveBeenCalledWith({
      imageDigest: DIGEST,
      proxyUrl: 'http://egress.local:3128',
    });
    expect(h.terminated).toHaveBeenCalledTimes(2);
  });

  it('records the pins, the attempts and the replay duration from the injected clock', async () => {
    const h = harness({
      now: vi.fn().mockReturnValueOnce(new Date(0)).mockReturnValue(new Date(1500)),
    });
    const observation = await new ReplayEngine(h.deps).run(specFixture());

    expect(observation.attempts).toBe(1);
    expect(observation.replayMs).toBe(1500);
    expect(observation.pins.sandboxImageDigest).toBe(DIGEST);
    expect(observation.oracleType).toBe('error_signature');
  });

  it('keeps a truncated body in memory and digests and stores the full body', async () => {
    const full = 'x'.repeat(MAX_EXCHANGE_BODY_BYTES + 100);
    const h = harness();
    h.egress.request.mockResolvedValueOnce({ status: 200, body: full });
    const observation = await new ReplayEngine(h.deps).run(specFixture());

    const exchange = observation.exchanges[0];
    expect(exchange?.truncated).toBe(true);
    expect(exchange?.body.length).toBe(MAX_EXCHANGE_BODY_BYTES);
    expect(exchange?.bodySha256).toBe(bodyDigest(full));
    expect(h.capture).toHaveBeenCalledWith(expect.objectContaining({ body: full }));
  });

  it('resolves declared inputs and passes the input body to a step that names it', async () => {
    const h = harness();
    const spec = specFixture({
      steps: [
        {
          kind: 'http_request',
          method: 'GET',
          endpoint: {
            assetId: '0190a000-0000-7000-8000-000000000003',
            urlTemplate: 'http://127.0.0.1:13000/rest/products/search?q=a%27',
          },
          roleKey: 'anonymous',
          inputRef: 'input/body-1',
        },
      ],
      inputsRef: ['input/body-1'],
    });
    await new ReplayEngine(h.deps).run(spec);

    expect(h.deps.evidence.read).toHaveBeenCalledWith('input/body-1');
    expect(h.egress.request).toHaveBeenCalledWith(expect.objectContaining({ body: '{}' }));
  });
});

describe('ReplayEngine fail-closed rules', () => {
  it('blocks the whole replay before any traffic when the authorisation is expired', async () => {
    const h = harness({ authorisation: createExpiryGate('2026-10-29T00:00:00.000Z') });
    await expect(new ReplayEngine(h.deps).run(specFixture())).rejects.toBeInstanceOf(
      ScopeViolationError,
    );

    expect(h.sandboxes.provision).not.toHaveBeenCalled();
    expect(h.egress.request).not.toHaveBeenCalled();
    expect(h.egress.probe).not.toHaveBeenCalled();
    expect(h.audit).toHaveBeenLastCalledWith(expect.objectContaining({ outcome: 'blocked' }));
  });

  it('propagates an out-of-scope refusal from egress, records it as blocked and does not observe', async () => {
    const h = harness();
    h.egress.request.mockRejectedValueOnce(new ScopeViolationError('out of scope'));
    await expect(new ReplayEngine(h.deps).run(specFixture())).rejects.toBeInstanceOf(
      ScopeViolationError,
    );

    expect(h.egress.probe).not.toHaveBeenCalled();
    expect(h.terminated).toHaveBeenCalledTimes(1);
    expect(h.audit).toHaveBeenLastCalledWith(expect.objectContaining({ outcome: 'blocked' }));
  });

  it('records a transport failure as no_observation and skips the remaining steps', async () => {
    const h = harness();
    h.egress.request.mockRejectedValueOnce(new TypeError('fetch failed'));
    const observation = await new ReplayEngine(h.deps).run(specFixture());

    expect(observation.status).toBe('no_observation');
    expect(observation.exchanges).toHaveLength(0);
    expect(h.egress.probe).not.toHaveBeenCalled();
    expect(h.terminated).toHaveBeenCalledTimes(1);
  });

  it('stops with status aborted when the kill switch fires between steps', async () => {
    const controller = new AbortController();
    const h = harness();
    h.egress.request.mockImplementationOnce(() => {
      controller.abort();
      return Promise.resolve({ status: 200, body: '' });
    });
    const observation = await new ReplayEngine(h.deps).run(specFixture(), {
      signal: controller.signal,
    });

    expect(observation.status).toBe('aborted');
    expect(observation.exchanges).toHaveLength(1);
    expect(h.egress.probe).not.toHaveBeenCalled();
    expect(h.terminated).toHaveBeenCalledTimes(1);
  });

  it('does not start any step when the kill switch is already fired', async () => {
    const controller = new AbortController();
    controller.abort();
    const h = harness();
    const observation = await new ReplayEngine(h.deps).run(specFixture(), {
      signal: controller.signal,
    });

    expect(observation.status).toBe('aborted');
    expect(h.egress.request).not.toHaveBeenCalled();
  });

  it('denies a state-changing step that has no reversal-journal entry, before any traffic', async () => {
    const h = harness();
    const spec = specFixture({
      steps: [
        {
          kind: 'http_request',
          method: 'POST',
          endpoint: {
            assetId: '0190a000-0000-7000-8000-000000000003',
            urlTemplate: 'http://127.0.0.1:13000/rest/basket',
          },
          roleKey: 'anonymous',
          inputRef: null,
        },
      ],
    });

    await expect(new ReplayEngine(h.deps).run(spec)).rejects.toBeInstanceOf(ScopeViolationError);
    expect(h.journal.hasEntry).toHaveBeenCalledWith(SPEC_ID, 0);
    expect(h.sandboxes.provision).not.toHaveBeenCalled();
    expect(h.egress.request).not.toHaveBeenCalled();
  });

  it('allows a state-changing step once the reversal journal has its entry', async () => {
    const h = harness({
      journal: { hasEntry: vi.fn(() => Promise.resolve(true)) },
    });
    const spec = specFixture({
      steps: [
        {
          kind: 'http_request',
          method: 'DELETE',
          endpoint: {
            assetId: '0190a000-0000-7000-8000-000000000003',
            urlTemplate: 'http://127.0.0.1:13000/rest/basket/1',
          },
          roleKey: 'anonymous',
          inputRef: null,
        },
      ],
    });
    const observation = await new ReplayEngine(h.deps).run(spec);

    expect(observation.status).toBe('completed');
    expect(h.egress.request).toHaveBeenCalledWith(expect.objectContaining({ method: 'DELETE' }));
  });

  it('retries a failed sandbox start and reports the attempt that worked', async () => {
    const h = harness();
    const provisionFailing = (request: { imageDigest: string }) => {
      const sandbox: Sandbox = {
        id: 'sandbox-2',
        imageDigest: request.imageDigest,
        terminate: h.terminated,
      };
      return Promise.resolve(sandbox);
    };
    h.sandboxes.provision
      .mockRejectedValueOnce(new Error('daemon busy'))
      .mockRejectedValueOnce(new Error('daemon busy'))
      .mockImplementationOnce(provisionFailing);
    const observation = await new ReplayEngine(h.deps).run(specFixture());

    expect(observation.attempts).toBe(3);
    expect(observation.status).toBe('completed');
  });

  it('gives up after the bounded provisioning attempts and never reaches the target', async () => {
    const h = harness();
    h.sandboxes.provision.mockRejectedValue(new Error('daemon down'));

    await expect(new ReplayEngine(h.deps).run(specFixture())).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(h.sandboxes.provision).toHaveBeenCalledTimes(MAX_PROVISION_ATTEMPTS);
    expect(h.egress.request).not.toHaveBeenCalled();
  });

  it('refuses a sandbox whose digest is not the pinned digest and terminates it', async () => {
    const h = harness();
    h.sandboxes.provision.mockImplementationOnce(() =>
      Promise.resolve({
        id: 'sandbox-x',
        imageDigest: `sha256:${'f'.repeat(64)}`,
        terminate: h.terminated,
      }),
    );

    await expect(new ReplayEngine(h.deps).run(specFixture())).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(h.terminated).toHaveBeenCalledTimes(1);
    expect(h.egress.request).not.toHaveBeenCalled();
  });

  it('refuses a browser step when no handler is registered, instead of skipping it', async () => {
    const h = harness();
    const spec = specFixture({
      steps: [
        {
          kind: 'browser_action',
          action: 'navigate',
          endpoint: {
            assetId: '0190a000-0000-7000-8000-000000000003',
            urlTemplate: 'http://127.0.0.1:13000/',
          },
          roleKey: 'anonymous',
          inputRef: null,
        },
      ],
    });

    await expect(new ReplayEngine(h.deps).run(spec)).rejects.toBeInstanceOf(ValidationError);
    expect(h.terminated).toHaveBeenCalledTimes(1);
  });

  it('runs a browser step through its registered handler with the input it names', async () => {
    const handler = vi.fn(() => Promise.resolve({ status: 200, body: 'ok' }));
    const h = harness({ handlers: { browser_action: handler } });
    const spec = specFixture({
      steps: [
        {
          kind: 'browser_action',
          action: 'wait',
          endpoint: {
            assetId: '0190a000-0000-7000-8000-000000000003',
            urlTemplate: 'http://127.0.0.1:13000/',
          },
          roleKey: 'anonymous',
          inputRef: null,
        },
      ],
    });
    const observation = await new ReplayEngine(h.deps).run(spec);

    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ kind: 'browser_action' }), null);
    expect(observation.exchanges[0]?.body).toBe('ok');
  });

  it('audits the start and the finish of a completed replay', async () => {
    const h = harness();
    await new ReplayEngine(h.deps).run(specFixture());

    expect(h.audit.mock.calls.map((call) => (call[0] as { type: string }).type)).toEqual([
      'validation.replay.started',
      'validation.replay.finished',
    ]);
    expect(h.audit).toHaveBeenLastCalledWith(
      expect.objectContaining({
        outcome: 'completed',
        candidateId: '0190a000-0000-7000-8000-000000000002',
      }),
    );
  });
});

describe('createExpiryGate', () => {
  const expiry = '2026-10-30T12:00:00.000Z';

  it('allows a replay strictly before the expiry', () => {
    expect(() => {
      createExpiryGate(expiry).assertValid(new Date('2026-10-30T11:59:59.999Z'));
    }).not.toThrow();
  });

  it('blocks a replay at or after the expiry', () => {
    const gate = createExpiryGate(expiry);
    expect(() => {
      gate.assertValid(new Date(expiry));
    }).toThrow(ScopeViolationError);
    expect(() => {
      gate.assertValid(new Date('2026-10-31T00:00:00.000Z'));
    }).toThrow(ScopeViolationError);
  });

  it('fails closed when the expiry cannot be parsed', () => {
    expect(() => {
      createExpiryGate('not-a-date').assertValid(new Date(0));
    }).toThrow(ScopeViolationError);
  });
});

describe('ReplayEngine metrics', () => {
  it('reports a completed run with bounded labels only', async () => {
    const metrics = { runFinished: vi.fn() };
    const h = harness({
      metrics,
      now: vi.fn().mockReturnValueOnce(new Date(0)).mockReturnValue(new Date(40)),
    });
    await new ReplayEngine(h.deps).run(specFixture());

    expect(metrics.runFinished).toHaveBeenCalledWith(
      { oracleType: 'error_signature', result: 'completed' },
      40,
    );
  });

  it('reports a run blocked by an expired authorisation as blocked, not as an error', async () => {
    const metrics = { runFinished: vi.fn() };
    const authorisation: AuthorisationGate = {
      assertValid: () => {
        throw new ScopeViolationError('expired');
      },
    };
    const h = harness({ metrics, authorisation });

    await expect(new ReplayEngine(h.deps).run(specFixture())).rejects.toBeInstanceOf(
      ScopeViolationError,
    );
    expect(metrics.runFinished).toHaveBeenCalledWith(
      { oracleType: 'error_signature', result: 'blocked' },
      expect.any(Number),
    );
    expect(h.egress.request).not.toHaveBeenCalled();
  });

  it('reports a sandbox that never starts as an error and sends no traffic', async () => {
    const metrics = { runFinished: vi.fn() };
    const provision = vi.fn(() => Promise.reject(new Error('docker is down')));
    const h = harness({ metrics, sandboxes: { provision } });

    await expect(new ReplayEngine(h.deps).run(specFixture())).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(metrics.runFinished).toHaveBeenCalledWith(
      { oracleType: 'error_signature', result: 'error' },
      expect.any(Number),
    );
    expect(h.egress.request).not.toHaveBeenCalled();
  });
});
