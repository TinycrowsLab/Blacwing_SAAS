// Sign-in screens: outside the console shell, on the console canvas, with the tinycrows lockup underneath.
import { ThemeToggle } from '../../components/console/theme-toggle';

import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = { title: 'Sign in' };

export default function LoginLayout({ children }: { readonly children: ReactNode }): ReactNode {
  return (
    <div className="bw-canvas flex min-h-screen flex-col bg-bg text-text">
      <div className="flex justify-end px-5 pt-4">
        <ThemeToggle />
      </div>
      <main className="flex flex-1 items-center justify-center px-4 pb-12">
        <div className="flex w-full max-w-[420px] flex-col gap-6 rounded-2xl border border-border bg-surface p-8">
          {children}
        </div>
      </main>
      <footer className="flex items-center justify-center gap-2 pb-6 text-xs text-muted-foreground">
        <span>Powered by</span>
        <img
          src="/brand/tinycrows.png"
          alt="tinycrows"
          width={96}
          height={36}
          className="h-9 w-auto object-contain"
        />
      </footer>
    </div>
  );
}
