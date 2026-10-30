import { Registry } from 'prom-client';
import { describe, expect, it } from 'vitest';

import { createAssetMetrics } from './metrics.js';

describe('asset verification metrics (ASSET-003)', () => {
  it('counts probe runs by method and bounded result, and tracks pending verifications', async () => {
    const registry = new Registry();
    const metrics = createAssetMetrics(registry);
    metrics.verificationAttempt('dns_txt', 'not_found');
    metrics.verificationAttempt('dns_txt', 'not_found');
    metrics.verificationAttempt('dns_txt', 'passed');
    metrics.verificationPendingOpened();
    metrics.verificationPendingOpened();
    metrics.verificationPendingClosed();

    const text = await registry.metrics();
    expect(text).toContain(
      'asset_verification_attempts_total{method="dns_txt",result="not_found"} 2',
    );
    expect(text).toContain('asset_verification_attempts_total{method="dns_txt",result="passed"} 1');
    expect(text).toMatch(/asset_verification_active_pending 1(\s|$)/);
  });
});
