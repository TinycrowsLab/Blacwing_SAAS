/* CVSS v4 bands are FIRST's published ranges (9, 7, 4), not tunable values. */
/* eslint-disable @typescript-eslint/no-magic-numbers -- CVSS v4 severity bands, see FIRST's specification */
// DEMO-STORY finding detail: the confirmed finding, its evidence (request and response), the oracle, the replay
// results, a copyable repro and the report download.
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { z } from 'zod';

import {
  AgentText,
  Card,
  CardHeader,
  Chip,
  DataTable,
  Icon,
  IdChip,
  LinkButton,
  PageHeader,
  SeverityChip,
  StatusChip,
} from '../../../../components/demo/design';
import { ContextPanel } from '../../../../components/demo/shell';
import { getSession } from '../../../../lib/session';
import { DemoApiError, demoApi } from '../../_lib/demo-api';
import { findingSchema } from '../../_lib/schemas';

import type { ReactNode } from 'react';

export const dynamic = 'force-dynamic';

/** Text from an untyped JSON field, or empty. */
const text = (value: unknown): string => (typeof value === 'string' ? value : '');

const HTTP_NOT_FOUND = 404;

const probeSchema = z.object({
  recorded: z.boolean().optional(),
  probe: z.object({
    request: z.object({ url: z.string() }).optional(),
    response: z.object({ status: z.number(), bodyExcerpt: z.string().optional() }).optional(),
  }),
  negativeControl: z.object({
    request: z.object({ url: z.string() }).optional(),
    response: z.object({ status: z.number() }).optional(),
  }),
});

const replaySchema = z.object({
  replays: z.array(z.object({ n: z.number(), status: z.number(), matched: z.boolean() })),
  negativeControl: z.object({ status: z.number(), matched: z.boolean() }),
});

export default async function DemoFindingPage({
  params,
}: {
  readonly params: Promise<{ readonly id: string }>;
}): Promise<ReactNode> {
  const session = await getSession();
  if (session === null) return null;
  const { id } = await params;
  let finding;
  try {
    finding = findingSchema.parse(await demoApi(session, `/findings/${encodeURIComponent(id)}`));
  } catch (caught) {
    if (caught instanceof DemoApiError && caught.status === HTTP_NOT_FOUND) notFound();
    throw caught;
  }
  const evidence = probeSchema.parse(finding.evidence);
  const replay = replaySchema.parse(finding.replay);
  const base = `/demo/api/findings/${encodeURIComponent(id)}/report`;
  const score = finding.severity.cvssV4Score;
  const severity =
    score >= 9
      ? 'critical'
      : score >= 7
        ? 'high'
        : score >= 4
          ? 'medium'
          : score > 0
            ? 'low'
            : 'info';
  const oracleSignature = text(
    (finding.oracle.params as { signature?: unknown } | undefined)?.signature,
  );
  return (
    <article className="flex flex-col gap-6">
      <PageHeader
        crumbs={[{ label: 'Findings', href: '/demo' }, { label: finding.id }]}
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
        <SeverityChip severity={severity} />
        <Chip tone="neutral" bordered>
          {finding.cwe}
        </Chip>
        <Chip tone="neutral" bordered>
          {finding.owasp}
        </Chip>
        <span className="text-[12.5px] text-muted-foreground">
          CVSS v4.0 {score} (demo-assigned, not calculated)
        </span>
        <Link
          className="ml-auto text-[13px] text-primary hover:underline"
          href={`/demo/runs/${finding.runId}`}
        >
          Back to the run
        </Link>
      </div>

      {evidence.recorded === true ? (
        <p className="flex items-start gap-2.5 rounded-xl border border-warn bg-warn-soft p-4 text-[13.5px] text-warn">
          <Icon name="info" size={18} />
          Recorded fallback: this finding comes from an earlier run of the same lab image, seeded so
          the story always has a complete finding to show.
        </p>
      ) : null}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_280px]">
        <div className="flex min-w-0 flex-col gap-6">
          <Card aria-labelledby="replay-h">
            <CardHeader id="replay-h" title="Confirmed by deterministic replay" />
            <p className="px-4 pt-3 text-[13px] leading-6 text-muted-foreground">
              Oracle <IdChip>{text(finding.oracle.id)}</IdChip> (error signature{' '}
              <IdChip>{oracleSignature}</IdChip>) matched on every replay, and did not match on the
              negative control.
            </p>
            <div className="p-4">
              <DataTable label="Replays" head={['Replay', 'HTTP status', 'Oracle matched']}>
                {replay.replays.map((r) => (
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
                <tr className="h-10">
                  <td className="px-4">Negative control</td>
                  <td className="px-4 font-mono">{replay.negativeControl.status}</td>
                  <td className="px-4">
                    <Chip
                      tone={replay.negativeControl.matched ? 'bad' : 'ok'}
                      icon={replay.negativeControl.matched ? 'x' : 'check'}
                      pill
                    >
                      {replay.negativeControl.matched ? 'Yes (unexpected)' : 'No (expected)'}
                    </Chip>
                  </td>
                </tr>
              </DataTable>
            </div>
          </Card>

          <Card aria-labelledby="evidence-h">
            <CardHeader id="evidence-h" title="Evidence" />
            <div className="flex flex-col gap-4 p-4 text-[13px]">
              <p>
                Probe{' '}
                <span className="break-all font-mono text-[12.5px]">
                  {evidence.probe.request?.url ?? 'n/a'}
                </span>
                , HTTP {evidence.probe.response?.status ?? 'n/a'}
              </p>
              <AgentText label="Target response, not verified">
                <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all text-[12px]">
                  {evidence.probe.response?.bodyExcerpt ?? '(no body excerpt)'}
                </pre>
              </AgentText>
              <p>
                Negative control{' '}
                <span className="break-all font-mono text-[12.5px]">
                  {evidence.negativeControl.request?.url ?? 'n/a'}
                </span>
                , HTTP {evidence.negativeControl.response?.status ?? 'n/a'}
              </p>
            </div>
          </Card>

          <Card aria-labelledby="repro-h">
            <CardHeader
              id="repro-h"
              title="Repro"
              meta="The probe is benign. No data is extracted."
            />
            <div className="flex flex-col gap-3 p-4">
              <p className="text-[13px] text-muted-foreground">
                One quote breaks the SQL syntax on the lab target, which shows the same error
                signature.
              </p>
              <pre className="overflow-auto rounded-lg border border-border bg-code p-3 font-mono text-[12px] text-foreground">
                <code>{finding.reproCurl}</code>
              </pre>
            </div>
          </Card>
        </div>

        <ContextPanel
          sections={[
            {
              title: 'Location',
              body: `${text(finding.location.method)} ${text(finding.location.urlTemplate)}, parameter ${text(finding.location.parameter)}.`,
            },
            {
              title: 'Severity',
              body: 'The CVSS v4.0 score is fixed for the story and is not computed. Severity bars: critical has four, low has one.',
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
