import { loginErrorMessage } from '../../../lib/auth/login-error';

import type { ReactNode } from 'react';

/** Redirect target of the console layout; the OIDC flow itself runs in the BFF route handlers. */
export default async function LoginPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<ReactNode> {
  const { error, returnTo } = await searchParams;
  const message = typeof error === 'string' ? loginErrorMessage(error) : undefined;
  // The BFF re-validates returnTo as an internal path; here it is only carried along.
  const href =
    typeof returnTo === 'string'
      ? `/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`
      : '/api/auth/login';
  return (
    <>
      <div className="flex flex-col items-start gap-4">
        <img
          src="/brand/crow-shield.png"
          alt=""
          width={44}
          height={44}
          className="object-contain"
        />
        <h1 className="text-[26px] font-semibold leading-8 text-foreground">
          Sign in to <span className="text-kill">Blackwing</span>
        </h1>
        <p className="text-[13.5px] leading-6 text-muted-foreground">
          Blackwing runs assessments only under human authorisation. Sign in with your organisation
          account.
        </p>
      </div>
      {message === undefined ? null : (
        <p
          role="alert"
          className="flex items-start gap-2 rounded-lg border border-bad bg-bad-soft p-3 text-[13px] text-bad"
        >
          {message}
        </p>
      )}
      <a
        className="inline-flex h-11 items-center justify-center rounded-lg bg-primary px-4 text-[14px] font-medium text-on-primary no-underline hover:brightness-90 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-focus"
        href={href}
      >
        {message === undefined ? 'Continue with single sign-on' : 'Try again'}
      </a>
    </>
  );
}
