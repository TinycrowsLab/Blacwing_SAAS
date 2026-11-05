// The stage spine (experience spec §5.2 item 2): one slim row, Approved → Mapping → Planning → Testing → Proving →
// Your review, derived from the run's events in run-model.ts. Phones show "Testing · stage 4 of 6" instead.
import Link from 'next/link';

import { Icon } from './design';

import type { Stage } from './run-model';

function Mark({ state }: { readonly state: Stage['state'] }) {
  if (state === 'done')
    return (
      <span className="flex size-[18px] shrink-0 items-center justify-center rounded-full bg-text text-bg">
        <Icon name="check" size={10} />
      </span>
    );
  if (state === 'current')
    return (
      <span className="flex size-[18px] shrink-0 items-center justify-center rounded-full border-[1.5px] border-gold-ink bg-gold-soft">
        <span className="size-[7px] rounded-full bg-gold" />
      </span>
    );
  return (
    <span
      className={`size-[18px] shrink-0 rounded-full border-[1.5px] bg-surface ${state === 'skipped' ? 'border-dashed border-border-strong' : 'border-border-strong'}`}
    />
  );
}

export function StageSpine({
  stages,
  approvedAt,
  resultsHref,
}: {
  readonly stages: readonly Stage[];
  /** Shown after "by {approver}" on the first stage, already formatted for the viewer's locale. */
  readonly approvedAt: string | null;
  /** The last stage links to the results once the run is over. */
  readonly resultsHref: string | null;
}) {
  const index = stages.findIndex((s) => s.state === 'current');
  const current = stages[index];
  return (
    <nav aria-label="Audit progress" className="border-b border-border bg-sidebar px-4 py-2.5 md:px-6">
      <p className="m-0 text-[12.5px] text-muted-foreground md:hidden">
        <strong className="font-semibold text-foreground">{current?.label ?? ''}</strong>
        {current === undefined ? '' : ` · stage ${index + 1} of ${stages.length}`}
        {current?.detail ? ` · ${current.detail}` : ''}
      </p>
      <ol className="m-0 hidden list-none items-center p-0 md:flex">
        {stages.map((s, i) => {
          const detail = i === 0 && approvedAt !== null ? `${s.detail}${s.detail === '' ? '' : ', '}${approvedAt}` : s.detail;
          const body = (
            <>
              <Mark state={s.state} />
              <span className={s.state === 'current' ? 'font-semibold text-foreground' : s.state === 'done' ? 'text-foreground' : ''}>
                {s.label}
              </span>
              {detail === '' ? null : <small className="text-[11.5px] font-normal text-muted-foreground">{detail}</small>}
            </>
          );
          return (
            <li key={s.key} className="flex min-w-0 items-center" aria-current={s.state === 'current' ? 'step' : undefined}>
              {i > 0 ? (
                <span
                  aria-hidden="true"
                  className={`mx-2.5 h-[1.5px] w-3 min-w-3 flex-1 lg:w-8 ${s.state === 'done' || s.state === 'current' ? 'bg-text' : 'bg-border-strong'}`}
                />
              ) : null}
              {s.key === 'review' && resultsHref !== null ? (
                <Link href={resultsHref} className="flex items-center gap-[7px] whitespace-nowrap text-[12.5px] text-muted-foreground no-underline hover:underline">
                  {body}
                </Link>
              ) : (
                <span className="flex items-center gap-[7px] whitespace-nowrap text-[12.5px] text-muted-foreground">{body}</span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
