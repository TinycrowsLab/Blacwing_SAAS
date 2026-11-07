// The stage spine (experience spec §5.2 item 2): one slim row, Approved → Mapping → Planning → Testing → Proving →
// Your review, derived from the run's events in run-model.ts. Phones show "Testing · stage 4 of 6" instead. A stage
// ticks only when its own work ended: one still busy behind the current stage shows a slate ring, one a stopped run
// left open a dashed ring with "stopped at …".
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
  if (state === 'active')
    return (
      <span className="flex size-[18px] shrink-0 items-center justify-center rounded-full border-[1.5px] border-slate bg-surface">
        <span className="size-[6px] rounded-full bg-slate" />
      </span>
    );
  if (state === 'stopped')
    return (
      <span className="flex size-[18px] shrink-0 items-center justify-center rounded-full border-[1.5px] border-dashed border-muted-foreground bg-surface">
        <span className="h-[1.5px] w-[7px] rounded-full bg-muted-foreground" />
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
  // A run that ended with nothing to review has no gold stage: phones then name the last one it reached.
  const currentAt = stages.findIndex((s) => s.state === 'current');
  const index = currentAt >= 0 ? currentAt : stages.findLastIndex((s) => s.state !== 'upcoming' && s.state !== 'skipped');
  const current = stages[index];
  const reached = (s: Stage | undefined): boolean => s !== undefined && s.state !== 'upcoming' && s.state !== 'skipped';
  return (
    <nav aria-label="Audit progress" className="border-b border-border bg-sidebar px-4 py-2.5 md:px-6">
      <p className="m-0 text-[12.5px] text-muted-foreground md:hidden">
        <strong className="font-semibold text-foreground">{current?.label ?? ''}</strong>
        {current === undefined ? '' : ` · stage ${index + 1} of ${stages.length}`}
        {current?.detail ? ` · ${current.detail}` : ''}
      </p>
      <ol className="m-0 hidden list-none items-center overflow-x-auto p-0 [scrollbar-width:none] md:flex">
        {stages.map((s, i) => {
          const detail = i === 0 && approvedAt !== null ? `${s.detail}${s.detail === '' ? '' : ', '}${approvedAt}` : s.detail;
          const body = (
            <>
              <Mark state={s.state} />
              <span className={s.state === 'current' ? 'font-semibold text-foreground' : s.state === 'done' || s.state === 'active' ? 'text-foreground' : ''}>
                {s.label}
              </span>
              {/* Narrow desktops keep the row on one line: finished stages drop their counts there (the side panel and
                  the tabs carry them), the approval keeps its "by whom, when". */}
              {detail === '' ? null : (
                <small className={`text-[11.5px] font-normal text-muted-foreground ${s.state === 'done' && i > 0 ? 'hidden min-[1360px]:inline' : ''}`}>{detail}</small>
              )}
            </>
          );
          return (
            <li
              key={s.key}
              className={`flex items-center ${i > 0 ? 'flex-1' : 'shrink-0'}`}
              aria-current={s.state === 'current' ? 'step' : undefined}
            >
              {i > 0 ? (
                // One rule for every connector: ink only between two stages the run reached, else a grey line.
                <span
                  aria-hidden="true"
                  className={`mx-2 h-[1.5px] min-w-3 flex-1 ${reached(s) && reached(stages[i - 1]) ? 'bg-text' : 'bg-border-strong'}`}
                />
              ) : null}
              {s.key === 'review' && resultsHref !== null ? (
                <Link href={resultsHref} className="flex shrink-0 items-center gap-[7px] whitespace-nowrap text-[12.5px] text-muted-foreground no-underline hover:underline">
                  {body}
                </Link>
              ) : (
                <span className="flex shrink-0 items-center gap-[7px] whitespace-nowrap text-[12.5px] text-muted-foreground">{body}</span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
