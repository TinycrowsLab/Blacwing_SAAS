import { Loader2 } from 'lucide-react';
import * as React from 'react';

import { cn } from '../../lib/cn';
import { Skeleton } from '../skeleton';

/** Upper bound on skeleton rows. */
const MAX_ROWS = 50;

export type LoadingVariant = 'spinner' | 'table' | 'card' | 'detail';

export interface LoadingStateProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: LoadingVariant | undefined;
  /** Accessible label announced to assistive technology. */
  label?: string | undefined;
  /** Rows for the `table` variant. */
  rows?: number | undefined;
}

/** Skeleton or spinner placeholder for a query in flight. Animation stops under `prefers-reduced-motion`. */
export function LoadingState({
  variant = 'spinner',
  label = 'Loading',
  rows = 5,
  className,
  ...props
}: LoadingStateProps) {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy="true"
      data-state="loading"
      className={cn('motion-reduce:[&_*]:animate-none', className)}
      {...props}
    >
      <span className="sr-only">{label}</span>
      {variant === 'spinner' && (
        <div className="flex items-center justify-center p-8 text-muted-foreground">
          <Loader2 aria-hidden="true" className="h-6 w-6 animate-spin motion-reduce:animate-none" />
        </div>
      )}
      {variant === 'table' && (
        <div className="space-y-2" data-variant="table">
          <Skeleton className="h-8 w-full" />
          {Array.from({ length: Math.max(1, Math.min(rows, MAX_ROWS)) }, (_, i) => (
            <Skeleton key={i} className="h-6 w-full motion-reduce:animate-none" />
          ))}
        </div>
      )}
      {variant === 'card' && (
        <div className="space-y-3 rounded-lg border border-border p-6" data-variant="card">
          <Skeleton className="h-5 w-1/3" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-2/3" />
        </div>
      )}
      {variant === 'detail' && (
        <div className="space-y-4" data-variant="detail">
          <Skeleton className="h-8 w-1/2" />
          <Skeleton className="h-4 w-1/4" />
          <Skeleton className="h-32 w-full" />
        </div>
      )}
    </div>
  );
}
