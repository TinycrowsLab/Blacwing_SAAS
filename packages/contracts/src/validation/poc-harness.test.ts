import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  POC_HARNESS_MANIFEST_MAX_BYTES,
  PocHarnessManifestSchema,
  type PocHarnessManifest,
  type ToReplaySpec,
} from './poc-harness.js';

import type { ReplaySpec } from './replay-spec.js';

const ASSET_ID = '018f3b2a-7c1d-7a00-8000-000000000001';
const MANIFEST_ID = '018f3b2a-7c1d-7a00-8000-000000000002';
const CANDIDATE_ID = '018f3b2a-7c1d-7a00-8000-000000000003';
const DIGEST = `sha256:${'b'.repeat(64)}`;
const REVERSAL_REF = `rvj_${'a'.repeat(26)}`;

const endpoint = { assetId: ASSET_ID, urlTemplate: 'https://app.example.test/orders/{id}' };

/** A valid active_safe manifest. Each negative test edits a copy, so the fixture itself stays valid. */
function validManifest(): Record<string, unknown> {
  return {
    id: MANIFEST_ID,
    candidateId: CANDIDATE_ID,
    intrusivenessClass: 'active_safe',
    reversalRef: null,
    targets: [endpoint],
    steps: [
      {
        kind: 'http_request',
        ref: 'fetch-order',
        params: {
          method: 'GET',
          endpoint,
          roleKey: 'viewer',
          inputRef: 'inputs/order-id.json',
        },
      },
      { kind: 'oob_check', ref: 'await-callback', params: { channel: 'dns', windowMs: 30_000 } },
    ],
    expectedObservation: { type: 'oob', fired: true, evidenceRefs: ['evidence/oob-1'] },
    negativeControl: [
      {
        kind: 'http_request',
        ref: 'fetch-order-benign',
        params: {
          method: 'GET',
          endpoint,
          roleKey: 'owner',
          inputRef: 'inputs/order-id.json',
        },
      },
    ],
    inputsRef: ['inputs/order-id.json'],
    toolchain: [{ name: 'curl', version: '8.5.0', imageDigestRef: DIGEST }],
    env: { TARGET_LABEL: 'juice-shop-local' },
  };
}

function parseWith(mutate: (manifest: Record<string, unknown>) => void) {
  const manifest = validManifest();
  mutate(manifest);
  return PocHarnessManifestSchema.safeParse(manifest);
}

