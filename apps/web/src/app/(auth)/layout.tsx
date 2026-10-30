import type { ReactNode } from 'react';

// Reserved for the IAM login screens: unauthenticated, outside the console shell. Same tokens as the console
// (design/README.md, sign-in is one of the few screens where a heading word is set in brand red).
export default function AuthLayout({ children }: { readonly children: ReactNode }): ReactNode {
  return (
    <div className="flex min-h-screen flex-col bg-bg text-text">
      <main className="flex flex-1 items-center justify-center px-4 py-12">
        <div className="flex w-full max-w-[400px] flex-col gap-6 rounded-2xl border border-border bg-card p-8 shadow-[0_1px_3px_rgba(0,0,0,0.06),0_20px_60px_rgba(0,0,0,0.06)]">
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
