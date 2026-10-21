'use client';

import * as React from 'react';

import { RouteErrorFallback } from '../../components/errors/route-error-boundary';

/**
 * Segment error boundary for the console. A Client Component receiving `{ error, reset }`; server
 * render errors arrive here with only a `digest`, and `error.message` is never rendered.
 */
export default function ConsoleError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <RouteErrorFallback error={error} reset={reset} route="/(console)" />;
}
