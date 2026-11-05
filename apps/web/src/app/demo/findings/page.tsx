/* eslint-disable @typescript-eslint/no-magic-numbers -- display truncation (ids, hashes, timestamps) */
// Findings: every finding the viewer may see, newest first, filtered by severity and status through the URL.
import Link from 'next/link';
import { z } from 'zod';

import {
  Card,
  Chip,
  DataTable,
  PageHeader,
  SeverityChip,
  StatusChip,
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
          className={`inline-flex h-8 items-center rounded-full px-3 text-xs font-medium ${active === v ? 'bg-text text-bg' : 'bg-surface-2 text-foreground hover:brightness-95'}`}
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
    <div className="flex flex-col gap-5">
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
          head={['Severity', 'Finding', 'Status', 'CWE', 'Asset', 'Agent', 'Found']}
        >
          {shown.map((f) => (
            <tr key={f.id} className="hover:bg-primary-soft/40">
              <td className="px-4 py-3">
                <SeverityChip severity={f.severity} />
              </td>
              <td className="px-4 py-3 font-medium">
                <Link className="text-primary hover:underline" href={`/demo/findings/${f.id}`}>
                  {f.title}
                </Link>
              </td>
              <td className="px-4 py-3">
                <span className="flex flex-wrap items-center gap-1.5">
                  <StatusChip value={f.status} />
                  {f.status === 'suspected' ? (
                    <Chip tone="muted" icon="lock">
                      Analyst only
                    </Chip>
                  ) : null}
                </span>
              </td>
              <td className="px-4 py-3 font-mono text-xs">{f.cwe ?? ''}</td>
              <td className="px-4 py-3">{f.assetName ?? ''}</td>
              <td className="px-4 py-3 font-mono text-xs">{f.agent ?? ''}</td>
              <td className="whitespace-nowrap px-4 py-3 text-xs text-muted-foreground">
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
