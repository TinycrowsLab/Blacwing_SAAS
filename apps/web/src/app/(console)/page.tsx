// Home (experience spec §3.2): the assistant's greeting and one field. A first visit explains how an audit works; a
// returning person also sees what waits for them, what is in progress and the latest findings (each hidden when empty).
import Link from 'next/link';

import { Icon, type IconName, SeverityChip, StatusChip, VoiceTag } from '../../components/console/design';
import { Countdown } from '../../components/console/design-client';
import { HomeAsk } from '../../components/console/order/home-ask';
import { HomeRetry } from '../../components/console/order/home-retry';
import { greetingFor } from '../../components/console/order/shared';
import { callApi } from '../../lib/api';
import { getViewer } from '../../lib/auth';
import { decisionTitle } from '../../lib/plan-text';
import { type Dashboard, dashboardSchema, LIVE_RUN_STATES } from '../../lib/schemas';

import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Home' };

const RECENT_FINDINGS = 5;

const HOW = [
  { n: 1, who: 'you', tag: 'You · 1 min', title: 'Tell me what to audit', body: "The site, how you prove it's yours, what worries you, and how careful to be." },
  { n: 2, who: 'you', tag: 'You', title: 'Approve the plan', body: 'I read the whole plan back in plain words. Nothing runs before you approve.' },
  { n: 3, who: 'claude', tag: 'Claude', title: "Claude's team works", body: 'You watch the agents plan, test and hand off. Anything that changes data waits for you.' },
  { n: 4, who: 'you', tag: 'You', title: 'Release the findings', body: 'Only proven issues, most serious first. You decide what reaches the report.' },
] as const;

const TRUST: readonly { icon: IconName; text: string }[] = [
  { icon: 'shield', text: "Only sites you've proven are yours" },
  { icon: 'kill', text: 'Stop testing at any moment' },
  { icon: 'ledger', text: 'Every decision on a tamper-evident ledger' },
];

const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

function Section({ id, title, more, children }: { readonly id: string; readonly title: string; readonly more?: ReactNode; readonly children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-2.5">
      <div className="flex items-center gap-3">
        <h2 id={id} className="m-0 text-[13px] font-medium text-muted-foreground">
          {title}
        </h2>
        <span aria-hidden="true" className="h-px flex-1 bg-border" />
        {more}
      </div>
      <ul className="m-0 flex list-none flex-col divide-y divide-border overflow-hidden rounded-[14px] border border-border bg-card p-0">
        {children}
      </ul>
    </section>
  );
}

function Row({ href, dot, title, sub, end }: { readonly href: string; readonly dot: string; readonly title: ReactNode; readonly sub: ReactNode; readonly end?: ReactNode }) {
  return (
    <li>
      <Link href={href} className="flex min-h-14 items-center gap-3 px-4 py-2.5 no-underline hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-inset focus-visible:ring-focus">
        <span aria-hidden="true" className={`size-2 shrink-0 rounded-full ${dot}`} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-[14px] font-medium text-foreground">{title}</span>
          <span className="truncate text-[12.5px] text-muted-foreground">{sub}</span>
        </span>
        {end}
        <Icon name="right" size={16} className="shrink-0 text-muted-foreground" />
      </Link>
    </li>
  );
}

