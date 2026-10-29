// DEMO-STORY: create an assessment request (scope, intrusiveness class, budget). Submitting goes to Gate 1.
import { z } from 'zod';

import { getSession } from '../../../../lib/session';
import { demoApi } from '../../_lib/demo-api';
import { assetSchema } from '../../_lib/schemas';
import { createRequestAction } from '../../actions';

import type { ReactNode } from 'react';

export const dynamic = 'force-dynamic';

const listSchema = z.object({ items: z.array(assetSchema) });

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
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">New assessment request</h1>
      <p className="text-sm text-neutral-600 dark:text-neutral-400">
        The case is the pinned Juice Shop SQL injection check (issue #881): a benign probe on the product search. It
        needs the active_safe class. Destructive and state-changing classes are never allowed.
      </p>
      {error === undefined ? null : (
        <p role="alert" className="rounded border border-red-400 bg-red-50 p-3 text-sm text-red-900 dark:bg-red-950 dark:text-red-100">
          <strong>{error}</strong>: {message ?? 'The request was refused.'}
        </p>
      )}
      <form action={createRequestAction} className="grid max-w-xl gap-4">
        <label className="grid gap-1 text-sm">
          Asset
          <select name="assetId" defaultValue={preselected} required className="rounded border border-neutral-400 p-2 dark:bg-neutral-900">
            {items.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} ({a.ownership.status})
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-sm">
          Test case
          <select name="testCaseId" defaultValue="wstg-inpv-05-sqli-products-search" className="rounded border border-neutral-400 p-2 dark:bg-neutral-900">
            <option value="wstg-inpv-05-sqli-products-search">SQL injection in product search (WSTG-INPV-05, CWE-89)</option>
          </select>
        </label>
        <label className="grid gap-1 text-sm">
          Intrusiveness class
          <select name="intrusiveness" defaultValue="active_safe" className="rounded border border-neutral-400 p-2 dark:bg-neutral-900">
            <option value="active_safe">active_safe (benign probe, no extraction)</option>
            <option value="passive">passive (refused for this case)</option>
          </select>
          <span className="text-xs text-neutral-600 dark:text-neutral-400">
            state_changing and destructive are never offered: they are refused by policy.
          </span>
        </label>
        <label className="grid gap-1 text-sm">
          Scope host
          <input name="scopeHost" defaultValue="127.0.0.1" required className="rounded border border-neutral-400 p-2 dark:bg-neutral-900" />
        </label>
        <label className="grid gap-1 text-sm">
          Scope path prefix
          <input name="scopePath" defaultValue="/rest/products/search" required className="rounded border border-neutral-400 p-2 dark:bg-neutral-900" />
        </label>
        <fieldset className="grid grid-cols-2 gap-3 text-sm">
          <legend className="mb-1">Budget</legend>
          <label className="grid gap-1">
            Requests (max 20)
            <input name="budgetRequests" type="number" min={1} max={20} defaultValue={8} required className="rounded border border-neutral-400 p-2 dark:bg-neutral-900" />
          </label>
          <label className="grid gap-1">
            Seconds (60 to 900)
            <input name="budgetSeconds" type="number" min={60} max={900} defaultValue={300} required className="rounded border border-neutral-400 p-2 dark:bg-neutral-900" />
          </label>
        </fieldset>
        <button type="submit" className="justify-self-start rounded bg-neutral-900 px-4 py-2 text-sm text-white dark:bg-neutral-100 dark:text-neutral-900">
          Submit to Gate 1
        </button>
      </form>
    </div>
  );
}
