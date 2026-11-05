// New assessment: a verified target, an objective, and budgets. Submitting goes to Gate 1.
import { z } from 'zod';

import {
  Card,
  CardHeader,
  Chip,
  ErrorBanner,
  INPUT_CLASS,
  Icon,
  PageHeader,
  buttonClass,
  queryText,
} from '../../../../components/demo/design';
import { ContextPanel } from '../../../../components/demo/shell';
import { getSession } from '../../../../lib/session';
import { demoApi } from '../../_lib/demo-api';
import { assetSchema } from '../../_lib/schemas';
import { createRequestAction } from '../../actions';

import type { ReactNode } from 'react';

export const dynamic = 'force-dynamic';

const listSchema = z.object({ items: z.array(assetSchema) });

const LABEL = 'flex flex-col gap-1.5 text-[12.5px] font-medium text-foreground';
const HINT = 'text-xs font-normal text-muted-foreground';
const RADIO =
  'flex cursor-pointer items-start gap-3 rounded-xl border border-border p-3.5 text-[13px] has-[:checked]:border-primary has-[:checked]:bg-primary-soft';
const DEFAULT_OBJECTIVE =
  'Black-box web assessment: OWASP Top 10 and API security. Map the attack surface, then look for injection, broken access control, authentication weaknesses, security misconfiguration and sensitive data exposure. Prove every finding with a benign probe and a negative control.';

export default async function NewRequestPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<ReactNode> {
  const session = await getSession();
  if (session === null) return null;
  const params = await searchParams;
  const { items } = listSchema.parse(await demoApi(session, '/assets'));
  const verified = items.filter((a) => a.ownership.status === 'verified');
  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        crumbs={[{ label: 'Assessments', href: '/demo' }, { label: 'New request' }]}
        title="New assessment request"
        chips={
          <Chip tone="warn" icon="clock" pill bordered>
            Goes to Gate 1
          </Chip>
        }
      />
      <ErrorBanner error={queryText(params.error)} message={queryText(params.message)} />
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_280px]">
        <form action={createRequestAction} className="flex max-w-3xl flex-col gap-5">
          <Card>
            <CardHeader title="Target and objective" meta="Only verified assets" />
            <div className="flex flex-col gap-4 p-4">
              <label className={LABEL}>
                Asset
                <select
                  name="assetId"
                  defaultValue={queryText(params.assetId)}
                  required
                  className={INPUT_CLASS}
                >
                  {verified.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name} ({a.baseUrl})
                    </option>
                  ))}
                </select>
                {verified.length === 0 ? (
                  <span className="text-xs font-normal text-bad">
                    No verified asset. Verify one in Assets first.
                  </span>
                ) : null}
              </label>
              <label className={LABEL}>
                Objective
                <textarea
                  name="objective"
                  required
                  maxLength={2000}
                  rows={5}
                  defaultValue={DEFAULT_OBJECTIVE}
                  className={`${INPUT_CLASS} h-auto py-2.5 leading-5`}
                />
                <span className={HINT}>
                  What the agents should look for. Scope is set by the asset, not by this text.
                </span>
              </label>
              <label className={LABEL}>
                Extra excluded paths
                <textarea
                  name="excludedPaths"
                  rows={2}
                  placeholder="/logout"
                  className={`${INPUT_CLASS} h-auto py-2 font-mono`}
                />
                <span className={HINT}>
                  Added to the asset&apos;s excluded paths for this assessment. One per line.
                </span>
              </label>
            </div>
          </Card>

          <Card>
            <CardHeader title="Intrusiveness" meta="The ceiling for the whole run" />
            <fieldset className="grid gap-3 p-4 md:grid-cols-2">
              <legend className="sr-only">Intrusiveness</legend>
              <label className={RADIO}>
                <input
                  type="radio"
                  name="intrusiveness"
                  value="passive"
                  className="mt-1 accent-[var(--primary)]"
                />
                <span className="flex flex-col gap-0.5">
                  <span className="font-semibold">Passive</span>
                  <span className="text-muted-foreground">
                    Read-only observation of ordinary responses.
                  </span>
                </span>
              </label>
              <label className={RADIO}>
                <input
                  type="radio"
                  name="intrusiveness"
                  value="active_safe"
                  defaultChecked
                  className="mt-1 accent-[var(--primary)]"
                />
                <span className="flex flex-col gap-0.5">
                  <span className="font-semibold">Active-safe</span>
                  <span className="text-muted-foreground">
                    Crafted GET, HEAD and OPTIONS requests that should not change state.
                  </span>
                </span>
              </label>
              <div className="flex items-start gap-3 rounded-xl border border-dashed border-border-strong bg-surface-2 p-3.5 text-[13px] text-muted-foreground md:col-span-2">
                <Icon name="warn" size={16} className="mt-0.5" />
                <span className="flex flex-col gap-0.5">
                  <span className="font-semibold text-foreground">
                    State-changing requests need Gate 2
                  </span>
                  <span>
                    POST, PUT and PATCH are never sent on their own. A human decides each one during
                    the run, and no decision means denied. DELETE is never allowed.
                  </span>
                </span>
              </div>
            </fieldset>
          </Card>

          <Card>
            <CardHeader title="Budgets" />
            <div className="grid gap-4 p-4 md:grid-cols-3">
              <label className={LABEL}>
                Requests (10 to 5000)
                <input
                  name="budgetRequests"
                  type="number"
                  min={10}
                  max={5000}
                  defaultValue={300}
                  required
                  className={INPUT_CLASS}
                />
              </label>
              <label className={LABEL}>
                Minutes (1 to 120)
                <input
                  name="budgetMinutes"
                  type="number"
                  min={1}
                  max={120}
                  defaultValue={20}
                  required
                  className={INPUT_CLASS}
                />
              </label>
              <label className={LABEL}>
                Model cost cap, USD (0.5 to 100)
                <input
                  name="costCapUsd"
                  type="number"
                  min={0.5}
                  max={100}
                  step={0.5}
                  defaultValue={5}
                  required
                  className={INPUT_CLASS}
                />
              </label>
            </div>
          </Card>

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="submit"
              disabled={verified.length === 0}
              className={buttonClass('primary', 'h-11 px-5')}
            >
              Submit to Gate 1
            </button>
            <span className="text-xs text-muted-foreground">Recorded in the run log</span>
          </div>
        </form>
        <ContextPanel
          sections={[
            {
              title: 'What happens next',
              body: 'The request waits for Gate 1. A second person must approve it. The requester cannot approve their own request.',
            },
            {
              title: 'Limits are enforced',
              body: 'Scope, method class and budgets are checked by the runner before each request, not by the agents.',
            },
          ]}
        />
      </div>
    </div>
  );
}
