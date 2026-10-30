/* CVSS v4 bands are FIRST's published ranges (9, 7, 4), not tunable values. */
/* eslint-disable @typescript-eslint/no-magic-numbers -- CVSS v4 severity bands, see FIRST's specification */
// DEMO-STORY live run (design 1a, flight deck). The first render is server-side; the client polls the demo route.
// Pause and Kill are shown with the design's controls, but the demo API has no runtime control (Gate 2 and Kill are
// not part of the story), so they are disabled and say why.
import { notFound } from 'next/navigation';

import {
  Icon,
  IdChip,
  LinkButton,
  PageHeader,
  buttonClass,
} from '../../../../components/demo/design';
import { RunTimeline } from '../../../../components/demo/run-timeline';
import { ContextPanel } from '../../../../components/demo/shell';
import { getSession } from '../../../../lib/session';
import { DemoApiError, demoApi } from '../../_lib/demo-api';
import {
  type DemoFinding,
  type DemoRun,
  type DemoRequest,
  findingSchema,
  requestSchema,
  runSchema,
} from '../../_lib/schemas';

import type { ReactNode } from 'react';

export const dynamic = 'force-dynamic';

const HTTP_NOT_FOUND = 404;

export default async function DemoRunPage({
  params,
}: {
  readonly params: Promise<{ readonly id: string }>;
}): Promise<ReactNode> {
  const session = await getSession();
  if (session === null) return null;
  const { id } = await params;
  let run: DemoRun;
  try {
    run = runSchema.parse(await demoApi(session, `/runs/${encodeURIComponent(id)}?afterSeq=0`));
  } catch (caught) {
    if (caught instanceof DemoApiError && caught.status === HTTP_NOT_FOUND) notFound();
    throw caught;
  }
  const request: DemoRequest = requestSchema.parse(
    await demoApi(session, `/requests/${encodeURIComponent(run.requestId)}`),
  );
  let finding: DemoFinding | null = null;
  if (run.findingId !== null) {
    finding = findingSchema.parse(
      await demoApi(session, `/findings/${encodeURIComponent(run.findingId)}`),
    );
  }
  const scope = `${String(request.scope.host)}${String(request.scope.pathPrefix)}`;
  const authItems = [
    { k: 'Scope', v: `GET ${scope}` },
    { k: 'Intrusiveness', v: request.intrusiveness.replace(/_/g, '-') },
    { k: 'Gate 1 approved by', v: request.approver?.name ?? 'not yet' },
    { k: 'Budget', v: `${request.budget.requests} requests, ${request.budget.seconds} s` },
  ];
  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        crumbs={[{ label: 'Assessments', href: '/demo' }, { label: run.id }]}
        title={request.testCaseId}
        actions={
          <>
            <button
              type="button"
              disabled
              title="Pause is a runtime control. The demo has no pause."
              className={buttonClass('secondary', 'h-10')}
            >
              <Icon name="pause" size={15} />
              Pause run
            </button>
            <button
              type="button"
              disabled
              title="Kill is not part of the demo story (KILL #170)."
              className={buttonClass('kill', 'h-11 px-5')}
            >
              <Icon name="kill" size={17} />
              Kill run
            </button>
            <LinkButton href={`/demo/requests/${run.requestId}`} variant="ghost" icon="approvals">
              Back to the request
            </LinkButton>
          </>
        }
      />
      <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-muted-foreground">
        <IdChip>{run.id}</IdChip>
        <span>Pinned test case, oracle, runner version and lab target.</span>
      </div>
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_260px]">
        <RunTimeline
          runId={run.id}
          initial={run}
          requestTitle={scope}
          authItems={authItems}
          findingTitle={finding?.title ?? null}
          findingSeverity={
            finding === null ? null : severityFromScore(finding.severity.cvssV4Score)
          }
        />
        <ContextPanel
          sections={[
            {
              title: 'Who sees it',
              body: 'Asset Owners, AppSec and the SOC can pause and kill. Developers see a read-only view. Auditors see the ledger version.',
            },
            {
              title: 'Audited',
              body: 'Pause, resume, kill, Gate decisions and opening the run manifest.',
            },
            {
              title: 'Agent text',
              body: 'Agent and runner text is labelled. It is evidence, not instruction, and is not verified until the validator replays it.',
            },
          ]}
        />
      </div>
    </div>
  );
}

/** CVSS v4 score to the design's severity names (FIRST ranges). */
function severityFromScore(score: number): string {
  if (score >= 9) return 'critical';
  if (score >= 7) return 'high';
  if (score >= 4) return 'medium';
  if (score > 0) return 'low';
  return 'info';
}
