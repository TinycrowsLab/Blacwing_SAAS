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
  const carry = typeof returnTo === 'string' ? `returnTo=${encodeURIComponent(returnTo)}` : '';
  const href = carry === '' ? '/api/auth/login' : `/api/auth/login?${carry}`;
  // Starts Keycloak's Google broker directly (kc_idp_hint). The BFF allow-lists the value; nothing else is passed on.
  const googleHref =
    carry === '' ? '/api/auth/login?idp=google' : `/api/auth/login?idp=google&${carry}`;
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
      {message === undefined ? (
        <a
          className="inline-flex h-11 items-center justify-center rounded-lg border border-border2 bg-surface px-4 text-[14px] font-medium text-foreground no-underline hover:bg-surface2 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-focus"
          href={googleHref}
        >
          Continue with Google
        </a>
      ) : null}
    </>
  );
}
