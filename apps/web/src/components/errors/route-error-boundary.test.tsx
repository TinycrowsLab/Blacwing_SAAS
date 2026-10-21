// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RouteErrorBoundary, toSafeApiError } from './route-error-boundary';
import { setClientEventSink, type ClientEvent } from '../../lib/client-events';

afterEach(cleanup);

const SECRET = 'Bearer abcdefghijklmnop jane@example.com at secretFn (/srv/app.js:1:2)';

function Bomb({ fail, error }: { fail: boolean; error?: unknown }) {
  if (fail) throw (error ?? new Error(SECRET)) as Error;
  return <p>widget ok</p>;
}

describe('toSafeApiError', () => {
  it('reads only status, code and traceId (or digest)', () => {
    expect(
      toSafeApiError({ status: 403, code: 'FORBIDDEN', traceId: 't1', message: SECRET }),
    ).toEqual({
      status: 403,
      code: 'FORBIDDEN',
      traceId: 't1',
    });
    expect(toSafeApiError({ digest: '123' }).traceId).toBe('123');
    expect(toSafeApiError('string')).toEqual({ status: 500 });
    expect(toSafeApiError(null)).toEqual({ status: 500 });
  });
});

describe('RouteErrorBoundary', () => {
  it('isolates a failing widget, hides internals, counts the trip and resets', async () => {
    const events: ClientEvent[] = [];
    const restore = setClientEventSink((e) => events.push(e));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let fail = true;
    const Wrapper = () => (
      <div>
        <p>shell</p>
        <RouteErrorBoundary route="/runs/12345">
          <Bomb
            fail={fail}
            error={Object.assign(new Error(SECRET), { code: 'BOOM', traceId: 'tr-1' })}
          />
        </RouteErrorBoundary>
      </div>
    );
    const { container, rerender } = render(<Wrapper />);
    expect(screen.getByText('shell')).toBeTruthy();
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(container.textContent).not.toContain('Bearer');
    expect(container.textContent).not.toContain('jane@example.com');
    expect(container.textContent).not.toContain('app.js');
    expect(container.textContent).toContain('tr-1');
    expect(events).toEqual([
      { event: 'error_boundary_trip', route: '/runs/:id', code: 'BOOM', traceId: 'tr-1' },
    ]);
    expect(JSON.stringify(events)).not.toContain('Bearer');

    fail = false;
    rerender(<Wrapper />);
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(screen.getByText('widget ok')).toBeTruthy();
    spy.mockRestore();
    restore();
  });

  it('renders PermissionDenied and counts permission_denied_view for a thrown 403', () => {
    const events: ClientEvent[] = [];
    const restore = setClientEventSink((e) => events.push(e));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(
      <RouteErrorBoundary route="/settings">
        <Bomb fail error={{ status: 403, code: 'FORBIDDEN' }} />
      </RouteErrorBoundary>,
    );
    expect(screen.getByText('You do not have access')).toBeTruthy();
    expect(events[0]?.event).toBe('permission_denied_view');
    spy.mockRestore();
    restore();
  });

  it('uses a custom fallback and calls onReset', async () => {
    const onReset = vi.fn();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(
      <RouteErrorBoundary
        route="/x"
        onReset={onReset}
        fallback={({ reset }) => <button onClick={reset}>custom reset</button>}
      >
        <Bomb fail />
      </RouteErrorBoundary>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'custom reset' }));
    expect(onReset).toHaveBeenCalledOnce();
    spy.mockRestore();
  });
});
