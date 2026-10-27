// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { HaltTimeBadge } from './halt-time-badge';

import type { KillEventView } from './kill-model';

// Tooltip interaction is slow on a loaded CI runner.
vi.setConfig({ testTimeout: 30_000 });

afterEach(cleanup);

const event = (over: Partial<KillEventView> = {}): KillEventView => ({
  status: 'halted',
  initiatedAt: '2026-10-20T10:00:00.000Z',
  gatewayBlockedMs: 400,
  sandboxesTerminatedMs: 3100,
  completedAt: '2026-10-20T10:00:03.300Z',
  actor: 'Priya Nair',
  ...over,
});

describe('HaltTimeBadge', () => {
  it('shows the total, the actor and a green badge within SLO', () => {
    render(<HaltTimeBadge killEvent={event()} />);
    const badge = screen.getByText('Halted in 3.3 s');
    expect(badge.getAttribute('data-slo')).toBe('within');
    expect(badge.className).toContain('text-success');
    expect(screen.getByText('by Priya Nair')).toBeTruthy();
  });

  it('is amber when the gateway stage is over its SLO', () => {
    render(<HaltTimeBadge killEvent={event({ gatewayBlockedMs: 2400 })} />);
    const badge = screen.getByText('Halted in 3.3 s');
    expect(badge.getAttribute('data-slo')).toBe('over');
    expect(badge.className).toContain('text-warning');
  });

  it('is amber when the sandbox stage is over its SLO', () => {
    render(
      <HaltTimeBadge
        killEvent={event({
          sandboxesTerminatedMs: 12_500,
          completedAt: '2026-10-20T10:00:12.600Z',
        })}
      />,
    );
    expect(screen.getByText('Halted in 12.6 s').className).toContain('text-warning');
  });

  it('is amber and says so for a partial halt', () => {
    render(
      <HaltTimeBadge
        killEvent={event({ status: 'partially_halted', sandboxesTerminatedMs: null })}
      />,
    );
    expect(screen.getByText('Halt incomplete after 3.3 s').className).toContain('text-warning');
  });

  it('shows the gateway and sandbox breakdown in the tooltip', async () => {
    render(<HaltTimeBadge killEvent={event()} />);
    await userEvent.hover(screen.getByText('Halted in 3.3 s'));
    const tips = await screen.findAllByText(
      /Egress gateway blocked: 400 ms \(target under 2\.0 s\)/,
    );
    expect(tips.length).toBeGreaterThan(0);
    expect(
      screen.getAllByText(/Sandboxes terminated: 3\.1 s \(target under 10\.0 s\)/).length,
    ).toBeGreaterThan(0);
  });

  it('never shows a halt time before the server reports completion', () => {
    const { container, rerender } = render(<HaltTimeBadge killEvent={null} />);
    expect(container.textContent).toBe('');
    rerender(
      <HaltTimeBadge
        killEvent={event({ status: 'propagating', completedAt: null, gatewayBlockedMs: 400 })}
      />,
    );
    expect(container.textContent).toBe('');
  });

  it('omits the actor when the server did not report one', () => {
    render(<HaltTimeBadge killEvent={event({ actor: null })} />);
    expect(screen.queryByText(/^by /)).toBeNull();
  });
});
