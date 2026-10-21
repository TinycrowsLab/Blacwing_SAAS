import * as React from 'react';

import { EmptyState, type EmptyStateProps } from './empty-state';
import { ErrorState } from './error-state';
import { LoadingState, type LoadingVariant } from './loading-state';

import type { ApiErrorLike } from './api-error';

export interface QueryStateProps {
  isPending: boolean;
  error?: ApiErrorLike | null;
  /** True only when the query succeeded and returned zero rows. */
  isEmpty: boolean;
  empty: Pick<EmptyStateProps, 'title' | 'description' | 'action'>;
  loadingVariant?: LoadingVariant | undefined;
  onRetry?: (() => void) | undefined;
  isRetrying?: boolean | undefined;
  children: React.ReactNode;
}

/**
 * Picks exactly one state for a query: loading, then error (403 renders PermissionDenied), then
 * empty, then content. An error always wins over emptiness so a failed query is never "no data".
 */
export function QueryState({
  isPending,
  error,
  isEmpty,
  empty,
  loadingVariant,
  onRetry,
  isRetrying,
  children,
}: QueryStateProps) {
  if (error !== undefined && error !== null) {
    return <ErrorState error={error} onRetry={onRetry} isRetrying={isRetrying} />;
  }
  if (isPending) return <LoadingState variant={loadingVariant} />;
  if (isEmpty) return <EmptyState {...empty} />;
  return <>{children}</>;
}
