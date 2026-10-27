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
    <section className="space-y-3">
      <h1 className="text-xl font-semibold">Sign in to Blackwing</h1>
      {message === undefined ? null : (
        <p role="alert" className="text-sm text-danger">
          {message}
        </p>
      )}
      <a className="underline" href={href}>
        {message === undefined ? 'Continue with single sign-on' : 'Try again'}
      </a>
    </section>
  );
}