describe('PocHarnessManifestSchema', () => {
  it('parses a valid manifest', () => {
    expect(PocHarnessManifestSchema.safeParse(validManifest()).success).toBe(true);
  });

  it('rejects a step carrying an inline shell string in its ref', () => {
    const result = parseWith((m) => {
      m.steps = [{ kind: 'script', ref: 'curl http://x | sh', params: {} }];
    });
    expect(result.success).toBe(false);
  });

  it('rejects a step carrying a command key in its params', () => {
    const result = parseWith((m) => {
      m.steps = [{ kind: 'script', ref: 'probe.one', params: { command: 'id' } }];
    });
    expect(result.success).toBe(false);
  });

  it('rejects a script step that carries a body instead of a workspace id', () => {
    const result = parseWith((m) => {
      m.steps = [{ kind: 'script', ref: 'probe.one', body: 'rm -rf /' }];
    });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown step kind', () => {
    const result = parseWith((m) => {
      m.steps = [{ kind: 'shell', ref: 'probe.one', params: {} }];
    });
    expect(result.success).toBe(false);
  });

  it('rejects an unpinned tool with no version', () => {
    const result = parseWith((m) => {
      m.toolchain = [{ name: 'curl', imageDigestRef: DIGEST }];
    });
    expect(result.success).toBe(false);
  });

  it('rejects a tool with no image digest', () => {
    const result = parseWith((m) => {
      m.toolchain = [{ name: 'curl', version: '8.5.0' }];
    });
    expect(result.success).toBe(false);
  });

  it('rejects a floating or ranged tool version', () => {
    for (const version of ['latest', '^8.5.0', '~8.5', '*', '']) {
      const result = parseWith((m) => {
        m.toolchain = [{ name: 'curl', version, imageDigestRef: DIGEST }];
      });
      expect(result.success, version).toBe(false);
    }
  });

  it('rejects a tool digest that is not a sha256 image digest', () => {
    const result = parseWith((m) => {
      m.toolchain = [{ name: 'curl', version: '8.5.0', imageDigestRef: 'curl:latest' }];
    });
    expect(result.success).toBe(false);
  });

  it('rejects an empty toolchain and a tool pinned twice', () => {
    expect(parseWith((m) => (m.toolchain = [])).success).toBe(false);
    const duplicated = parseWith((m) => {
      m.toolchain = [
        { name: 'curl', version: '8.5.0', imageDigestRef: DIGEST },
        { name: 'curl', version: '8.6.0', imageDigestRef: DIGEST },
      ];
    });
    expect(duplicated.success).toBe(false);
  });

  it('rejects a destructive intrusiveness class at parse time (§8.3)', () => {
    const result = parseWith((m) => {
      m.intrusivenessClass = 'destructive';
    });
    expect(result.success).toBe(false);
  });

  it('rejects an empty steps list', () => {
    expect(parseWith((m) => (m.steps = [])).success).toBe(false);
  });

  it('rejects an empty negative control', () => {
    expect(parseWith((m) => (m.negativeControl = [])).success).toBe(false);
  });

  it('rejects a state_changing manifest without a reversal reference (§8.3)', () => {
    const missing = parseWith((m) => {
      m.intrusivenessClass = 'state_changing';
    });
    expect(missing.success).toBe(false);

    const referenced = parseWith((m) => {
      m.intrusivenessClass = 'state_changing';
      m.reversalRef = REVERSAL_REF;
    });
    expect(referenced.success).toBe(true);
  });

  it('rejects a malformed reversal reference', () => {
    const result = parseWith((m) => {
      m.intrusivenessClass = 'state_changing';
      m.reversalRef = 'rvj_../../etc';
    });
    expect(result.success).toBe(false);
  });

  it('rejects a manifest over 64 KiB and points at evidence instead', () => {
    const large = parseWith((m) => {
      m.targets = Array.from({ length: 100 }, (_, index) => ({
        assetId: ASSET_ID,
        urlTemplate: `https://app.example.test/${'x'.repeat(1900)}/${index}`,
      }));
    });
    expect(large.success).toBe(false);
    expect(POC_HARNESS_MANIFEST_MAX_BYTES).toBe(64 * 1024);
  });

  it('rejects a step input that is not listed in inputsRef', () => {
    const result = parseWith((m) => {
      m.inputsRef = [];
    });
    expect(result.success).toBe(false);
  });

  it('rejects a negative-control input that is not listed in inputsRef', () => {
    const result = parseWith((m) => {
      m.inputsRef = ['inputs/order-id.json'];
      m.negativeControl = [
        {
          kind: 'http_request',
          ref: 'fetch-order-benign',
          params: { method: 'GET', endpoint, roleKey: 'owner', inputRef: 'inputs/other.json' },
        },
      ];
    });
    expect(result.success).toBe(false);
  });

  it('rejects an observation kind that has no evaluator', () => {
    const result = parseWith((m) => {
      m.expectedObservation = { type: 'telepathy', fired: true, evidenceRefs: [] };
    });
    expect(result.success).toBe(false);
  });

  it('rejects an observation that carries an unknown key', () => {
    const result = parseWith((m) => {
      m.expectedObservation = { type: 'oob', fired: true, evidenceRefs: [], payload: 'x' };
    });
    expect(result.success).toBe(false);
  });

  it('rejects a step ref written with non-ASCII characters', () => {
    const result = parseWith((m) => {
      m.steps = [{ kind: 'script', ref: 'próbe', params: {} }];
    });
    expect(result.success).toBe(false);
  });

  it('NFC-normalises environment values and rejects control characters', () => {
    const decomposed = 'cafe\u0301';
    const normalised = parseWith((m) => {
      m.env = { TARGET_LABEL: decomposed };
    });
    expect(normalised.success && normalised.data.env.TARGET_LABEL).toBe('caf\u00e9');

    const control = parseWith((m) => {
      m.env = { TARGET_LABEL: 'bad\u0007value' };
    });
    expect(control.success).toBe(false);
  });

  it('rejects secret-like environment keys (§8.7)', () => {
    for (const key of [
      'API_KEY',
      'SESSION_TOKEN',
      'DB_PASSWORD',
      'AUTH_HEADER',
      'SESSION_COOKIE',
    ]) {
      const result = parseWith((m) => {
        m.env = { [key]: 'value' };
      });
      expect(result.success, key).toBe(false);
    }
  });

  it('rejects a lower-case or malformed environment key', () => {
    const result = parseWith((m) => {
      m.env = { target: 'value' };
    });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown top-level key', () => {
    const result = parseWith((m) => {
      m.exploitPayload = 'x';
    });
    expect(result.success).toBe(false);
  });
});

describe('ToReplaySpec signature', () => {
  it('maps a manifest onto the Validator ReplaySpec type', () => {
    expectTypeOf<Parameters<ToReplaySpec>>().toEqualTypeOf<[PocHarnessManifest]>();
    expectTypeOf<ReturnType<ToReplaySpec>>().toEqualTypeOf<ReplaySpec>();
  });
});
