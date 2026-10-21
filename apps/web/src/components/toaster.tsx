'use client';

import { ToastProvider, ToastViewport } from '@blackwing/ui';

import type { ReactNode } from 'react';

/** Mount point for toasts: provider around the tree plus the viewport they render into. */
export function Toaster({ children }: { readonly children?: ReactNode }): ReactNode {
  return (
    <ToastProvider>
      {children}
      <ToastViewport />
    </ToastProvider>
  );
}
