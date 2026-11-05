// Dashboard: what is running, what waits for a human, and the latest confirmed findings.
import Link from 'next/link';

import { demoApi } from './_lib/demo-api';
import { dashboardSchema } from './_lib/schemas';
import {
  Card,
  CardHeader,
  Chip,
  Icon,
  LinkButton,
  PageHeader,
  SeverityChip,
  StatusChip,
  VerdictMark,
} from '../../components/demo/design';
import { pathOf, shortId } from '../../components/demo/run-model';
import { getSession } from '../../lib/session';

import type { ReactNode } from 'react';

export const dynamic = 'force-dynamic';

const EMPTY = 'p-4 text-[13px] text-muted-foreground';

export default async function DemoDashboard(): Promise<ReactNode> {
  const session = await getSession();
  if (session === null) return null;
  const data = dashboardSchema.parse(await demoApi(session, '/dashboard'));
  const active = data.runs.filter(
    (r) => r.state === 'running' || r.state === 'paused' || r.state === 'queued',
  );
  const stats = [
    { label: 'Assets', value: data.counts.assets, icon: 'assets' as const },
    {
      label: 'Waiting for Gate 1',
      value: data.counts.requestsPendingGate1,
      icon: 'approvals' as const,
    },
    { label: 'Running', value: data.counts.runsRunning, icon: 'assessments' as const },
    {
      label: 'Confirmed findings',
      value: data.counts.confirmedFindings,
      icon: 'findings' as const,
    },
  ];
  return (
    <div className="flex flex-col gap-3">
      <PageHeader
        crumbs={[{ label: 'Dashboard' }]}
        title="Acme Corp"
        chips={
          <span className="text-[13px] text-muted-foreground">Signed in as {data.actor.name}</span>
        }
        actions={
          <LinkButton href="/demo/requests/new" variant="primary" icon="plusCircle">
            New assessment
          </LinkButton>
        }
      />

      <dl className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        {stats.map((s) => (
          <Card key={s.label} as="div" className="flex flex-col gap-1.5 p-4">
            <dt className="flex min-h-8 items-start gap-2 text-xs text-muted-foreground">
              <Icon name={s.icon} size={15} className="mt-px shrink-0" />
              {s.label}
            </dt>
            <dd className="text-[30px] font-semibold leading-[38px] tabular-nums">{s.value}</dd>
          </Card>
        ))}
      </dl>

      <div className="grid gap-3 xl:grid-cols-2">
        <Card aria-labelledby="running-h">
          <CardHeader id="running-h" title="Running" meta="Live runs" />
          {active.length === 0 ? (
            <p className={EMPTY}>
              Nothing is running. Register a target in{' '}
              <Link className="text-primary underline" href="/demo/assets">
                Assets
              </Link>
              , then request an assessment.
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {active.map((r) => (
                <li key={r.id} className="flex items-center gap-3 px-4 py-[9px]">
                  <span
                    aria-hidden="true"
                    className={`size-[7px] shrink-0 rounded-full ${r.state === 'paused' ? 'bg-warn' : 'bg-primary'} ${r.state === 'running' ? 'motion-safe:animate-[bwpulse_1.4s_ease-in-out_infinite]' : ''}`}
                  />
                  <Link
                    className="text-[13px] font-medium text-foreground hover:text-primary hover:underline"
                    href={`/demo/runs/${r.id}`}
                  >
                    {r.assetName ?? 'Assessment'}
                  </Link>
                  <span className="font-mono text-[11.5px] text-muted-foreground">
                    run_{shortId(r.id)}
                  </span>
                  <span className="ml-auto">
                    <StatusChip value={r.state} />
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card aria-labelledby="waiting">
          <CardHeader id="waiting" title="Waiting on you" meta="No decision means deny" />
          {data.requests.length === 0 && data.pendingGate2.length === 0 ? (
            <p className={EMPTY}>No approvals are waiting.</p>
          ) : (
            <ul className="divide-y divide-border">
              {data.pendingGate2.map((g) => (
                <li key={g.id} className="flex items-center gap-3 px-4 py-[9px]">
                  <Chip tone="warn" bordered>
                    Gate 2
                  </Chip>
                  <Link
                    className="min-w-0 truncate font-mono text-[13px] text-primary hover:underline"
                    href={`/demo/approvals/gate2/${g.id}`}
                  >
                    {g.method} {pathOf(g.url)}
                  </Link>
                  <span className="ml-auto text-xs text-muted-foreground">{g.agent}</span>
                </li>
              ))}
              {data.requests.map((r) => (
                <li key={r.id} className="flex items-center gap-3 px-4 py-[9px]">
                  <Chip tone="warn" bordered>
                    Gate 1
                  </Chip>
                  <Link
                    className="min-w-0 truncate text-[13.5px] text-primary hover:underline"
                    href={`/demo/requests/${r.id}`}
                  >
                    {r.assetName ?? r.assetId}: {r.objective}
                  </Link>
                  <span className="ml-auto text-xs text-muted-foreground">
                    {r.requester.name ?? 'unknown'}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card aria-labelledby="findings">
        <CardHeader
          id="findings"
          title="Recent findings"
          meta={
            <Link className="text-primary hover:underline" href="/demo/findings">
              View all
            </Link>
          }
        />
        {data.findings.length === 0 ? (
          <p className={EMPTY}>None yet.</p>
        ) : (
          <ul className="divide-y divide-border">
            {data.findings.map((f) => (
              <li key={f.id} className="flex items-center gap-3 px-4 py-[9px]">
                <SeverityChip severity={f.severity} />
                <Link
                  className="min-w-0 text-[13px] font-medium text-foreground hover:text-primary hover:underline"
                  href={`/demo/findings/${f.id}`}
                >
                  {f.title}
                </Link>
                <span className="ml-auto">
                  <VerdictMark verdict={f.status} />
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
