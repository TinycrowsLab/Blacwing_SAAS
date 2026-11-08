// Settings (experience spec §2, §8): the workspace name (editable by an administrator), your account and theme, and
// the settings your administrator sets on the server, shown read-only with where they come from.
import { Chip, Icon, InlineMessage } from '../../../components/console/design';
import { HashFocus } from '../../../components/console/results/hash-focus';
import { HIGHLIGHT_CLASS } from '../../../components/console/results/highlight';
import { readApi } from '../../../components/console/results/load';
import {
  RetryButton,
  ThemeSetting,
  WorkspaceNameForm,
} from '../../../components/console/results/settings-form';
import { getViewer } from '../../../lib/auth';
import { usd } from '../../../lib/plan-text';
import { workspaceSchema } from '../../../lib/schemas';

import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Settings' };

const S_PER_MIN = 60;

function Section({
  id,
  title,
  note,
  children,
}: {
  readonly id?: string;
  readonly title: string;
  readonly note?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <section
      id={id}
      aria-labelledby={`${id ?? title}-h`}
      className="flex scroll-mt-6 flex-col gap-3 rounded-[14px] border border-border bg-card p-4 sm:p-5"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={`${id ?? title}-h`} className="m-0 text-[15px] font-semibold text-foreground">
          {title}
        </h2>
        {note}
      </div>
      {children}
    </section>
  );
}

function Fact({
  label,
  children,
  id,
}: {
  readonly label: string;
  readonly children: ReactNode;
  readonly id?: string;
}) {
  return (
    <div
      id={id}
      className={`-mx-2 grid scroll-mt-6 gap-1 rounded-[10px] border-t border-border px-2 pb-1 pt-3 first:border-t-0 first:pt-1 sm:grid-cols-[200px_minmax(0,1fr)] sm:gap-4 ${HIGHLIGHT_CLASS}`}
    >
      <dt className="text-[13px] text-muted-foreground">{label}</dt>
      <dd className="m-0 text-[13.5px] leading-[21px] text-foreground">{children}</dd>
    </div>
  );
}

export default async function SettingsPage(): Promise<ReactNode> {
  const session = await getViewer();
  if (session === null) return null;
  const workspace = await readApi('/workspace')
    .then((b) => workspaceSchema.parse(b))
    .catch(() => null);
  const isAdmin = session.roles.includes('org-admin');
  const s = workspace?.settings;
  const minutes = s === undefined ? 0 : Math.max(1, Math.round(s.gate2TimeoutS / S_PER_MIN));

  return (
    <div className="flex w-full max-w-[860px] flex-col gap-5">
      <HashFocus />
      <div className="flex flex-col gap-1.5">
        <h1 className="m-0 text-[28px] font-semibold leading-9 tracking-[-0.01em] text-foreground">
          Settings
        </h1>
        <p className="m-0 text-[14px] leading-[22px] text-muted-foreground">
          Your workspace and your account. Limits and connections are set by your administrator on
          the server.
        </p>
      </div>

      {workspace === null ? (
        <InlineMessage tone="bad">
          We couldn&rsquo;t load the workspace settings. <RetryButton />
        </InlineMessage>
      ) : (
        <Section title="Workspace">
          <WorkspaceNameForm current={workspace.name ?? ''} canEdit={isAdmin} />
        </Section>
      )}

      <Section title="Your account">
        <dl className="m-0 flex flex-col gap-3">
          <Fact label="Signed in with Google">
            <span className="font-medium">{session.user.name}</span>{' '}
            <span className="text-muted-foreground">{session.user.email}</span>
          </Fact>
          <Fact label="Theme">
            <ThemeSetting />
          </Fact>
        </dl>
      </Section>

      {s === undefined ? null : (
        <Section
          id="admin"
          title="Set by your administrator"
          note={
            <Chip tone="muted" icon="lock">
              Read-only
            </Chip>
          }
        >
          <dl className="m-0 flex flex-col gap-3">
            <Fact label="Audit limits">
              Each audit stops at {s.limits.minutes.min} to {s.limits.minutes.max} minutes,{' '}
              {s.limits.requests.min.toLocaleString()} to {s.limits.requests.max.toLocaleString()}{' '}
              requests and {usd(s.limits.costUsd.min)} to {usd(s.limits.costUsd.max)} of model
              spend, whichever comes first.
            </Fact>
            <Fact label="Ready-made limits">
              <ul className="m-0 flex list-none flex-col gap-1 p-0">
                {s.presets.map((p) => (
                  <li key={p.key}>
                    <span className="font-medium">{p.label}</span>{' '}
                    <span className="text-muted-foreground">
                      {p.minutes} min · {p.requests.toLocaleString()} requests · up to{' '}
                      {usd(p.costUsd)}
                    </span>
                  </li>
                ))}
              </ul>
            </Fact>
            <Fact label="Time to decide a request">
              {minutes} {minutes === 1 ? 'minute' : 'minutes'}. If nobody answers, the request is
              denied and never sent.
            </Fact>
            <Fact label="Approving your own audits">
              {s.selfApprove
                ? 'Allowed for you: you administer this workspace and may approve audits you request.'
                : 'Not allowed: a second person approves each audit.'}
            </Fact>
            <Fact label="Webhook" id="webhook">
              {s.webhook.configured ? (
                <span className="inline-flex flex-wrap items-center gap-2">
                  <Chip tone="ok" icon="check" pill>
                    Connected
                  </Chip>
                  Released issues are posted to{' '}
                  <span className="font-mono text-[12.5px]">
                    {s.webhook.host ?? 'your endpoint'}
                  </span>
                  .
                </span>
              ) : (
                <span className="flex flex-col gap-1">
                  <span className="inline-flex items-center gap-2 font-medium">
                    <Icon name="info" size={14} className="text-muted-foreground" />
                    Not connected
                  </span>
                  <span className="text-muted-foreground">
                    When your administrator adds a webhook address on the server, each issue you
                    release is posted to it, and its delivery shows on the finding.
                  </span>
                </span>
              )}
            </Fact>
          </dl>
        </Section>
      )}
    </div>
  );
}
