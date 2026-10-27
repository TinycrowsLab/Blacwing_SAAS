// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { GatePromptPanel, type GatePromptPanelProps } from './gate-prompt-panel';
import { setClientEventSink, type ClientEvent } from '../../../../../lib/client-events';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const RUN = 'run_01jbz3k6w8f5r4t2n9q7x0m1ab';
const props = (over: Partial<GatePromptPanelProps> = {}): GatePromptPanelProps => ({
  runId: RUN,
  run: { state: 'executing', pauseReason: null },
  roles: ['asset_owner', 'appsec_engineer'],
  currentUserId: 'approver',
  requesterId: 'requester',
  ...over,
});

const hrefOf = (name: RegExp): string | null =>
  screen.getByRole('link', { name }).getAttribute('href');

describe('GatePromptPanel states', () => {
  it.each([
    [{ state: 'executing', pauseReason: null }],
    [{ state: 'paused', pauseReason: 'kill_pending' }],
    [{ state: 'planning', pauseReason: null }],
    [{ state: 'released', pauseReason: null }],
    [{ state: 'failed', pauseReason: null }],
  ] as const)('renders nothing for %j', (run) => {
    const { container } = render(<GatePromptPanel {...props({ run: run as never })} />);
    expect(container.childElementCount).toBe(0);
  });

  it('Gate 1 summarises the plan and links to the plan view', () => {
    render(
      <GatePromptPanel
        {...props({
          run: { state: 'awaiting_gate1', pauseReason: null },
          plan: { testCaseCount: 12, classes: ['passive', 'active_safe'] as never },
        })}
      />,
    );
    expect(screen.getByText(/12 test cases, intrusiveness: passive, active_safe/)).toBeTruthy();
    expect(hrefOf(/approve plan/i)).toBe(`/runs/${RUN}/plan`);
  });

  it('Gate 3 shows the confirmed count and links to triage', () => {
    render(
      <GatePromptPanel
        {...props({
          run: { state: 'awaiting_gate3', pauseReason: null },
          confirmedFindingCount: 3,
        })}
      />,
    );
    expect(screen.getByText('3 confirmed findings awaiting release.')).toBeTruthy();
    expect(hrefOf(/triage and release/i)).toBe(`/runs/${RUN}/triage`);
  });

  it('stacks simultaneous gates in order 1, 2, 3', () => {
    render(
      <GatePromptPanel
        {...props({
          run: { state: 'awaiting_gate3', pauseReason: null },
          gates: [{ gate: 1 }, { gate: 2 }],
          events: [
            { type: 'gate.pending', ts: '2026-10-20T10:00:00.000Z', seq: 1, payload: { gate: 1 } },
            { type: 'gate.pending', ts: '2026-10-20T10:00:00.000Z', seq: 2, payload: { gate: 2 } },
          ],
        })}
      />,
    );
    const order = screen.getAllByRole('region').map((r) => r.getAttribute('data-gate'));
    expect(order).toEqual(['1', '2', '3']);
  });

  it('hides when gate.decided arrives', () => {
    const run = { state: 'awaiting_gate1', pauseReason: null } as const;
    const { container, rerender } = render(<GatePromptPanel {...props({ run })} />);
    expect(screen.getByRole('region')).toBeTruthy();
    rerender(
      <GatePromptPanel
        {...props({
          run,
          events: [
            { type: 'gate.decided', ts: '2026-10-20T10:00:00.000Z', seq: 3, payload: { gate: 1 } },
          ],
        })}
      />,
    );
    expect(container.childElementCount).toBe(0);
  });

  it('logs only run id and gate when a panel renders, once', () => {
    const seen: ClientEvent[] = [];
    const restore = setClientEventSink((e) => seen.push(e));
    const run = { state: 'awaiting_gate3', pauseReason: null } as const;
    const { rerender } = render(<GatePromptPanel {...props({ run })} />);
    rerender(<GatePromptPanel {...props({ run, confirmedFindingCount: 1 })} />);
    restore();
    expect(seen).toEqual([
      { event: 'gate_panel_rendered', route: '/runs/:id', runId: RUN, gate: 3 },
    ]);
  });
});

describe('role and separation of duties', () => {
  const gate1 = { state: 'awaiting_gate1', pauseReason: null } as const;

  it('disables approval for the requester and explains why', () => {
    render(<GatePromptPanel {...props({ run: gate1, currentUserId: 'requester' })} />);
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: /approve plan/i }).disabled).toBe(
      true,
    );
    expect(screen.getByText(/different approver \(separation of duties\)/i)).toBeTruthy();
  });

  it('fails closed when the identities are unknown', () => {
    render(<GatePromptPanel {...props({ run: gate1, currentUserId: null })} />);
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('shows a read-only waiting message to other roles', () => {
    render(<GatePromptPanel {...props({ run: gate1, roles: ['developer'] })} />);
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText('Waiting on Asset Owner.')).toBeTruthy();
  });

  it('does not let an asset owner act at Gate 3', () => {
    render(
      <GatePromptPanel
        {...props({ run: { state: 'awaiting_gate3', pauseReason: null }, roles: ['asset_owner'] })}
      />,
    );
    expect(screen.getByText('Waiting on AppSec Engineer.')).toBeTruthy();
  });
});

describe('Gate 2 countdown', () => {
  const run = { state: 'paused', pauseReason: 'gate2_pending' } as const;
  const START = Date.parse('2026-10-20T10:00:00.000Z');
  const gate = (timeoutAt: string) => ({
    gate: 2 as const,
    subject: 'class:active_exploit',
    timeoutAt,
  });

  it('ticks down on the server clock to a denial at zero, never approval', () => {
    vi.useFakeTimers({ now: START });
    render(<GatePromptPanel {...props({ run, gates: [gate('2026-10-20T10:00:03.000Z')] })} />);
    expect(screen.getByRole('timer').textContent).toBe('0:03');
    expect(screen.getByText(/No decision by .* denies this action\./)).toBeTruthy();
    expect(screen.getByText('class:active_exploit')).toBeTruthy();
    expect(hrefOf(/decide/i)).toBe(`/runs/${RUN}/gate2`);

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByRole('timer').textContent).toBe('0:02');

    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.queryByRole('timer')).toBeNull();
    expect(screen.getByRole('alert').textContent).toMatch(/Denied \(timed out\).*will be denied/);
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.queryByText(/approved/i)).toBeNull();
  });

  it('shows expired when the timeout is already past on load', () => {
    vi.useFakeTimers({ now: START });
    render(<GatePromptPanel {...props({ run, gates: [gate('2026-10-20T09:00:00.000Z')] })} />);
    expect(screen.getByRole('alert').textContent).toBe('Expired — denied.');
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('uses the server offset, not the raw client clock', () => {
    vi.useFakeTimers({ now: START });
    render(
      <GatePromptPanel
        {...props({ run, gates: [gate('2026-10-20T10:00:10.000Z')], serverOffsetMs: 7000 })}
      />,
    );
    expect(screen.getByRole('timer').textContent).toBe('0:03');
  });

  it('shows read-only waiting text to roles that cannot decide', () => {
    vi.useFakeTimers({ now: START });
    render(
      <GatePromptPanel
        {...props({ run, roles: ['appsec_engineer'], gates: [gate('2026-10-20T10:05:00.000Z')] })}
      />,
    );
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText('Waiting on Asset Owner.')).toBeTruthy();
  });
});
