// DEMO-STORY dashboard: the starting point of the story. Shows what is pending and the next click.
import Link from 'next/link';

import { StatusPill } from '../../components/demo/status-pill';
import { demoApi } from './_lib/demo-api';
import { dashboardSchema } from './_lib/schemas';
import { getSession } from '../../lib/session';

import type { ReactNode } from 'react';

export const dynamic = 'force-dynamic';

export default async function DemoDashboard(): Promise<ReactNode> {
  const session = await getSession();
  if (session === null) return null;
  const data = dashboardSchema.parse(await demoApi(session, '/dashboard'));
  return (
    <div className="space-y-6">
      <section>
        <h1 className="text-2xl font-semibold">Dashboard</h1>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          Signed in as {data.actor.name}. Story: register the lab asset, request an assessment, get a second approval,
          run it, read the confirmed finding and download the report.
        </p>
      </section>
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          ['Assets', data.counts.assets],
          ['Waiting for Gate 1', data.counts.requestsPendingGate1],
          ['Runs', data.counts.runs],
          ['Confirmed findings', data.counts.confirmedFindings],
        ].map(([label, value]) => (
          <div key={String(label)} className="rounded border border-neutral-300 p-3 dark:border-neutral-700">
            <dt className="text-xs text-neutral-600 dark:text-neutral-400">{label}</dt>
            <dd className="text-2xl font-semibold">{value}</dd>
          </div>
        ))}
      </dl>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Assessment requests</h2>
        {data.requests.length === 0 ? (
          <p className="text-sm">No requests yet. Start with <Link className="underline" href="/demo/assets">Assets</Link>.</p>
        ) : (
          <ul className="divide-y divide-neutral-200 rounded border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
            {data.requests.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 p-3 text-sm">
                <Link className="underline" href={`/demo/requests/${r.id}`}>
                  {r.testCaseId} ({r.intrusiveness})
                </Link>
                <span className="flex items-center gap-2">
                  <StatusPill value={r.status} />
                  <span className="text-neutral-600 dark:text-neutral-400">requested by {r.requester.name ?? 'unknown'}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Confirmed findings</h2>
        {data.findings.length === 0 ? (
          <p className="text-sm">None yet.</p>
        ) : (
          <ul className="list-disc pl-5 text-sm">
            {data.findings.map((f) => (
              <li key={f.id}>
                <Link className="underline" href={`/demo/findings/${f.id}`}>
                  {f.title}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

