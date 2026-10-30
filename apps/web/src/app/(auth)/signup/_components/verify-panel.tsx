'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';

import { signupVerifiedSchema, type SignupVerified } from '@blackwing/contracts';

import { type ApiClient, createApiClient } from '../../../../lib/api-client';
import { ApiError } from '../../../../lib/api-error';

export interface VerifyPanelProps {
  /** Test seam; the page uses the shared API client. */
  readonly api?: Pick<ApiClient, 'post'>;
}

const defaultApi = createApiClient();

type State =
  | { readonly kind: 'checking' }
  | { readonly kind: 'created'; readonly slug: string }
  | { readonly kind: 'existing_account' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'failed' };

/**
 * The verification token from the link's fragment (`/signup/verify#token=...`). A fragment is never sent to
 * the server in the request line, so the token only travels in the verify request body.
 */
export function readTokenFromHash(hash: string): string | undefined {
  const token = new URLSearchParams(hash.replace(/^#/, '')).get('token');
  return token === null || token === '' ? undefined : token;
}

/**
 * Consumes the token from the emailed link once and shows the outcome. The fragment is removed from the
 * address bar straight away, so the token is not left in history.
 */
export function VerifyPanel({ api = defaultApi }: VerifyPanelProps): ReactNode {
  const [state, setState] = useState<State>({ kind: 'checking' });
  const started = useRef(false);

  useEffect(() => {
    // StrictMode runs effects twice; the second run must not POST the already-consumed token again.
    if (started.current) return;
    started.current = true;
    const token = readTokenFromHash(window.location.hash);
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
    if (token === undefined) {
      setState({ kind: 'invalid' });
      return;
    }
    void api
      .post('/signup/verify', signupVerifiedSchema, { token })
      .then((result: SignupVerified) => {
        setState(
          result.outcome === 'tenant_created'
            ? { kind: 'created', slug: result.slug }
            : { kind: 'existing_account' },
        );
      })
      .catch((cause: unknown) => {
        const invalid = cause instanceof ApiError && cause.code === 'SIGNUP_TOKEN_INVALID';
        setState({ kind: invalid ? 'invalid' : 'failed' });
      });
  }, [api]);

  switch (state.kind) {
    case 'checking':
      return (
        <p role="status" className="text-[14px] text-muted-foreground">
          Verifying your link...
        </p>
      );
    case 'created':
      return (
        <div className="flex flex-col gap-3">
          <h1 className="text-[22px] font-semibold text-foreground">Your organisation is ready</h1>
          <p className="text-[14px] leading-6 text-foreground">
            The workspace <span className="font-mono">{state.slug}</span> has been created. Sign in
            to start.
          </p>
          <a className="text-[14px] font-medium text-primary" href="/api/auth/login">
            Sign in
          </a>
        </div>
      );
    case 'existing_account':
      return (
        <div className="flex flex-col gap-3">
          <h1 className="text-[22px] font-semibold text-foreground">Sign in instead</h1>
          <p className="text-[14px] leading-6 text-foreground">
            This address already has a Blackwing account, so no new organisation was created.
          </p>
          <a className="text-[14px] font-medium text-primary" href="/login">
            Go to sign in
          </a>
        </div>
      );
    case 'invalid':
      return (
        <div className="flex flex-col gap-3">
          <h1 className="text-[22px] font-semibold text-foreground">This link has expired</h1>
          <p role="alert" className="text-[14px] leading-6 text-bad">
            The verification link is invalid, expired or already used. Request a new one.
          </p>
          <a className="text-[14px] font-medium text-primary" href="/signup">
            Start again
          </a>
        </div>
      );
    case 'failed':
      return (
        <p role="alert" className="text-[14px] leading-6 text-bad">
          We could not verify your link. Try again in a moment.
        </p>
      );
  }
}
