/* eslint-disable @typescript-eslint/no-magic-numbers -- display truncation (ids, hashes, timestamps) */
// Findings: every finding the viewer may see, newest first, filtered by severity and status through the URL.
import Link from 'next/link';
import { z } from 'zod';

import {
  Card,
  Chip,
  DataTable,
  PageHeader,
  filterPillClass,
  SeverityChip,
  VerdictMark,
  queryText,
} from '../../../components/demo/design';
import { getSession } from '../../../lib/session';
import { demoApi } from '../_lib/demo-api';
import { findingSummarySchema } from '../_lib/schemas';

import type { ReactNode } from 'react';

export const dynamic = 'force-dynamic';

const listSchema = z.object({ items: z.array(findingSummarySchema) });
const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const;
const STATUSES = ['released', 'suspected', 'dismissed'] as const;

const cap = (v: string): string => v.charAt(0).toUpperCase() + v.slice(1);

function FilterGroup({
  label,
  param,
  values,
  active,
  other,
}: {
  readonly label: string;
  readonly param: 'severity' | 'status';
  readonly values: readonly string[];
  readonly active: string | undefined;
  readonly other: Record<string, string | undefined>;
}) {
  const href = (value: string | undefined): string => {
    const query = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...other, [param]: value }))
      if (v !== undefined) query.set(k, v);
    const text = query.toString();
    return text === '' ? '/demo/findings' : `/demo/findings?${text}`;
  };
  return (
    <div className="flex flex-wrap items-center gap-2" role="group" aria-label={label}>
      <span className="w-16 text-xs text-muted-foreground">{label}</span>
      {[undefined, ...values].map((v) => (
        <Link
          key={v ?? 'all'}
          href={href(v)}
          aria-current={active === v ? 'true' : undefined}
          className={filterPillClass(active === v)}
        >
          {v === undefined ? 'All' : cap(v)}
        </Link>
      ))}
    </div>
  );
}

export default async function DemoFindingsPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<ReactNode> {
  const session = await getSession();
  if (session === null) return null;
  const query = await searchParams;
  const severity = SEVERITIES.find((s) => s === queryText(query.severity));
  const status = STATUSES.find((s) => s === queryText(query.status));
  const { items } = listSchema.parse(await demoApi(session, '/findings'));
  const shown = items.filter(
    (f) =>
      (severity === undefined || f.severity === severity) &&
      (status === undefined || f.status === status),
  );
  return (
    <div className="flex flex-col gap-3">
      <PageHeader
        crumbs={[{ label: 'Findings' }]}
        title="Findings"
        chips={<Chip tone="muted">{shown.length} shown</Chip>}
      />
      <div className="flex flex-col gap-2">
        <FilterGroup
          label="Severity"
          param="severity"
          values={SEVERITIES}
          active={severity}
          other={{ status }}
        />
        <FilterGroup
          label="Status"
          param="status"
          values={STATUSES}
          active={status}
          other={{ severity }}
        />
      </div>
      <Card>
        <DataTable
          label="Findings"
          head={['Severity', 'Finding', 'Status', 'Asset', 'Found by', 'Age']}
        >
          {shown.map((f) => (
            <tr key={f.id} className="hover:bg-primary-soft/40">
              <td className="px-4 py-3">
                <SeverityChip severity={f.severity} />
              </td>
              <td className="px-4 py-3 font-medium">
                <Link
                  className="hover:text-primary hover:underline"
                  href={`/demo/findings/${f.id}`}
                >
                  {f.title}
                </Link>
              </td>
              <td className="px-4 py-3">
                <span className="flex flex-wrap items-center gap-1.5">
                  <VerdictMark verdict={f.status} />
                  {f.status === 'suspected' ? (
                    <Chip tone="muted" icon="lock">
                      Analyst only
                    </Chip>
                  ) : null}
                </span>
              </td>
              <td className="px-4 py-3">{f.assetName ?? ''}</td>
              <td className="whitespace-nowrap px-4 py-3 font-mono text-xs font-medium">
                {f.agent ?? ''}
              </td>
              <td className="whitespace-nowrap px-4 py-3 font-mono text-[11.5px] text-muted-foreground">
                {f.createdAt === undefined ? '' : f.createdAt.slice(0, 16).replace('T', ' ')}
              </td>
            </tr>
          ))}
        </DataTable>
        {shown.length === 0 ? (
          <p className="p-4 text-[13px] text-muted-foreground">No findings match these filters.</p>
        ) : null}
      </Card>
    </div>
  );
}
