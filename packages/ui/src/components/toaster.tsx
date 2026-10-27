'use client';

import * as React from 'react';
import { useSyncExternalStore } from 'react';

import { Button } from './button';
import { safeTraceId } from './states/api-error';
import {
  Toast,
  ToastClose,
  ToastDescription,
  ToastProvider,
  ToastTitle,
  ToastViewport,
} from './toast';
import { cn } from '../lib/cn';

export type ToastVariant = 'default' | 'success' | 'destructive';

/** Console-wide toast settings (the web app supplies its own via `apps/web/src/lib/toast-config.ts`). */
export interface ToasterConfig {
  /** Newest toasts kept on screen; older ones are dropped when a new one would exceed this. */
  readonly maxVisible: number;
  readonly defaultDurationMs: number;
  /** Errors stay longer so they can be read and their trace id copied. */
  readonly errorDurationMs: number;
  readonly position: 'bottom-right' | 'top-right';
}

export const DEFAULT_TOASTER_CONFIG: ToasterConfig = {
  maxVisible: 3,
  defaultDurationMs: 5000,
  errorDurationMs: 8000,
  position: 'bottom-right',
};

export interface ToastOptions {
  readonly title: string;
  /** Fixed, caller-written copy. Never pass raw server text here. */
  readonly description?: string | undefined;
  /** Support correlation id; only short id tokens are shown, anything else is dropped. */
  readonly traceId?: string | undefined;
}

interface ToastItem {
  readonly id: number;
  readonly variant: ToastVariant;
  readonly title: string;
  readonly description: string | undefined;
  readonly traceId: string | undefined;
}

const POSITION_CLASS: Record<ToasterConfig['position'], string> = {
  'bottom-right': 'bottom-0 right-0',
  'top-right': 'top-0 right-0',
};

let items: readonly ToastItem[] = [];
let nextId = 1;
let maxVisible = DEFAULT_TOASTER_CONFIG.maxVisible;
const listeners = new Set<() => void>();

function setItems(next: readonly ToastItem[]): void {
  items = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function add(variant: ToastVariant, options: ToastOptions): number {
  const id = nextId;
  nextId += 1;
  const item: ToastItem = {
    id,
    variant,
    title: options.title,
    description: options.description,
    traceId: safeTraceId(options.traceId),
  };
  setItems([...items, item].slice(-maxVisible));
  return id;
}

function dismiss(id: number): void {
  setItems(items.filter((item) => item.id !== id));
}

/**
 * Imperative toast API. Each call returns the toast id. `error` is announced assertively and
 * `success`/`info` politely; the newest `maxVisible` toasts stay on screen.
 */
export const toast = Object.assign((options: ToastOptions): number => add('default', options), {
  info: (options: ToastOptions): number => add('default', options),
  success: (options: ToastOptions): number => add('success', options),
  error: (options: ToastOptions): number => add('destructive', options),
  dismiss,
});

/** Test seam: clears every toast and resets the visible cap. */
export function resetToasts(): void {
  setItems([]);
  maxVisible = DEFAULT_TOASTER_CONFIG.maxVisible;
}

function TraceId({ value }: { readonly value: string }) {
  const [copied, setCopied] = React.useState(false);
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <span>Trace ID</span>
      <code className="select-all break-all font-mono">{value}</code>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-6 px-2"
        onClick={() => {
          navigator.clipboard
            .writeText(value)
            .then(() => {
              setCopied(true);
            })
            .catch(() => {
              // The clipboard may be blocked; the id stays visible to copy by hand.
            });
        }}
      >
        {copied ? 'Copied' : 'Copy trace ID'}
      </Button>
    </div>
  );
}

const noItems: readonly ToastItem[] = [];

/** Mount once in the app providers. Renders the store's toasts into the viewport. */
export function Toaster({
  config = DEFAULT_TOASTER_CONFIG,
  className,
}: {
  readonly config?: ToasterConfig;
  readonly className?: string;
}) {
  React.useEffect(() => {
    maxVisible = config.maxVisible;
  }, [config.maxVisible]);
  const visible = useSyncExternalStore(
    subscribe,
    () => items,
    () => noItems,
  );
  return (
    <ToastProvider swipeDirection="right">
      {visible.map((item) => {
        const isError = item.variant === 'destructive';
        return (
          <Toast
            key={item.id}
            variant={item.variant}
            type={isError ? 'foreground' : 'background'}
            duration={isError ? config.errorDurationMs : config.defaultDurationMs}
            onOpenChange={(open) => {
              if (!open) dismiss(item.id);
            }}
          >
            <div className="grid min-w-0 gap-1">
              <ToastTitle>{item.title}</ToastTitle>
              {item.description !== undefined && (
                <ToastDescription>{item.description}</ToastDescription>
              )}
              {item.traceId !== undefined && <TraceId value={item.traceId} />}
            </div>
            <ToastClose />
          </Toast>
        );
      })}
      <ToastViewport className={cn(POSITION_CLASS[config.position], className)} />
    </ToastProvider>
  );
}
