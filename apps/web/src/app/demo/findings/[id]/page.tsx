// DEMO-STORY finding detail: the confirmed finding, its evidence (request and response), the oracle, the replay
// results, a copyable repro and the report download.
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { z } from 'zod';

import { StatusPill } from '../../../../components/demo/status-pill';
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
  return (
    <article className="space-y-6">
      <header className="space-y-2">
        <p className="text-sm">
          <Link className="underline" href={`/demo/runs/${finding.runId}`}>
            Back to the run
          </Link>
        </p>
        <h1 className="text-2xl font-semibold">{finding.title}</h1>
        <p className="flex flex-wrap items-center gap-2 text-sm">
          <StatusPill value={finding.status} />
          <span>{finding.cwe}</span>
          <span>{finding.owasp}</span>
          <span>
            CVSS v4.0 {finding.severity.cvssV4Score} (demo-assigned, not calculated)
          </span>
        </p>
        <p className="flex flex-wrap gap-3 text-sm">
          <a className="rounded border border-neutral-400 px-3 py-1 hover:bg-neutral-100 dark:hover:bg-neutral-800" href={`${base}?format=html`}>
            Download report (HTML)
          </a>
          <a className="rounded border border-neutral-400 px-3 py-1 hover:bg-neutral-100 dark:hover:bg-neutral-800" href={`${base}?format=md`}>
            Download report (Markdown)
          </a>
        </p>
      </header>

      {evidence.recorded === true ? (
        <p className="rounded border border-amber-400 bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100">
          Recorded fallback: this finding comes from an earlier run of the same lab image, seeded so the story always has a
          complete finding to show.
        </p>
      ) : null}

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Confirmed by deterministic replay</h2>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          Oracle <code>{text(finding.oracle.id)}</code> (error signature <code>{text((finding.oracle.params as { signature?: unknown } | undefined)?.signature)}</code>) matched on every replay, and did not match on the negative control.
        </p>
        <table className="w-full max-w-2xl border-collapse text-sm">
          <thead>
            <tr className="text-left">
              <th className="border-b border-neutral-300 py-1 pr-4">Replay</th>
              <th className="border-b border-neutral-300 py-1 pr-4">HTTP status</th>
              <th className="border-b border-neutral-300 py-1">Oracle matched</th>
            </tr>
          </thead>
          <tbody>
            {replay.replays.map((r) => (
              <tr key={r.n}>
                <td className="py-1 pr-4">{r.n}</td>
                <td className="py-1 pr-4">{r.status}</td>
                <td className="py-1">{r.matched ? 'yes' : 'no'}</td>
              </tr>
            ))}
            <tr>
              <td className="py-1 pr-4">Negative control</td>
              <td className="py-1 pr-4">{replay.negativeControl.status}</td>
              <td className="py-1">{replay.negativeControl.matched ? 'yes (unexpected)' : 'no (expected)'}</td>
            </tr>
          </tbody>
        </table>
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Evidence</h2>
        <p className="text-sm">
          Probe <code className="break-all">{evidence.probe.request?.url ?? 'n/a'}</code>, HTTP {evidence.probe.response?.status ?? 'n/a'}
        </p>
        <pre className="max-h-64 overflow-auto rounded bg-neutral-100 p-3 text-xs dark:bg-neutral-900">
          {evidence.probe.response?.bodyExcerpt ?? '(no body excerpt)'}
        </pre>
        <p className="text-sm">
          Negative control <code className="break-all">{evidence.negativeControl.request?.url ?? 'n/a'}</code>, HTTP{' '}
          {evidence.negativeControl.response?.status ?? 'n/a'}
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Repro</h2>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          The detection probe is benign: one quote breaks the SQL syntax. Run it on the lab target to see the same error
          signature. No data is extracted.
        </p>
        <pre className="overflow-auto rounded bg-neutral-100 p-3 text-xs dark:bg-neutral-900">
          <code>{finding.reproCurl}</code>
        </pre>
      </section>

      <section className="space-y-1 text-sm">
        <h2 className="text-lg font-semibold">Location</h2>
        <p>
          <code>
            {text(finding.location.method)} {text(finding.location.urlTemplate)}
          </code>{' '}
          parameter <code>{text(finding.location.parameter)}</code>
        </p>
      </section>
    </article>
  );
}
