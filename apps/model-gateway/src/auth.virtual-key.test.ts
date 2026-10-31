import { describe, expect, it } from 'vitest';

import { anyVerifier, staticVirtualKeyVerifier, virtualKeyVerifier } from './auth.js';

import type { VirtualKeyContext } from '@blackwing/contracts';

const CONTEXT: VirtualKeyContext = {
  virtualKeyId: '0196f0a0-0000-7000-8000-000000000001',
  tenantId: '0196f0a0-0000-7000-8000-0000000000aa',
  runId: '0196f0a0-0000-7000-8000-0000000000bb',
  sessionId: '0196f0a0-0000-7000-8000-0000000000cc',
  persona: 'planner',
  budgetContext: { costCapUsd: 5 },
  expiresAt: '2026-10-31T11:00:00.000Z',
};

describe('virtualKeyVerifier', () => {
  it('maps a valid key to the principal with the request context (no raw key)', async () => {
    const verifier = virtualKeyVerifier((key) =>
      Promise.resolve(key === 'bwk_good' ? CONTEXT : undefined),
    );
    expect(await verifier.verify('bwk_good')).toEqual({
      tenantId: CONTEXT.tenantId,
      keyId: CONTEXT.virtualKeyId,
      sessionId: CONTEXT.sessionId,
      runId: CONTEXT.runId,
      persona: 'planner',
      budgetContext: { costCapUsd: 5 },
    });
  });

  it('refuses a key the authenticator does not accept', async () => {
    const verifier = virtualKeyVerifier(() => Promise.resolve(undefined));
    expect(await verifier.verify('bwk_bad')).toBeUndefined();
  });

  it('lets a thrown lookup error escape, so the request fails closed', async () => {
    const verifier = virtualKeyVerifier(() => Promise.reject(new Error('db down')));
    await expect(verifier.verify('bwk_any')).rejects.toThrow('db down');
  });
});

describe('anyVerifier', () => {
  it('keeps the dev static key working beside session keys', async () => {
    const dev = staticVirtualKeyVerifier({
      keySha256Hex: '0'.repeat(64),
      tenantId: CONTEXT.tenantId,
    });
    const session = virtualKeyVerifier((key) =>
      Promise.resolve(key === 'bwk_session' ? CONTEXT : undefined),
    );
    const both = anyVerifier(dev, session);
    expect(await both.verify('bwk_session')).toMatchObject({ keyId: CONTEXT.virtualKeyId });
    expect(await both.verify('bwk_unknown')).toBeUndefined();
  });
});
