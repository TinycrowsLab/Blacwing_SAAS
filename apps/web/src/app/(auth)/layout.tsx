import type { ReactNode } from 'react';

// Reserved for the IAM login screens: unauthenticated, outside the console shell.
export default function AuthLayout({ children }: { readonly children: ReactNode }): ReactNode {
  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center p-6">
      {children}
    </main>
  );
}
