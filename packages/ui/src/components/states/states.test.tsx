// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  EmptyState,
  ErrorState,
  LoadingState,
  NotFound,
  PermissionDenied,
  QueryState,
  classifyApiError,
  retryDelayMs,
  sanitizeDetail,
  MAX_DETAIL_CHARS,
} from '../../index';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('classifyApiError / sanitizeDetail', () => {
  it('distinguishes 403, 404, 401, 429, 5xx, 4xx and network', () => {
    expect(classifyApiError({ status: 403 })).toBe('permission-denied');
    expect(classifyApiError({ status: 404 })).toBe('not-found');
    expect(classifyApiError({ status: 401 })).toBe('unauthenticated');
    expect(classifyApiError({ status: 429 })).toBe('rate-limited');
    expect(classifyApiError({ status: 503 })).toBe('server');
    expect(classifyApiError({ status: 422 })).toBe('client');
    expect(classifyApiError({})).toBe('network');
  });

  it('drops stack frames, redacts secrets and PII and caps length', () => {
    const out = sanitizeDetail(
      'failed for jane@example.com with Bearer abcdefghijkl\n    at run (/srv/x.js:10:5)\nfn@http://h/a.js:1:2\nok line',
    );
    expect(out).toBe('failed for [REDACTED] with Bearer [REDACTED]\nok line');
    expect(sanitizeDetail('x'.repeat(MAX_DETAIL_CHARS * 5))?.length).toBe(MAX_DETAIL_CHARS + 1);
    expect(sanitizeDetail('   ')).toBeUndefined();
    expect(sanitizeDetail('    at a (b.js:1:2)')).toBeUndefined();
    expect(sanitizeDetail(undefined)).toBeUndefined();
  });
});

describe('LoadingState', () => {
  it.each(['spinner', 'table', 'card', 'detail'] as const)(
    'renders the %s variant as a busy status',
    (v) => {
      render(<LoadingState variant={v} label="Loading runs" />);
      const el = screen.getByRole('status');
      expect(el.getAttribute('aria-busy')).toBe('true');
      expect(el.textContent).toContain('Loading runs');
      expect(el.className).toContain('motion-reduce');
    },
  );

  it('bounds table rows', () => {
    const { container } = render(<LoadingState variant="table" rows={9999} />);
    expect(container.querySelectorAll('[aria-hidden="true"]').length).toBe(51);
  });
});

describe('EmptyState / NotFound', () => {
  it('renders title, description and action', () => {
    render(<EmptyState title="No runs" description="Start one" action={<button>Start</button>} />);
    expect(screen.getByRole('status').textContent).toContain('No runs');
    expect(screen.getByRole('button', { name: 'Start' })).toBeTruthy();
  });

  it('NotFound renders defaults', () => {
    render(<NotFound />);
    expect(screen.getByText('We could not find that page')).toBeTruthy();
  });
});

describe('PermissionDenied', () => {
  it('is an alert, names the permission and contact, and reports once', () => {
    const onShown = vi.fn();
    render(
      <PermissionDenied permission="run:create" contact="the tenant owner" onShown={onShown} />,
    );
    const el = screen.getByRole('alert');
    expect(el.textContent).toContain('run:create');
    expect(el.textContent).toContain('the tenant owner');
    expect(onShown).toHaveBeenCalledOnce();
  });
});

