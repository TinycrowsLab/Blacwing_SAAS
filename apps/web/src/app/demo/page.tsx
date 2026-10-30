// DEMO-STORY dashboard: the starting point of the story. Shows what is pending and the next click.
import Link from 'next/link';

import { demoApi } from './_lib/demo-api';
import { dashboardSchema } from './_lib/schemas';
import {
  Card,
  CardHeader,
  DataTable,
  Icon,
  LinkButton,
  PageHeader,
  StatusChip,
} from '../../components/demo/design';
import { ContextPanel } from '../../components/demo/shell';
import { getSession } from '../../lib/session';

import type { ReactNode } from 'react';

export const dynamic = 'force-dynamic';

export default async function DemoDashboard(): Promise<ReactNode> {
  const session = await getSession();
  if (session === null) return null;
  const data = dashboardSchema.parse(await demoApi(session, '/dashboard'));
  const stats = [
    { label: 'Assets', value: data.counts.assets, icon: 'assets' as const },
    {
      label: 'Waiting for Gate 1',
      value: data.counts.requestsPendingGate1,
      icon: 'approvals' as const,
    },
    { label: 'Runs', value: data.counts.runs, icon: 'assessments' as const },
    {
      label: 'Confirmed findings',
      value: data.counts.confirmedFindings,
      icon: 'findings' as const,
    },
  ];
  return (
    <div className="flex flex-col gap-6">
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
      <p className="max-w-3xl text-[13.5px] leading-6 text-muted-foreground">
        Story: register the lab asset, request an assessment, get a second approval, run it, read
        the confirmed finding and download the report.
      </p>

      <dl className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        {stats.map((s) => (
          <Card key={s.label} as="div" className="flex flex-col gap-2 p-4">
            <dt className="flex items-center gap-2 text-xs text-muted-foreground">
              <Icon name={s.icon} size={15} />
              {s.label}
            </dt>
            <dd className="text-[28px] font-semibold leading-9 tabular-nums">{s.value}</dd>
          </Card>
        ))}
      </dl>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_260px]">
        <div className="flex min-w-0 flex-col gap-6">
          <Card aria-labelledby="requests-h">
            <CardHeader id="requests-h" title="Assessment requests" meta="Newest first" />
            {data.requests.length === 0 ? (
              <p className="p-4 text-[13px] text-muted-foreground">
                No requests yet. Start with{' '}
                <Link className="text-primary underline" href="/demo/assets">
                  Assets
                </Link>
                .
              </p>
            ) : (
              <DataTable
                label="Assessment requests"
                head={['Request', 'Intrusiveness', 'Status', 'Requested by']}
              >
                {data.requests.map((r) => (
                  <tr key={r.id} className="h-12 hover:bg-primary-soft/40">
                    <td className="px-4">
                      <Link
                        className="font-mono text-[12.5px] text-primary hover:underline"
                        href={`/demo/requests/${r.id}`}
                      >
                        {r.testCaseId}
                      </Link>
                    </td>
                    <td className="px-4 font-mono text-xs text-muted-foreground">
                      {r.intrusiveness}
                    </td>
                    <td className="px-4">
                      <StatusChip value={r.status} />
                    </td>
                    <td className="px-4 text-muted-foreground">{r.requester.name ?? 'unknown'}</td>
                  </tr>
                ))}
              </DataTable>
            )}
          </Card>

          <Card aria-labelledby="findings-h">
            <CardHeader
              id="findings-h"
              title="Confirmed findings"
              meta="Released only after Gate 3"
            />
            {data.findings.length === 0 ? (
              <p className="p-4 text-[13px] text-muted-foreground">None yet.</p>
            ) : (
              <ul className="divide-y divide-border">
                {data.findings.map((f) => (
                  <li key={f.id} className="flex items-center justify-between gap-3 px-4 py-3">
                    <Link
                      className="text-[13.5px] font-medium text-primary hover:underline"
                      href={`/demo/findings/${f.id}`}
                    >
                      {f.title}
                    </Link>
                    <StatusChip value="confirmed" />
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
        <ContextPanel
          sections={[
            {
              title: 'Next click',
              body:
                data.counts.requestsPendingGate1 > 0
                  ? 'A request is waiting for Gate 1. A second person has to approve it.'
                  : 'Pick an asset and request an assessment. Nothing runs until Gate 1 approves it.',
            },
            {
              title: 'No answer means no',
              body: 'A request without a decision does not run. Destructive tests are never allowed.',
            },
          ]}
        />
      </div>
    </div>
  );
}
