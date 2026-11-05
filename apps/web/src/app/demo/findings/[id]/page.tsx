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
  ErrorBanner,
  INPUT_CLASS,
  IdChip,
  LinkButton,
  PageHeader,
  SeverityChip,
  VerdictMark,
  buttonClass,
  queryText,
} from '../../../../components/demo/design';
import { auditLine, clock } from '../../../../components/demo/run-model';
import { ContextPanel } from '../../../../components/demo/shell';
import { getSession } from '../../../../lib/session';
import { DemoApiError, demoApi } from '../../_lib/demo-api';
import { type DemoFinding, findingSchema } from '../../_lib/schemas';
import { triageFindingAction } from '../../actions';

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

function triageText(finding: DemoFinding): string {
  const { triage, status } = finding;
  if (status === 'suspected')
    return 'Pending Gate 3. Suspected findings are visible to analysts only.';
  if (status === 'confirmed') return 'Pending Gate 3.';
  if (triage === null) return 'No Gate 3 decision recorded.';
  if (status === 'released' && triage.by === null)
    return 'Released automatically: proven by deterministic replay.';
  const verb = status === 'released' ? 'Released' : 'Dismissed';
  return `${verb} by ${triage.by ?? 'the system'} at ${clock(triage.at)} UTC. Reason: ${triage.reason ?? 'none given'}`;
}

function deliveryText(delivery: DemoFinding['delivery']): string {
  if (delivery === null) return 'Not delivered: no webhook configured.';
  return delivery.status === 'delivered'
    ? `Delivered to webhook · ${delivery.detail} · ${clock(delivery.at)} UTC`
    : `Webhook delivery failed · ${delivery.detail}`;
}

export default async function DemoFindingPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly id: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<ReactNode> {
  const session = await getSession();
  if (session === null) return null;
  const { id } = await params;
  const query = await searchParams;
  const canTriage = session.roles.includes('appsec-engineer');
  let finding: DemoFinding;
  try {
    finding = findingSchema.parse(await demoApi(session, `/findings/${encodeURIComponent(id)}`));
  } catch (caught) {
    if (caught instanceof DemoApiError && caught.status === HTTP_NOT_FOUND) notFound();
    throw caught;
  }
  const base = `/demo/api/findings/${encodeURIComponent(id)}/report`;
  const { probe, control, replays } = finding.evidence;
  // Only a candidate the validator did not confirm carries a reason; it keeps it after a manual release.
  const unproven = finding.evidence.reason !== undefined;
  const released = finding.status === 'released';
  return (
    <article className="flex flex-col gap-3">
      <PageHeader
        crumbs={[
          { label: 'Findings', href: '/demo/findings' },
          { label: finding.id, mono: true },
        ]}
        title={finding.title}
        chips={<VerdictMark verdict={finding.status} />}
        actions={
          released ? (
            <>
              <LinkButton href={`${base}?format=html`} variant="secondary" icon="reports">
                Download report (HTML)
              </LinkButton>
              <LinkButton href={`${base}?format=md`} variant="secondary" icon="reports">
                Download report (Markdown)
              </LinkButton>
            </>
          ) : undefined
        }
      />
      <ErrorBanner error={queryText(query.error)} message={queryText(query.message)} />

      <div className="flex flex-wrap items-center gap-2">
        <SeverityChip severity={finding.severity} />
        {finding.cwe === null ? null : <Chip tone="neutral">{finding.cwe}</Chip>}
        {finding.owasp === null ? null : <Chip tone="neutral">{finding.owasp}</Chip>}
        {finding.agent === null ? null : (
          <span className="text-[12.5px] text-muted-foreground">
            Found by <span className="font-mono font-medium text-foreground">{finding.agent}</span>
          </span>
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

      <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_240px]">
        <div className="flex min-w-0 flex-col gap-3">
          {finding.description === null ? null : (
            <AgentText label="Description by the agent, not verified">
              <p className="m-0 whitespace-pre-wrap font-sans text-[13.5px] leading-6">
                {finding.description}
              </p>
            </AgentText>
          )}

          <Card aria-labelledby="replay-h">
            <CardHeader
              id="replay-h"
              title={
                unproven ? 'Not confirmed by the validator' : 'Confirmed by deterministic replay'
              }
            />
            <p className="px-4 pt-3 text-[13px] leading-6 text-muted-foreground">
              {unproven ? (
                finding.evidence.reason
              ) : (
                <>
                  Oracle <IdChip>{finding.oracle.type ?? 'unknown'}</IdChip>{' '}
                  <IdChip>{finding.oracle.value ?? ''}</IdChip> matched on every replay and did not
                  match on the negative control.
                </>
              )}
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

          <Card aria-labelledby="triage-h">
            <CardHeader id="triage-h" title="Gate 3 triage" meta="AppSec engineer" />
            <div className="flex flex-col gap-4 p-4 text-[13px]">
              <p className="m-0">{triageText(finding)}</p>
              {finding.status === 'dismissed' ? null : (
                <form action={triageFindingAction} className="flex flex-col gap-3">
                  <input type="hidden" name="findingId" value={finding.id} />
                  <label className="flex flex-col gap-1.5 text-[12.5px] font-medium">
                    Reason (required)
                    <input
                      name="reason"
                      required
                      minLength={8}
                      maxLength={500}
                      disabled={!canTriage}
                      placeholder="Why this finding is real, or why it is not"
                      className={INPUT_CLASS}
                    />
                  </label>
                  <div className="flex flex-wrap items-center gap-2.5">
                    {released ? null : (
                      <button
                        name="decision"
                        value="release"
                        type="submit"
                        disabled={!canTriage}
                        className={buttonClass('primary')}
                      >
                        Release
                      </button>
                    )}
                    <button
                      name="decision"
                      value="dismiss"
                      type="submit"
                      disabled={!canTriage}
                      className={buttonClass('deny')}
                    >
                      Dismiss
                    </button>
                  </div>
                  {canTriage ? null : (
                    <span className="text-xs text-muted-foreground">
                      Only an AppSec engineer can release or dismiss a finding.
                    </span>
                  )}
                </form>
              )}
              <span className="font-mono text-xs text-muted-foreground">
                {auditLine(finding.audit)}
              </span>
              {released ? (
                <span className="text-xs text-muted-foreground">
                  {deliveryText(finding.delivery)}
                </span>
              ) : null}
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
              body: 'Validator-proven findings are released automatically. Suspected findings wait for an AppSec engineer. Only released findings reach reports and the webhook.',
            },
          ]}
        />
      </div>
    </article>
  );
}