describe('ErrorState', () => {
  it('shows friendly copy, code and traceId and never raw internals', () => {
    const { container } = render(
      <ErrorState
        error={{
          status: 500,
          code: 'INTERNAL',
          traceId: 'trace-abc',
          detail: 'Error: x\n    at f (/srv/a.js:1:2)\npostgres://u:pw@db/x failed',
        }}
      />,
    );
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(container.textContent).toContain('Something went wrong on our side');
    expect(container.textContent).toContain('INTERNAL');
    expect(container.textContent).toContain('trace-abc');
    expect(container.textContent).not.toContain('a.js');
    expect(container.textContent).not.toContain('u:pw');
  });

  it('drops a malformed code or traceId instead of rendering it', () => {
    const { container } = render(
      <ErrorState error={{ status: 500, code: '<script>', traceId: 'a b c' }} />,
    );
    expect(container.textContent).not.toContain('script');
    expect(container.textContent).not.toContain('Trace ID');
  });

  it('renders PermissionDenied for 403, never a generic failure', () => {
    render(<ErrorState error={{ status: 403 }} onRetry={() => undefined} />);
    expect(screen.getByText('You do not have access')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('truncates long detail with expand and collapse', async () => {
    render(<ErrorState error={{ status: 400, detail: 'a'.repeat(600) }} />);
    const detail = () => screen.getByTestId('error-detail').textContent;
    expect(detail().length).toBe(201);
    await userEvent.click(screen.getByRole('button', { name: 'Show more' }));
    expect(detail().length).toBe(600);
    await userEvent.click(screen.getByRole('button', { name: 'Show less' }));
    expect(detail().length).toBe(201);
  });

  it('copies the trace id, and reports a clipboard failure', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<ErrorState error={{ status: 500, traceId: 'tr-9' }} />);
    await user.click(screen.getByRole('button', { name: 'Copy trace ID' }));
    expect(writeText).toHaveBeenCalledWith('tr-9');
    expect(await screen.findByText('Copied')).toBeTruthy();
    cleanup();
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
      configurable: true,
    });
    render(<ErrorState error={{ status: 500, traceId: 'tr-9' }} />);
    await user.click(screen.getByRole('button', { name: 'Copy trace ID' }));
    expect(await screen.findByText('Copy failed')).toBeTruthy();
  });

  it('Retry backs off between clicks and disables while refetching', () => {
    vi.useFakeTimers();
    const onRetry = vi.fn();
    render(<ErrorState error={{ status: 500 }} onRetry={onRetry} />);
    const btn = () => screen.getByRole<HTMLButtonElement>('button', { name: 'Retry' });
    act(() => {
      btn().click();
    });
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(btn().disabled).toBe(true);
    act(() => {
      vi.advanceTimersByTime(999);
    });
    expect(btn().disabled).toBe(true);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(btn().disabled).toBe(false);
    act(() => {
      btn().click();
    });
    expect(onRetry).toHaveBeenCalledTimes(2);
    act(() => {
      vi.advanceTimersByTime(1999);
    });
    expect(btn().disabled).toBe(true);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(btn().disabled).toBe(false);
  });

  it('disables Retry while isRetrying', () => {
    render(<ErrorState error={{ status: 500 }} onRetry={() => undefined} isRetrying />);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Retrying' }).disabled).toBe(true);
  });

  it('retryDelayMs doubles and caps', () => {
    expect([1, 2, 3, 4, 20].map((n) => retryDelayMs(n))).toEqual([0, 1000, 2000, 4000, 30000]);
  });
});

describe('QueryState', () => {
  const empty = { title: 'No rows' };

  it('loading, empty, error, forbidden and content are mutually exclusive', () => {
    const { rerender } = render(
      <QueryState isPending isEmpty={false} empty={empty}>
        content
      </QueryState>,
    );
    expect(screen.getByRole('status').getAttribute('aria-busy')).toBe('true');
    rerender(
      <QueryState isPending={false} isEmpty empty={empty}>
        content
      </QueryState>,
    );
    expect(screen.getByText('No rows')).toBeTruthy();
    rerender(
      <QueryState isPending={false} isEmpty empty={empty} error={{ status: 500, traceId: 't' }}>
        content
      </QueryState>,
    );
    expect(screen.queryByText('No rows')).toBeNull();
    expect(screen.getByText('Something went wrong on our side')).toBeTruthy();
    rerender(
      <QueryState isPending={false} isEmpty empty={empty} error={{ status: 403 }}>
        content
      </QueryState>,
    );
    expect(screen.queryByText('No rows')).toBeNull();
    expect(screen.getByText('You do not have access')).toBeTruthy();
    rerender(
      <QueryState isPending={false} isEmpty={false} empty={empty}>
        content
      </QueryState>,
    );
    expect(screen.getByText('content')).toBeTruthy();
  });
});
