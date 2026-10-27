// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, renderHook, screen, waitFor } from '@testing-library/react';
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RunDetailHeader, formatRelative } from './_components/run-detail-header';
import { RunDetailView } from './_components/run-detail-view';
import { RunStateTimeline } from './_components/run-state-timeline';
import { useRun } from './_components/use-run';
import { ApiError } from '../../../../lib/api-error';

import type { RunDetail } from '../../../../lib/run-detail';

const notFound = vi.fn((): never => {
  throw new Error('NEXT_NOT_FOUND');
});
vi.mock('next/navigation', () => ({ notFound: () => notFound() }));
const getRun = vi.fn<(id: string) => Promise<RunDetail | null>>();
vi.mock('../../../../lib/run-detail.server', () => ({ getRun: (id: string) => getRun(id) }));

const base: RunDetail = {
  publicId: 'run_01JABC7Q3M',
  state: 'executing',
  pauseReason: null,
  stateVersion: 1,
  mode: 'grey',
  trigger: 'console',
  requestedBy: 'Ada',
  assets: [{ id: 'a1', name: 'app.acme.test' }],
  startedAt: '2026-01-01T00:00:00.000Z',
  endedAt: null,
  updatedAt: '2026-01-01T00:01:00.000Z',
};

function wrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 30_000 } },
  });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

function stubFetch(...bodies: (RunDetail | number)[]) {
  const mock = vi.fn(() => {
    const next = bodies.length > 1 ? bodies.shift() : bodies[0];
    return Promise.resolve(
      typeof next === 'number' ? new Response('{}', { status: next }) : Response.json(next),
    );
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('RunStateTimeline', () => {
  it('highlights the current state and checks completed phases', () => {
    const { container } = render(<RunStateTimeline state="executing" pauseReason={null} />);
    const current = container.querySelector('[data-status="current"]');
    expect(current?.getAttribute('data-phase')).toBe('executing');
    expect(current?.getAttribute('aria-current')).toBe('step');
    expect(container.querySelector('[data-phase="recon"]')?.getAttribute('data-status')).toBe(
      'done',
    );
    expect(screen.queryByTestId('pause-reason')).toBeNull();
  });

  it('shows the pause sub-reason on the paused node', () => {
    render(<RunStateTimeline state="paused" pauseReason="cost_cap" />);
    expect(screen.getByTestId('pause-reason').textContent).toBe('Cost cap reached');
  });

  it('highlights a terminal state in the terminal row', () => {
    render(<RunStateTimeline state="killed" pauseReason={null} />);
    const row = screen.getByTestId('run-terminal-row');
    expect(row.querySelector('[data-phase="killed"]')?.getAttribute('data-status')).toBe('current');
    expect(row.querySelector('[data-phase="failed"]')?.getAttribute('data-status')).toBe(
      'upcoming',
    );
  });

  it('draft shows early phases with only draft active', () => {
    const { container } = render(<RunStateTimeline state="draft" pauseReason={null} />);
    expect(container.querySelectorAll('[data-status="done"]')).toHaveLength(0);
  });
});

describe('RunDetailHeader', () => {
  it('shows id, metadata, state badge, relative time and collapses long asset lists', () => {
    const assets = Array.from({ length: 6 }, (_, i) => ({
      id: `a${String(i)}`,
      name: `host${String(i)}`,
    }));
    render(
      <RunDetailHeader
        run={{ ...base, assets, state: 'paused', pauseReason: 'operator_pause' }}
        updatedAt={Date.now() - 120_000}
        killSlot={({ terminal }) => <button disabled={terminal}>Kill</button>}
      />,
    );
    expect(screen.getByText('run_01JABC7Q3M')).toBeTruthy();
    expect(screen.getByTestId('run-state-badge').textContent).toContain('Paused by operator');
    expect(screen.getByTestId('run-assets').textContent).toBe('host0, host1, host2 +3 more');
    expect(screen.getByTestId('run-last-updated').textContent).toContain('2 minutes ago');
    expect(screen.getByText('Ada')).toBeTruthy();
    expect(screen.getByText<HTMLButtonElement>('Kill').disabled).toBe(false);
  });

  it('tells the kill slot the run is terminal', () => {
    render(
      <RunDetailHeader
        run={{ ...base, state: 'killed', endedAt: '2026-01-01T00:02:00.000Z' }}
        updatedAt={Date.now()}
        killSlot={({ terminal }) => <button disabled={terminal}>Kill</button>}
      />,
    );
    expect(screen.getByText<HTMLButtonElement>('Kill').disabled).toBe(true);
  });

  it('formatRelative covers seconds to days', () => {
    const now = 10 * 86_400_000;
    expect(formatRelative(now - 2000, now)).toBe('just now');
    expect(formatRelative(now - 30_000, now)).toBe('30 seconds ago');
    expect(formatRelative(now - 3 * 3_600_000, now)).toBe('3 hours ago');
    expect(formatRelative(now - 2 * 86_400_000, now)).toBe('2 days ago');
  });
});

describe('useRun', () => {
  it('polls every RUN_POLL_MS when the stream is down and picks up the new state', async () => {
    vi.stubEnv('NEXT_PUBLIC_RUN_POLL_MS', '1000');
    const fetchMock = stubFetch({ ...base, state: 'killed', endedAt: '2026-01-01T00:02:00.000Z' });
    const { result } = renderHook(() => useRun(base.publicId, { initialData: base }), {
      wrapper: wrapper(),
    });
    expect(result.current.run?.state).toBe('executing');
    expect(result.current.mode).toBe('poll');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100);
    });
    await waitFor(() => {
      expect(result.current.run?.state).toBe('killed');
    });
    expect(fetchMock).toHaveBeenCalled();
    const calls = fetchMock.mock.calls.length;
    // Terminal: polling stops.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(fetchMock.mock.calls.length).toBe(calls);
  });

  it('does not poll while the stream is connected', async () => {
    vi.stubEnv('NEXT_PUBLIC_RUN_POLL_MS', '1000');
    const fetchMock = stubFetch(base);
    const { result } = renderHook(
      () => useRun(base.publicId, { initialData: base, streamConnected: true }),
      { wrapper: wrapper() },
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.mode).toBe('stream');
  });

  it('resumes polling when the stream drops', async () => {
    vi.stubEnv('NEXT_PUBLIC_RUN_POLL_MS', '1000');
    const fetchMock = stubFetch(base);
    const { rerender } = renderHook(
      ({ connected }) => useRun(base.publicId, { initialData: base, streamConnected: connected }),
      { wrapper: wrapper(), initialProps: { connected: true } },
    );
    rerender({ connected: false });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100);
    });
    expect(fetchMock).toHaveBeenCalled();
  });
});

