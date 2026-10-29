// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { StepAssets } from './step-assets';
import { StepMode } from './step-mode';
import { StepObjective } from './step-objective';

afterEach(cleanup);

/** Serious and critical axe violations of a rendered step; the acceptance bar is that there are none. */
async function blockingViolations(container: HTMLElement): Promise<string[]> {
  const result = await axe.run(container, { resultTypes: ['violations'] });
  return result.violations
    .filter((violation) => violation.impact === 'critical' || violation.impact === 'serious')
    .map((violation) => violation.id);
}

describe('scoping wizard steps (axe-core, no critical or serious violations)', () => {
  it('the mode step has no blocking violations', async () => {
    const { container } = render(
      <StepMode defaultMode={null} pending={false} onSubmit={vi.fn(() => Promise.resolve())} />,
    );
    expect(await blockingViolations(container)).toEqual([]);
  });

  it('the assets step has no blocking violations', async () => {
    const { container } = render(
      <StepAssets
        assets={[
          {
            id: '0198f0a0-0000-7000-8000-0000000000e1',
            name: 'Juice Shop',
            type: 'web_app',
            environment: 'dev',
            verificationStatus: 'verified',
          },
          {
            id: '0198f0a0-0000-7000-8000-0000000000e2',
            name: 'Legacy API',
            type: 'api',
            environment: 'staging',
            verificationStatus: 'unverified',
          },
        ]}
        loading={false}
        defaultAssetIds={[]}
        pending={false}
        onSubmit={vi.fn(() => Promise.resolve())}
      />,
    );
    expect(await blockingViolations(container)).toEqual([]);
  });

  it('the objective step has no blocking violations', async () => {
    const { container } = render(
      <StepObjective
        defaultObjective=""
        pending={false}
        savedDraftId={null}
        onSubmit={vi.fn(() => Promise.resolve())}
      />,
    );
    expect(await blockingViolations(container)).toEqual([]);
  });
});
