import Link from 'next/link';

import type { ReactNode } from 'react';

export default function NotFound(): ReactNode {
  return (
    <main className="bw-canvas flex min-h-screen flex-col items-center justify-center gap-4 bg-bg px-4 text-center text-text">
      <img src="/brand/crow-shield.png" alt="" width={40} height={40} className="object-contain" />
      <h1 className="text-[24px] font-semibold leading-8">Page not found</h1>
      <p className="max-w-sm text-[13.5px] leading-6 text-muted-foreground">
        The page does not exist, or it was moved.
      </p>
      <Link
        href="/"
        className="inline-flex h-10 items-center rounded-lg bg-primary px-4 text-[13px] font-medium text-on-primary no-underline hover:brightness-90"
      >
        Back to the dashboard
      </Link>
    </main>
  );
}
