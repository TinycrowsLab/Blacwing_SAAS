// First sign-in (experience spec §3.1): the workspace is named before anything else. Outside the console group, so
// the console layout's redirect here cannot loop. A named workspace sends people straight Home.
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { WelcomeForm } from './welcome-form';
import { buttonClass } from '../../components/console/design';
import { SignOutButton } from '../../components/console/sign-out-button';
import { callApi } from '../../lib/api';
import { getViewer } from '../../lib/auth';
import { workspaceSchema } from '../../lib/schemas';
import { proposeWorkspaceName } from '../../lib/workspace-name';

import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Set up your workspace' };

const NEXT_STEPS = [
  { title: 'Next: your first target', body: "Add a site you own. We'll help you prove it's yours." },
  { title: 'Nothing runs on its own', body: 'You approve every audit before Blackwing sends a request.' },
  { title: 'Every step is recorded', body: 'Decisions go on a tamper-evident ledger.' },
] as const;

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p.charAt(0).toUpperCase())
    .join('');
}

export default async function WelcomePage(): Promise<ReactNode> {
  const session = await getViewer();
  if (session === null) redirect('/login');
  const workspace = await callApi(session, '/workspace')
    .then((body) => workspaceSchema.parse(body))
    .catch(() => null);
  if (workspace !== null && workspace.name !== null) redirect('/');
  const { email, givenName, name, image, hd } = session.user;
  const proposed = proposeWorkspaceName({ email, hd, givenName });

  return (
    <div className="min-h-dvh bg-bg text-text">
      <header className="flex items-center gap-2.5 px-4 py-4 sm:px-7 sm:py-5">
        <img src="/brand/crow-shield.png" alt="" width={24} height={24} className="object-contain" />
        <span className="text-[16px] font-semibold">Blackwing</span>
        <span className="ml-auto flex min-w-0 items-center gap-2.5 text-[12.5px] text-muted-foreground">
          {image === null ? (
            <span
              aria-hidden="true"
              className="flex size-7 shrink-0 items-center justify-center rounded-full bg-text text-[11px] font-semibold text-bg"
            >
              {initials(name)}
            </span>
          ) : (
            <img src={image} alt="" width={28} height={28} referrerPolicy="no-referrer" className="size-7 rounded-full" />
          )}
          <span className="hidden truncate sm:inline">{email}</span>
          <SignOutButton label="Use another account" />
        </span>
      </header>
      <main className="mx-auto w-full max-w-[560px] px-4 pb-16 pt-8 sm:pt-[70px]">
        <span className="mb-6 flex size-11 items-center justify-center rounded-[12px] bg-gold-soft shadow-[inset_0_0_0_1px_var(--gold-line)]">
          <img src="/brand/crow-shield.png" alt="" width={24} height={24} className="object-contain" />
        </span>
        <h1 className="m-0 text-[32px] font-semibold leading-[42px] tracking-[-0.02em]">Welcome, {givenName}.</h1>
        <p className="mt-2 text-[16px] leading-[26px] text-muted-foreground">
          Let&apos;s set up your workspace. It holds your targets, audits and findings, and the people you invite.
        </p>
        {workspace === null ? (
          <div role="alert" className="mt-8 flex flex-col items-start gap-3 rounded-[18px] border border-border bg-card p-5">
            <p className="m-0 text-[14px] text-foreground">We couldn&apos;t reach Blackwing to set up your workspace.</p>
            <Link href="/welcome" className={buttonClass('secondary')}>
              Try again
            </Link>
          </div>
        ) : (
          <WelcomeForm proposed={proposed.name} domain={proposed.domain} />
        )}
        <div className="mt-[26px] grid gap-2.5 sm:grid-cols-3">
          {NEXT_STEPS.map((s) => (
            <div key={s.title} className="rounded-[12px] bg-surface-2 px-3.5 py-3 text-[12.5px] leading-[19px] text-muted-foreground">
              <b className="mb-0.5 block text-[13px] font-medium text-foreground">{s.title}</b>
              {s.body}
            </div>
          ))}
        </div>
      </main>
    </div>
  );
}
