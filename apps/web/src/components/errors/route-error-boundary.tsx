'use client';

import * as React from 'react';

import { ErrorState, type ApiErrorLike } from '@blackwing/ui';

import { emitClientEvent } from '../../lib/client-events';

const HTTP_INTERNAL_ERROR = 500;
const HTTP_FORBIDDEN = 403;

/**
 * Extracts only the fields safe to show or log from anything that was thrown: numeric `status`,
 * `code` and `traceId` (or Next's `digest`). `message`, `stack` and `detail` are never read, because
 * a server-originated error may carry internals or PII in them.
 */
export function toSafeApiError(thrown: unknown): ApiErrorLike {
  if (typeof thrown !== 'object' || thrown === null) return { status: HTTP_INTERNAL_ERROR };
  const rec = thrown as { status?: unknown; code?: unknown; traceId?: unknown; digest?: unknown };
  const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
  return {
    status: typeof rec.status === 'number' ? rec.status : HTTP_INTERNAL_ERROR,
    code: str(rec.code),
    traceId: str(rec.traceId) ?? str(rec.digest),
  };
}

export interface RouteErrorFallbackProps {
  error: unknown;
  reset: () => void;
  /** Route name for the metric; ids are stripped. */
  route: string;
}

/** Fallback UI shared by `error.tsx` and the in-tree boundary. */
export function RouteErrorFallback({ error, reset, route }: RouteErrorFallbackProps) {
  const safe = React.useMemo(() => toSafeApiError(error), [error]);
  return (
    <ErrorState
      error={safe}
      onRetry={reset}
      onShown={() => {
        emitClientEvent(
          safe.status === HTTP_FORBIDDEN ? 'permission_denied_view' : 'error_boundary_trip',
          route,
          { code: safe.code, traceId: safe.traceId },
        );
      }}
    />
  );
}

export interface RouteErrorBoundaryProps {
  /** Route or widget name used for the metric. */
  route: string;
  children: React.ReactNode;
  /** Custom fallback; defaults to {@link RouteErrorFallback}. */
  fallback?: (props: { error: unknown; reset: () => void }) => React.ReactNode;
  /** Called after reset so the caller can refetch. */
  onReset?: () => void;
}

interface BoundaryState {
  readonly failed: boolean;
  readonly error: unknown;
}

/**
 * Catches render errors in its subtree so one failing widget does not take down the shell. Nothing
 * is logged here beyond the whitelisted `error_boundary_trip` event (route, code, traceId); the
 * thrown message and stack are deliberately not forwarded.
 */
export class RouteErrorBoundary extends React.Component<RouteErrorBoundaryProps, BoundaryState> {
  override state: BoundaryState = { failed: false, error: undefined };

  static getDerivedStateFromError(error: unknown): BoundaryState {
    return { failed: true, error };
  }

  private readonly reset = () => {
    this.setState({ failed: false, error: undefined });
    this.props.onReset?.();
  };

  override render(): React.ReactNode {
    if (!this.state.failed) return this.props.children;
    const { fallback, route } = this.props;
    if (fallback !== undefined) return fallback({ error: this.state.error, reset: this.reset });
    return <RouteErrorFallback error={this.state.error} reset={this.reset} route={route} />;
  }
}
