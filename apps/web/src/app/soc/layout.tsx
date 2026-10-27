import type { Metadata } from 'next';
import type { ReactNode } from 'react';

// Public and login-free (the Customer SOC has no Blackwing account). The URL holds a credential, so it
// must never reach a search index or leak through a referrer.
export const metadata: Metadata = {
  title: 'Stop testing',
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

export default function SocLayout({ children }: { readonly children: ReactNode }): ReactNode {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center p-6">
      {children}
    </main>
  );
}
