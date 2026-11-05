/* eslint-disable @typescript-eslint/no-magic-numbers -- display truncation (ids, hashes, timestamps) */
// Audit ledger (demo schema): every gated decision, hash-chained. The chain is re-verified on each load.
import { Card, Chip, DataTable, PageHeader } from '../../../components/demo/design';
import { auditEventLabel, clock } from '../../../components/demo/run-model';
import { getSession } from '../../../lib/session';
import { demoApi } from '../_lib/demo-api';
import { auditListSchema } from '../_lib/schemas';

import type { ReactNode } from 'react';

export const dynamic = 'force-dynamic';

export default async function DemoAuditPage(): Promise<ReactNode> {
  const session = await getSession();
  if (session === null) return null;
  const { items, chain } = auditListSchema.parse(await demoApi(session, '/audit'));
  return (
    <div className="flex flex-col gap-3">
      <PageHeader
        crumbs={[{ label: 'Audit ledger' }]}
        title="Audit ledger"
        chips={
          chain.verified ? (
            <Chip tone="ok" icon="check" pill>
              Chain verified
            </Chip>
          ) : (
            <Chip tone="bad" icon="x" pill bordered>
              Chain broken at #{chain.brokenAtSeq}
            </Chip>
          )
        }
      />
      <p className="max-w-3xl text-[13.5px] leading-6 text-muted-foreground">
        {chain.count} events. Each event&apos;s hash covers the previous one, so changing any row
        breaks the chain. Demo schema, not the production ledger.
      </p>
      <Card>
        <DataTable
          label="Audit events"
          head={['#', 'Time (UTC)', 'Actor', 'Action', 'Target', 'Event', 'Hash']}
        >
          {items.map((e) => (
            <tr key={e.eventId}>
              <td className="px-4 py-3 font-mono text-xs text-muted-foreground">{e.seq}</td>
              <td className="whitespace-nowrap px-4 py-3 font-mono text-xs">
                {e.at.slice(0, 10)} {clock(e.at)}
              </td>
              <td className="px-4 py-3">{e.actor.name}</td>
              <td className="px-4 py-3">
                <span className="rounded-md bg-surface-2 px-2 py-0.5 font-mono text-xs">
                  {e.action}
                </span>
                {e.payload.selfApproved ? (
                  <span className="ml-2">
                    <Chip tone="warn" pill>
                      Self-approved by admin
                    </Chip>
                  </span>
                ) : null}
              </td>
              <td className="px-4 py-3 font-mono text-xs">
                {e.targetType} {e.targetId.slice(0, 8)}
              </td>
              <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
                evt_{auditEventLabel(e.eventId)}
              </td>
              <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
                sha256:{e.hash.slice(0, 4)}...{e.hash.slice(-4)}
              </td>
            </tr>
          ))}
        </DataTable>
        {items.length === 0 ? (
          <p className="p-4 text-[13px] text-muted-foreground">No decisions recorded yet.</p>
        ) : null}
      </Card>
    </div>
  );
}
