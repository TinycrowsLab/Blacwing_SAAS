'use client';

import { AlertTriangle } from 'lucide-react';
import * as React from 'react';

import { cn } from '../../lib/cn';
import { Button } from '../button';
import {
  classifyApiError,
  errorCopy,
  safeCode,
  safeTraceId,
  sanitizeDetail,
  type ApiErrorLike,
} from './api-error';
import { PermissionDenied } from './permission-denied';

/** Characters of detail shown before "Show more". */
const COLLAPSED_DETAIL_CHARS = 200;
/** Retry backoff: first retry is immediate, then 1s, 2s, 4s ... capped. */
const BACKOFF_BASE_MS = 1000;
const BACKOFF_CAP_MS = 30_000;

/** Delay before the Retry button re-enables after the `attempt`-th click (1-based). */
export function retryDelayMs(attempt: number): number {
  if (attempt <= 1) return 0;
  return Math.min(BACKOFF_BASE_MS * 2 ** (attempt - 2), BACKOFF_CAP_MS);
}

export interface ErrorStateProps extends React.HTMLAttributes<HTMLDivElement> {
  error: ApiErrorLike;
  /** Retry action; the button is hidden when omitted. */
  onRetry?: (() => void) | undefined;
  /** True while the retried query is refetching; disables Retry. */
  isRetrying?: boolean | undefined;
  /** Called once when shown (metrics). */
  onShown?: (() => void) | undefined;
}

/**
 * Friendly failure state. Renders fixed copy by error kind, the machine `code` and a copyable
 * `traceId`; never `error.message`, stacks or raw bodies. A 403 renders {@link PermissionDenied}
 * instead, so a forbidden query is never shown as a generic failure.
 */
export function ErrorState({
  error,
  onRetry,
  isRetrying = false,
  onShown,
  className,
  ...props
}: ErrorStateProps) {
  const kind = classifyApiError(error);
  const code = safeCode(error.code);
  const traceId = safeTraceId(error.traceId);
  const detail = React.useMemo(() => sanitizeDetail(error.detail), [error.detail]);
  const [expanded, setExpanded] = React.useState(false);
  const [copied, setCopied] = React.useState<'idle' | 'copied' | 'failed'>('idle');
  const [attempts, setAttempts] = React.useState(0);
  const [cooling, setCooling] = React.useState(false);
  const timer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const shown = React.useRef(onShown);
  shown.current = onShown;

  React.useEffect(() => {
    if (kind !== 'permission-denied') shown.current?.();
  }, [kind]);
  React.useEffect(
    () => () => {
      if (timer.current !== undefined) clearTimeout(timer.current);
    },
    [],
  );

  if (kind === 'permission-denied') {
    return <PermissionDenied className={className} onShown={onShown} {...props} />;
  }

  const copy = errorCopy(kind);

  const retry = () => {
    if (onRetry === undefined || cooling || isRetrying) return;
    const next = attempts + 1;
    setAttempts(next);
    const delay = retryDelayMs(next + 1);
    if (delay > 0) {
      setCooling(true);
      timer.current = setTimeout(() => {
        setCooling(false);
      }, delay);
    }
    onRetry();
  };

  const copyTrace = async () => {
    if (traceId === undefined) return;
    try {
      await navigator.clipboard.writeText(traceId);
      setCopied('copied');
    } catch {
      setCopied('failed');
    }
  };

  const long = detail !== undefined && detail.length > COLLAPSED_DETAIL_CHARS;
  const shownDetail =
    detail !== undefined && long && !expanded
      ? `${detail.slice(0, COLLAPSED_DETAIL_CHARS)}…`
      : detail;

  return (
    <div
      role="alert"
      data-state="error"
      className={cn('flex flex-col items-center gap-2 p-8 text-center', className)}
      {...props}
    >
      <AlertTriangle aria-hidden="true" className="h-8 w-8 text-danger" />
      <h2 className="text-base font-semibold text-foreground">{copy.title}</h2>
      <p className="max-w-prose text-sm text-muted-foreground">{copy.description}</p>
      {shownDetail !== undefined && (
        <div className="max-w-prose text-sm text-muted-foreground">
          <p className="whitespace-pre-wrap break-words" data-testid="error-detail">
            {shownDetail}
          </p>
          {long && (
            <button
              type="button"
              className="text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-expanded={expanded}
              onClick={() => {
                setExpanded((v) => !v);
              }}
            >
              {expanded ? 'Show less' : 'Show more'}
            </button>
          )}
        </div>
      )}
      {(code !== undefined || traceId !== undefined) && (
        <dl className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1 font-mono text-xs text-muted-foreground">
          {code !== undefined && (
            <div className="flex gap-1">
              <dt>Code</dt>
              <dd>{code}</dd>
            </div>
          )}
          {traceId !== undefined && (
            <div className="flex items-center gap-1">
              <dt>Trace ID</dt>
              <dd>{traceId}</dd>
              <Button
                size="sm"
                variant="ghost"
                aria-label="Copy trace ID"
                onClick={() => {
                  void copyTrace();
                }}
              >
                {copied === 'copied' ? 'Copied' : copied === 'failed' ? 'Copy failed' : 'Copy'}
              </Button>
            </div>
          )}
        </dl>
      )}
      {onRetry !== undefined && (
        <Button
          variant="outline"
          onClick={retry}
          disabled={isRetrying || cooling}
          aria-busy={isRetrying}
        >
          {isRetrying ? 'Retrying' : 'Retry'}
        </Button>
      )}
    </div>
  );
}
