'use client';

// DEMO-STORY: signs out through the existing BFF (CSRF header, then the Keycloak end-session URL). Used to switch
// from the requester to the approver for Gate 1, so the second approval is a real second login.
import { useState } from 'react';

export function SignOutButton() {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  async function signOut() {
    setBusy(true);
    setFailed(false);
    try {
      const session = await fetch('/api/auth/session', { headers: { accept: 'application/json' }, cache: 'no-store' });
      const body = (await session.json()) as { csrfToken?: unknown };
      if (typeof body.csrfToken !== 'string') throw new Error('no session');
      const res = await fetch('/api/auth/logout', {
        method: 'POST',
        headers: { accept: 'application/json', 'x-bw-csrf': body.csrfToken },
      });
      const out = (await res.json()) as { redirectTo?: unknown };
      window.location.href = typeof out.redirectTo === 'string' ? out.redirectTo : '/login';
    } catch {
      setFailed(true);
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      onClick={() => void signOut()}
      disabled={busy}
      className="rounded border border-neutral-400 px-3 py-1 hover:bg-neutral-200 disabled:opacity-50 dark:hover:bg-neutral-800"
    >
      {failed ? 'Sign out failed, retry' : busy ? 'Signing out…' : 'Sign out'}
    </button>
  );
}
