// The one way in: Google sign-in, for the administrators in BW_ADMIN_EMAILS. Auth.js sends refusals back here
// (?error=AccessDenied for an account that is not listed, another code when Google sign-in itself failed).
import { redirect } from 'next/navigation';

import { NoAccess } from './no-access';
import { buttonClass, Icon } from '../../components/console/design';
import { auth, isAdmin } from '../../lib/auth';
import { signInWithGoogle } from '../../lib/auth-actions';

import type { ReactNode } from 'react';

export const dynamic = 'force-dynamic';

function GoogleMark() {
  return (
    <svg aria-hidden="true" width={18} height={18} viewBox="0 0 48 48">
      <path
        fill="#FFC107"
        d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3 0 5.8 1.1 7.9 3l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.2-.1-2.3-.4-3.5z"
      />
      <path
        fill="#FF3D00"
        d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3 0 5.8 1.1 7.9 3l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"
      />
      <path
        fill="#4CAF50"
        d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z"
      />
      <path
        fill="#1976D2"
        d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.2-.1-2.3-.4-3.5z"
      />
    </svg>
  );
}

export default async function LoginPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<ReactNode> {
  const { error, callbackUrl } = await searchParams;
  const session = await auth();
  const email = session?.user?.email;
  if (isAdmin(email)) redirect('/');
  if (error === 'AccessDenied' || typeof email === 'string') return <NoAccess email={email} />;
  // Auth.js codes: a Google sign-in the person backed out of comes back as an OAuth callback error.
  const failure =
    typeof error !== 'string'
      ? null
      : ['OAuthCallbackError', 'OAuthSignin', 'Callback', 'access_denied'].includes(error)
        ? 'Google sign-in was cancelled. Try again.'
        : "Google sign-in didn't finish. Try again.";
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
        <div className="flex flex-col gap-1.5">
          <h1 className="text-[26px] font-semibold leading-8 tracking-[-0.01em] text-foreground">Blackwing</h1>
          <p className="text-[14px] leading-6 text-muted-foreground">
            AI penetration testing you approve at every step.
          </p>
        </div>
      </div>
      {failure !== null ? (
        <p
          role="alert"
          className="flex items-start gap-2 rounded-[10px] border border-bad bg-bad-soft px-3 py-2.5 text-[13px] text-bad"
        >
          <Icon name="warn" size={16} className="mt-0.5 shrink-0" />
          {failure}
        </p>
      ) : null}
      <form action={signInWithGoogle}>
        <input
          type="hidden"
          name="callbackUrl"
          value={typeof callbackUrl === 'string' ? callbackUrl : '/'}
        />
        <button
          type="submit"
          className={buttonClass('primary', 'h-12 w-full gap-3 rounded-xl text-[14.5px]')}
        >
          <span className="flex size-7 items-center justify-center rounded-full bg-white">
            <GoogleMark />
          </span>
          Continue with Google
        </button>
      </form>
      <p className="text-[12px] leading-5 text-muted-foreground">
        Only people your administrator added can sign in. Every sign-in and decision is recorded on the ledger.
      </p>
    </>
  );
}
