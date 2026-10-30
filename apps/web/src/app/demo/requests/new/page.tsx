// DEMO-STORY: create an assessment request (scope, intrusiveness class, budget). Submitting goes to Gate 1.
import { z } from 'zod';

import {
  Card,
  CardHeader,
  Icon,
  INPUT_CLASS,
  PageHeader,
  buttonClass,
  Chip,
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

export default async function NewRequestPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<ReactNode> {
  const session = await getSession();
  if (session === null) return null;
  const params = await searchParams;
  const preselected = typeof params.assetId === 'string' ? params.assetId : undefined;
  const error = typeof params.error === 'string' ? params.error : undefined;
  const message = typeof params.message === 'string' ? params.message : undefined;
  const { items } = listSchema.parse(await demoApi(session, '/assets'));
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
      {error === undefined ? null : (
        <p
          role="alert"
          className="flex items-start gap-2.5 rounded-xl border border-bad bg-bad-soft p-4 text-[13.5px] text-bad"
        >
          <Icon name="x" size={18} />
          <span>
            <strong className="font-semibold">{error}</strong>:{' '}
            {message ?? 'The request was refused.'}
          </span>
        </p>
      )}
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_280px]">
        <form action={createRequestAction} className="flex max-w-3xl flex-col gap-5">
          <Card>
            <CardHeader title="Target and test case" meta="The case is pinned to the lab target" />
            <div className="grid gap-4 p-4 md:grid-cols-2">
              <label className={LABEL}>
                Asset
                <select name="assetId" defaultValue={preselected} required className={INPUT_CLASS}>
                  {items.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name} ({a.ownership.status})
                    </option>
                  ))}
                </select>
              </label>
              <label className={LABEL}>
                Test case
                <select
                  name="testCaseId"
                  defaultValue="webapi.injection.sql"
                  className={INPUT_CLASS}
                >
                  <option value="webapi.injection.sql">
                    SQL injection in product search (WSTG-INPV-05, CWE-89)
                  </option>
                </select>
              </label>
              <label className={LABEL}>
                Scope host
                <input
                  name="scopeHost"
                  defaultValue="127.0.0.1"
                  required
                  className={`${INPUT_CLASS} font-mono`}
                />
                <span className="text-xs font-normal text-muted-foreground">
                  Hostname or wildcard.
                </span>
              </label>
              <label className={LABEL}>
                Scope path prefix
                <input
                  name="scopePath"
                  defaultValue="/rest/products/search"
                  required
                  className={`${INPUT_CLASS} font-mono`}
                />
                <span className="text-xs font-normal text-muted-foreground">
                  Matches the endpoints in the test case.
                </span>
              </label>
            </div>
          </Card>

          <Card>
            <CardHeader
              title="Intrusiveness class"
              meta="Pick the most passive class that can prove the case"
            />
            <fieldset className="grid gap-3 p-4 md:grid-cols-2">
              <legend className="sr-only">Intrusiveness class</legend>
              <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-border p-3.5 text-[13px] has-[:checked]:border-primary has-[:checked]:bg-primary-soft">
                <input
                  type="radio"
                  name="intrusiveness"
                  value="passive"
                  className="mt-1 accent-[var(--primary)]"
                />
                <span className="flex flex-col gap-0.5">
                  <span className="font-semibold">Passive</span>
                  <span className="text-muted-foreground">
                    No crafted traffic. Refused for this case.
                  </span>
                </span>
              </label>
              <label className="flex cursor-pointer items-start gap-3 rounded-xl border-[1.5px] border-primary bg-primary-soft p-3.5 text-[13px]">
                <input
                  type="radio"
                  name="intrusiveness"
                  value="active_safe"
                  defaultChecked
                  className="mt-1 accent-[var(--primary)]"
                />
                <span className="flex flex-col gap-0.5">
                  <span className="flex items-center gap-2 font-semibold">
                    Active-safe{' '}
                    <Chip tone="primary" pill>
                      Selected
                    </Chip>
                  </span>
                  <span className="text-muted-foreground">
                    Crafted requests that should not change state.
                  </span>
                </span>
              </label>
              <div className="flex items-start gap-3 rounded-xl border border-border p-3.5 text-[13px] opacity-60">
                <span
                  className="mt-1 size-4 rounded-full border-[1.5px] border-border-strong"
                  aria-hidden="true"
                />
                <span className="flex flex-col gap-0.5">
                  <span className="font-semibold">State-changing</span>
                  <span className="text-muted-foreground">
                    Needs Gate 1 and a reversal journal. Refused by policy in this demo.
                  </span>
                </span>
              </div>
              <div className="flex items-start gap-3 rounded-xl border border-dashed border-border-strong bg-surface-2 p-3.5 text-[13px] text-muted-foreground">
                <Icon name="lock" size={16} className="mt-0.5" />
                <span className="flex flex-col gap-0.5">
                  <span className="font-semibold">Destructive</span>
                  <span>Never allowed in Blackwing. This cannot be changed by any role.</span>
                </span>
              </div>
            </fieldset>
          </Card>

          <Card>
            <CardHeader title="Budget" />
            <div className="grid gap-4 p-4 md:grid-cols-2">
              <label className={LABEL}>
                Requests (max 20)
                <input
                  name="budgetRequests"
                  type="number"
                  min={1}
                  max={20}
                  defaultValue={8}
                  required
                  className={INPUT_CLASS}
                />
              </label>
              <label className={LABEL}>
                Seconds (60 to 900)
                <input
                  name="budgetSeconds"
                  type="number"
                  min={60}
                  max={900}
                  defaultValue={300}
                  required
                  className={INPUT_CLASS}
                />
              </label>
            </div>
          </Card>

          <div className="flex flex-wrap items-center gap-3">
            <button type="submit" className={buttonClass('primary', 'h-11 px-5')}>
              Submit to Gate 1
            </button>
            <span className="text-xs text-muted-foreground">Recorded in the audit ledger</span>
          </div>
        </form>

        <div className="flex flex-col gap-4">
          <ContextPanel
            sections={[
              {
                title: 'What happens next',
                body: 'The request waits for Gate 1. A second person must approve it. The requester cannot approve their own request.',
              },
              {
                title: 'Refused by policy',
                body: 'State-changing and destructive classes are never offered in this case. Passive is refused because the case needs a crafted probe.',
              },
            ]}
          />
        </div>
      </div>
    </div>
  );
}