function Returning({ d }: { readonly d: Dashboard }) {
  const plans = d.requests.filter((r) => r.status === 'pending_gate1');
  const releases = d.findings.filter((f) => f.status === 'confirmed');
  const live = d.runs.filter((r) => LIVE_RUN_STATES.includes(r.state));
  const waiting = d.pendingGate2.length + plans.length + releases.length;
  return (
    <>
      {waiting === 0 ? null : (
        <Section id="home-waiting" title="Waiting on you">
          {d.pendingGate2.map((g) => (
            <Row
              key={g.id}
              href={`/decisions/gate2/${g.id}`}
              dot="bg-gold"
              title={decisionTitle(g.method, g.url)}
              sub={
                <>
                  {g.run?.assetName ?? hostOf(g.url)} · No answer means denied
                </>
              }
              end={<Countdown deadlineAt={g.deadlineAt} {...(g.createdAt === undefined ? {} : { createdAt: g.createdAt })} className="text-[12.5px]" />}
            />
          ))}
          {plans.map((r) => (
            <Row key={r.id} href={`/audits/${r.id}`} dot="bg-gold" title={`Approve the plan for ${r.assetName ?? 'your site'}`} sub="The plan is ready for your approval" />
          ))}
          {releases.map((f) => (
            <Row
              key={f.id}
              href={`/findings/${f.id}`}
              dot="bg-gold"
              title={f.title}
              sub={`Proven${f.assetName === null ? '' : ` on ${f.assetName}`} · release or dismiss`}
              end={<SeverityChip severity={f.severity} />}
            />
          ))}
        </Section>
      )}
      {live.length === 0 ? null : (
        <Section id="home-live" title="In progress">
          {live.map((r) => (
            <Row
              key={r.id}
              href={`/runs/${r.id}`}
              dot="bg-slate motion-safe:animate-[bwpulse_1.4s_ease-in-out_infinite]"
              title={r.assetName ?? 'Audit'}
              sub={`${r.requestsUsed.toLocaleString()} requests so far`}
              end={<StatusChip value={r.paused ? 'paused' : r.state} />}
            />
          ))}
        </Section>
      )}
      {d.findings.length === 0 ? null : (
        <Section
          id="home-findings"
          title="Recent findings"
          more={
            <Link href="/findings" className="text-[12.5px] font-medium text-gold-ink hover:underline">
              All findings
            </Link>
          }
        >
          {d.findings.slice(0, RECENT_FINDINGS).map((f) => (
            <Row
              key={f.id}
              href={`/findings/${f.id}`}
              dot="bg-border-strong"
              title={f.title}
              sub={f.assetName ?? 'Finding'}
              end={<SeverityChip severity={f.severity} />}
            />
          ))}
        </Section>
      )}
    </>
  );
}

function HowItWorks() {
  return (
    <>
      <section aria-labelledby="home-how" className="flex flex-col gap-3">
        <div className="flex items-center gap-3">
          <h2 id="home-how" className="m-0 text-[13px] font-medium text-muted-foreground">
            How your audit works
          </h2>
          <span aria-hidden="true" className="h-px flex-1 bg-border" />
        </div>
        <ol className="m-0 grid list-none gap-2.5 p-0 sm:grid-cols-2 lg:grid-cols-4">
          {HOW.map((s) => (
            <li key={s.n} className="flex flex-col gap-2 rounded-[14px] border border-border bg-card p-4">
              <span className="flex items-center gap-2">
                <span className="flex size-6 items-center justify-center rounded-full bg-surface-2 text-[12px] font-semibold tabular-nums text-foreground">
                  {s.n}
                </span>
                <VoiceTag voice={s.who}>{s.tag}</VoiceTag>
              </span>
              <span className="text-[14.5px] font-semibold leading-5 text-foreground">{s.title}</span>
              <span className="text-[12.5px] leading-[19px] text-muted-foreground">{s.body}</span>
            </li>
          ))}
        </ol>
      </section>
      <ul className="m-0 flex list-none flex-wrap gap-x-5 gap-y-2 p-0 text-[12.5px] text-muted-foreground">
        {TRUST.map((t) => (
          <li key={t.text} className="flex items-center gap-2">
            <Icon name={t.icon} size={14} className="text-gold-ink" />
            {t.text}
          </li>
        ))}
      </ul>
    </>
  );
}

export default async function HomePage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<ReactNode> {
  const session = await getViewer();
  if (session === null) return null;
  const [params, dashboard] = await Promise.all([
    searchParams,
    callApi(session, '/dashboard')
      .then((b) => dashboardSchema.parse(b))
      .catch(() => null),
  ]);
  // Nothing live, waiting or found yet: explain how an audit works instead of empty lists.
  const firstVisit =
    dashboard !== null &&
    dashboard.pendingGate2.length === 0 &&
    dashboard.requests.every((r) => r.status !== 'pending_gate1') &&
    dashboard.runs.every((r) => !LIVE_RUN_STATES.includes(r.state)) &&
    dashboard.findings.length === 0;
  return (
    <div className="mx-auto flex w-full max-w-[780px] flex-col gap-9 pb-10 pt-2 md:pt-8">
      <HomeAsk
        givenName={session.user.givenName}
        serverGreeting={greetingFor(new Date().getHours())}
        named={params.named === '1'}
      />
      {dashboard === null ? <HomeRetry /> : firstVisit ? <HowItWorks /> : <Returning d={dashboard} />}
    </div>
  );
}
