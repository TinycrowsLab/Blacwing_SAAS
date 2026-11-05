// Finding detail: severity, classification, the oracle, probe against negative control, the replays, a repro and the
// report download. Agent-written text is labelled not verified.
import Link from 'next/link';
import { notFound } from 'next/navigation';

import {
  AgentText,
  Card,
  CardHeader,
  Chip,
  DataTable,
  IdChip,
  LinkButton,
  PageHeader,
  SeverityChip,
  StatusChip,
} from '../../../../components/demo/design';
import { ContextPanel } from '../../../../components/demo/shell';
import { getSession } from '../../../../lib/session';
import { DemoApiError, demoApi } from '../../_lib/demo-api';
import { type DemoFinding, findingSchema } from '../../_lib/schemas';

import type { ReactNode } from 'react';

export const dynamic = 'force-dynamic';

const HTTP_NOT_FOUND = 404;

type Exchange = DemoFinding['evidence']['probe'];

function ExchangeCard({
  title,
  exchange,
  note,
}: {
  readonly title: string;
  readonly exchange: Exchange;
  readonly note: string;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-2 rounded-xl border border-border p-3.5 text-[13px]">
      <span className="text-xs font-medium text-muted-foreground">{title}</span>
      <span className="break-all font-mono text-[12.5px]">
        {exchange.request === undefined
          ? 'n/a'
          : `${exchange.request.method} ${exchange.request.url}`}
      </span>
      <span>HTTP {exchange.response?.status ?? 'n/a'}</span>
      <span className="text-xs text-muted-foreground">{note}</span>
      <AgentText label="Target response, not verified">
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all text-[12px]">
          {exchange.response?.bodyExcerpt ?? '(no body excerpt)'}
        </pre>
      </AgentText>
    </div>
  );
}

export default async function DemoFindingPage({
  params,
}: {
  readonly params: Promise<{ readonly id: string }>;
}): Promise<ReactNode> {
  const session = await getSession();
  if (session === null) return null;
  const { id } = await params;
  let finding: DemoFinding;
  try {
    finding = findingSchema.parse(await demoApi(session, `/findings/${encodeURIComponent(id)}`));
  } catch (caught) {
    if (caught instanceof DemoApiError && caught.status === HTTP_NOT_FOUND) notFound();
    throw caught;
  }
  const base = `/demo/api/findings/${encodeURIComponent(id)}/report`;
  const { probe, control, replays } = finding.evidence;
  return (
    <article className="flex flex-col gap-6">
      <PageHeader
        crumbs={[{ label: 'Findings', href: '/demo#findings' }, { label: finding.id }]}
        title={finding.title}
        chips={<StatusChip value={finding.status} />}
        actions={
          <>
            <LinkButton href={`${base}?format=html`} variant="secondary" icon="reports">
              Download report (HTML)
            </LinkButton>
            <LinkButton href={`${base}?format=md`} variant="secondary" icon="reports">
              Download report (Markdown)
            </LinkButton>
          </>
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <SeverityChip severity={finding.severity} />
        {finding.cwe === null ? null : (
          <Chip tone="neutral" bordered>
            {finding.cwe}
          </Chip>
        )}
        {finding.owasp === null ? null : (
          <Chip tone="neutral" bordered>
            {finding.owasp}
          </Chip>
        )}
        {finding.agent === null ? null : (
          <span className="text-[12.5px] text-muted-foreground">Found by {finding.agent}</span>
        )}
        {finding.runId === undefined ? null : (
          <Link
            className="ml-auto text-[13px] text-primary hover:underline"
            href={`/demo/runs/${finding.runId}`}
          >
            Back to the run
          </Link>
        )}
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_280px]">
        <div className="flex min-w-0 flex-col gap-6">
          {finding.description === null ? null : (
            <AgentText label="Description by the agent, not verified">
              <p className="m-0 whitespace-pre-wrap font-sans text-[13.5px] leading-6">
                {finding.description}
              </p>
            </AgentText>
          )}

          <Card aria-labelledby="replay-h">
            <CardHeader id="replay-h" title="Confirmed by deterministic replay" />
            <p className="px-4 pt-3 text-[13px] leading-6 text-muted-foreground">
              Oracle <IdChip>{finding.oracle.type ?? 'unknown'}</IdChip>{' '}
              <IdChip>{finding.oracle.value ?? ''}</IdChip> matched on every replay and did not
              match on the negative control.
            </p>
            <div className="p-4">
              <DataTable label="Replays" head={['Replay', 'HTTP status', 'Oracle matched']}>
                {replays.map((r) => (
                  <tr key={r.n} className="h-10">
                    <td className="px-4">Replay {r.n}</td>
                    <td className="px-4 font-mono">{r.status}</td>
                    <td className="px-4">
                      <Chip tone={r.matched ? 'ok' : 'bad'} icon={r.matched ? 'check' : 'x'} pill>
                        {r.matched ? 'Yes' : 'No'}
                      </Chip>
                    </td>
                  </tr>
                ))}
              </DataTable>
            </div>
          </Card>

          <Card aria-labelledby="evidence-h">
            <CardHeader id="evidence-h" title="Probe and negative control" />
            <div className="grid gap-4 p-4 lg:grid-cols-2">
              <ExchangeCard title="Probe" exchange={probe} note="The oracle matches here." />
              <ExchangeCard
                title="Negative control"
                exchange={control}
                note="The oracle must not match here."
              />
            </div>
          </Card>

          <Card aria-labelledby="repro-h">
            <CardHeader
              id="repro-h"
              title="Repro"
              meta="The probe is benign. No data is extracted."
            />
            <div className="p-4">
              <pre className="overflow-auto rounded-lg border border-border bg-code p-3 font-mono text-[12px] text-foreground">
                <code>{finding.reproCurl}</code>
              </pre>
            </div>
          </Card>
        </div>

        <ContextPanel
          sections={[
            {
              title: 'Severity',
              body: 'Proposed by the agent and not computed. The severity bars show four levels for critical down to one for low.',
            },
            {
              title: 'Release',
              body: 'A confirmed finding is released to the report only after Gate 3 triage in production.',
            },
          ]}
        />
      </div>
    </article>
  );
}