describe('RunDetailView', () => {
  it('renders breadcrumb, header, timeline and empty slots for a draft run', () => {
    stubFetch({ ...base, state: 'draft' });
    render(<RunDetailView runId={base.publicId} initialRun={{ ...base, state: 'draft' }} />, {
      wrapper: wrapper(),
    });
    expect(screen.getByRole('navigation', { name: 'breadcrumb' }).textContent).toContain('Runs');
    expect(screen.getByTestId('run-detail-header')).toBeTruthy();
    expect(screen.getByTestId('run-state-timeline')).toBeTruthy();
    expect(screen.getAllByText('Nothing here yet.')).toHaveLength(4);
    for (const slot of ['activity', 'testCases', 'gates', 'findings']) {
      expect(document.querySelector(`[data-slot="${slot}"]`)).toBeTruthy();
    }
  });

  it('renders not found, not the last copy, once the API says 404', async () => {
    stubFetch(404);
    vi.stubEnv('NEXT_PUBLIC_RUN_POLL_MS', '1000');
    render(<RunDetailView runId={base.publicId} initialRun={base} />, { wrapper: wrapper() });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100);
    });
    await waitFor(() => {
      expect(screen.getByText('We could not find that page')).toBeTruthy();
    });
    expect(screen.queryByTestId('run-detail-header')).toBeNull();
  });

  it('warns that the state may be stale when refresh fails with a server error', async () => {
    stubFetch(503);
    vi.stubEnv('NEXT_PUBLIC_RUN_POLL_MS', '1000');
    render(<RunDetailView runId={base.publicId} initialRun={base} />, { wrapper: wrapper() });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100);
    });
    await waitFor(() => {
      expect(screen.getByTestId('run-stale-warning')).toBeTruthy();
    });
    expect(ApiError).toBeDefined();
  });
});

describe('RunDetailPage', () => {
  it('404s for an unknown or cross-tenant run and renders the view otherwise', async () => {
    const { default: Page } = await import('./page');
    getRun.mockResolvedValueOnce(null);
    await expect(Page({ params: Promise.resolve({ runId: 'run_nope1' }) })).rejects.toThrow(
      'NEXT_NOT_FOUND',
    );
    getRun.mockResolvedValueOnce(base);
    const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const element = (await Page({ params: Promise.resolve({ runId: base.publicId }) })) as {
      props: { runId: string; initialRun: RunDetail };
    };
    expect(element.props.initialRun).toEqual(base);
    expect(write).toHaveBeenCalledWith(expect.stringContaining('"route":"/runs/[runId]"'));
    write.mockRestore();
  });
});
