// Decisions: everything that waits for a person, soonest deadline first (experience spec §2). Requests during a run
// (Gate 2) are decided right here; plans (Gate 1) and proven findings (Gate 3) open where they are decided.
import Link from 'next/link';
import { z } from 'zod';

import { askedInRun } from './asked';
import { EmptyState, Icon, LinkButton, SeverityChip } from '../../../components/console/design';
import {
  Gate2Inbox,
  InboxHeading,
  InboxRefresh,
  When,
} from '../../../components/console/gate2-view';
import { callApi } from '../../../lib/api';
import { getViewer } from '../../../lib/auth';
import { objectivePhrase } from '../../../lib/plan-text';
import { dashboardSchema, findingSummarySchema } from '../../../lib/schemas';

import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Decisions' };

const findingsSchema = z.object({ items: z.array(findingSummarySchema) });

const capital = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

function Section({
  title,
  term,
  lede,
  count,
  children,
}: {
  readonly title: string;
  readonly term: string;
  readonly lede: string;
  readonly count: number;
  readonly children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3" aria-label={title}>
      <InboxHeading title={title} term={term} lede={lede} count={count} />
      {children}
    </section>
  );
}

function Row({
  href,
  title,
  sub,
  lead,
}: {
  readonly href: string;
  readonly title: ReactNode;
  readonly sub: ReactNode;
  readonly lead?: ReactNode;
}) {
  return (
    <li>
      <Link
        href={href}
        className="flex min-h-14 items-center gap-3 rounded-[14px] border border-border bg-card px-4 py-3 hover:border-gold-line hover:bg-gold-soft focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-focus"
      >
        {lead}
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          {/* Phones wrap to two lines: the objective and the time are what tell two plans apart. */}
          <span className="line-clamp-2 text-[14px] font-medium text-foreground md:line-clamp-1">
            {title}
          </span>
          <span className="line-clamp-2 text-[12.5px] text-muted-foreground md:line-clamp-1">
            {sub}
          </span>
        </span>
        <Icon name="right" size={16} className="shrink-0 text-muted-foreground" />
      </Link>
    </li>
  );
}

export default async function DecisionsPage(): Promise<ReactNode> {
  const session = await getViewer();
  if (session === null) return null;
  const [dashboard, findings] = await Promise.all([
    callApi(session, '/dashboard').then((b) => dashboardSchema.parse(b)),
    callApi(session, '/findings')
      .then((b) => findingsSchema.parse(b).items)
      .catch(() => null),
  ]);
  const gate2 = [...dashboard.pendingGate2].sort(
    (a, b) => Date.parse(a.deadlineAt) - Date.parse(b.deadlineAt),
  );
  const runIds = [...new Set(gate2.map((g) => g.runId))];
  const runs = new Map(
    await Promise.all(runIds.map(async (runId) => [runId, await askedInRun(session, runId)] as const)),
  );
  const gate2Items = gate2.map((g) => {
    const run = runs.get(g.runId);
    const a = run?.asked.get(g.id);
    return {
      gate2: g,
      body: a?.body ?? null,
      // Unknown (the event was not found): the card reads the role from the gate key.
      asRole: a === undefined ? undefined : a.asRole,
      audit: run?.audit ?? null,
    };
  });
  const plans = dashboard.requests.filter((r) => r.status === 'pending_gate1');
  const releases = (findings ?? dashboard.findings).filter((f) => f.status === 'confirmed');
  const nothing = gate2.length === 0 && plans.length === 0 && releases.length === 0;

  return (
    <div className="flex max-w-[880px] flex-col gap-7">
      <InboxRefresh />
      <header className="flex flex-col gap-1.5">
        <h1 className="m-0 text-[28px] font-semibold leading-9 tracking-[-0.01em] text-foreground">
          Decisions
        </h1>
        <p className="m-0 text-[14px] leading-[22px] text-muted-foreground">
          What waits for you, soonest deadline first. Claude never decides these for you.
        </p>
      </header>

      {/* Always mounted: a request decided here keeps its receipt after the refresh drops it from the list. */}
      <Gate2Inbox items={gate2Items} viewerName={session.user.name} />

      {nothing ? (
        <EmptyState
          icon="check"
          title="Nothing needs you right now."
          body="When Claude asks to send a request that changes data, a plan waits for your approval, or a proven issue is ready to release, it shows up here."
          action={
            <LinkButton href="/audits/new" icon="plus">
              New audit
            </LinkButton>
          }
        />
      ) : null}

      {plans.length === 0 ? null : (
        <Section
          title="Plans to approve"
          term="Gate 1"
          lede="Nothing reaches the site until a plan is approved."
          count={plans.length}
        >
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {plans.map((p) => (
              <Row
                key={p.id}
                href={`/audits/${p.id}`}
                title={`Approve the plan for ${p.assetName ?? 'your site'}`}
                sub={
                  <>
                    {capital(objectivePhrase(p.objective))} · asked by{' '}
                    {p.requester.name ?? 'a teammate'}, <When iso={p.createdAt} />
                  </>
                }
              />
            ))}
          </ul>
        </Section>
      )}

      {releases.length === 0 ? null : (
        <Section
          title="Findings to release"
          term="Gate 3"
          lede="Proven issues stay private until you release them to the report."
          count={releases.length}
        >
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {releases.map((f) => (
              <Row
                key={f.id}
                href={`/findings/${f.id}`}
                lead={<SeverityChip severity={f.severity} />}
                title={f.title}
                sub={`Proven by replay${f.assetName === null ? '' : ` · ${f.assetName}`} · release or dismiss`}
              />
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
}
