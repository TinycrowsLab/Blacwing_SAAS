import type { ReactNode } from 'react';

/** Redirect target of the console layout. The OIDC flow itself is owned by IAM and the BFF. */
export default function LoginPage(): ReactNode {
  return (
    <section className="space-y-3">
      <h1 className="text-xl font-semibold">Sign in to Blackwing</h1>
      <a className="underline" href="/api/auth/login">
        Continue with single sign-on
      </a>
    </section>
  );
}
