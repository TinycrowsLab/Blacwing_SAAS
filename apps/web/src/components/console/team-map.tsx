/* eslint-disable @typescript-eslint/no-magic-numbers -- design pixel values, see design/README.md */
'use client';

// Claude's team (experience spec §5.2 item 3): Gate 1 → Planner → one node per subagent in the run.started manifest →
// Validator → Gate 3 → Report. Node states come from teamNodes() in run-model.ts; clicking a node filters the
// conversation to that agent. A node spins only while its agent spoke in the last 10 s, never under reduced motion.
// The map row has 4px padding because its horizontal scroll box clips the selected and focus rings otherwise.
import { Icon } from './design';

import type { Team, TeamNode } from './run-model';

function Ring({ className = '' }: { readonly className?: string }) {
  return <span aria-hidden="true" className={`size-[9px] shrink-0 rounded-full border-2 border-current ${className}`} />;
}

function NodeButton({
  node,
  mono,
  selected,
  onSelect,
  stacked = false,
}: {
  readonly node: TeamNode;
  /** Planner and validator: the id and the action on two lines. */
  readonly stacked?: boolean;
  /** Second line: the mono agent id (or "replay, no model" for the validator). */
  readonly mono: string;
  readonly selected: boolean;
  readonly onSelect: (id: string) => void;
}) {
  const tone = {
    working: 'border-slate bg-surface',
    waiting: 'border-[1.5px] border-gold-ink bg-[repeating-linear-gradient(135deg,var(--gold-soft)_0_6px,var(--surface)_6px_12px)]',
    done: 'border-border bg-surface',
    idle: 'border-border bg-surface',
  }[node.state];
  const stateWord = { working: 'working', waiting: 'waiting on you', done: 'done', idle: 'idle' }[node.state];
  return (
    <button
      type="button"
      aria-pressed={selected}
      title={`Show only the ${node.name} in the conversation`}
      aria-label={`${node.name}, ${stateWord}: ${node.sub}. Show only its part of the conversation.`}
      onClick={() => {
        onSelect(node.id);
      }}
      className={`flex min-w-0 flex-col rounded-[10px] border px-2.5 py-1.5 text-left text-[12px] leading-4 transition-shadow hover:shadow-[0_0_0_3px_var(--focus)] focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-focus ${tone} ${selected ? 'shadow-[0_0_0_2px_var(--gold-ink)]' : ''}`}
    >
      <span className="flex items-center gap-1.5 font-semibold text-foreground">
        <span className="truncate">{node.name}</span>
        {node.state === 'done' ? <span aria-hidden="true" className="ml-auto size-[7px] shrink-0 rounded-full bg-ok" /> : null}
        {node.state === 'working' ? (
          <Ring
            className={`ml-auto text-slate ${node.spinning ? 'border-t-transparent motion-safe:animate-[bwspin_0.9s_linear_infinite]' : ''}`}
          />
        ) : null}
      </span>
      {stacked ? (
        <>
          <span className="truncate font-mono text-[10.5px] text-muted-foreground">{mono}</span>
          <span className={`truncate text-[11px] ${node.state === 'waiting' ? 'font-medium text-gold-ink' : 'text-muted-foreground'}`}>{node.sub}</span>
        </>
      ) : (
        <span className="truncate text-[11px] text-muted-foreground" title={`${mono} · ${node.sub}`}>
          <span className="font-mono text-[10.5px]">{mono}</span>
          {' · '}
          <span className={node.state === 'waiting' ? 'font-medium text-gold-ink' : ''}>{node.sub}</span>
        </span>
      )}
    </button>
  );
}

function Diamond({ label, who, done }: { readonly label: string; readonly who: string; readonly done: boolean }) {
  return (
    <div className="flex flex-col items-center gap-0.5 whitespace-nowrap text-[10.5px] text-muted-foreground">
      <span>{label}</span>
      <i
        aria-hidden="true"
        className={`my-[3px] size-4 rotate-45 rounded-[2px] border-[1.5px] ${done ? 'border-ok bg-ok-soft' : 'border-border-strong bg-surface'}`}
      />
      <b className="text-[10.5px] font-semibold text-foreground">{who}</b>
    </div>
  );
}

function Arrow({ count }: { readonly count?: number | undefined }) {
  return (
    <span aria-hidden="true" className="relative mx-1 h-[1.5px] w-5 min-w-3 shrink bg-border-strong">
      <span className="absolute -right-px -top-[3px] border-y-[3.5px] border-l-[5px] border-y-transparent border-l-border-strong" />
      {count === undefined || count === 0 ? null : (
        <small className="absolute -top-[15px] left-1/2 -translate-x-1/2 text-[10px] text-muted-foreground">{count}</small>
      )}
    </span>
  );
}

/** The fan between one node and the stack: one curve per specialist, drawn to the stack's rows. */
function Fan({ rows, reverse = false }: { readonly rows: number; readonly reverse?: boolean }) {
  const ys = Array.from({ length: rows }, (_, i) => ((i + 0.5) / Math.max(rows, 1)) * 100);
  const d = ys.map((y) => (reverse ? `M0 ${y} C13 ${y} 13 50 26 50` : `M0 50 C13 50 13 ${y} 26 ${y}`)).join(' ');
  return (
    <svg aria-hidden="true" viewBox="0 0 26 100" preserveAspectRatio="none" className="h-full w-[26px] shrink-0 self-stretch">
      <path d={d} fill="none" strokeWidth="1.5" vectorEffect="non-scaling-stroke" style={{ stroke: 'var(--border2)' }} />
    </svg>
  );
}

export function TeamMap({
  team,
  gate1,
  gate3,
  filter,
  onFilter,
}: {
  readonly team: Team;
  /** Who approved and when, e.g. "You, 14:02". */
  readonly gate1: string;
  /** "Automatic" when proven issues release themselves, else "You, later". */
  readonly gate3: string;
  readonly filter: string | null;
  readonly onFilter: (agent: string | null) => void;
}) {
  const select = (id: string): void => {
    onFilter(filter === id ? null : id);
  };
  const legend = (
    <span className="ml-auto flex flex-wrap gap-3 text-[11px] font-normal text-muted-foreground">
      <span className="flex items-center gap-1.5">
        <Ring className="text-slate" />
        Working
      </span>
      <span className="flex items-center gap-1.5">
        <i aria-hidden="true" className="size-[9px] rounded-[2px] border-[1.5px] border-gold-ink bg-gold-soft" />
        Waiting on you
      </span>
      <span className="flex items-center gap-1.5">
        <i aria-hidden="true" className="size-[7px] rounded-full bg-ok" />
        Done
      </span>
    </span>
  );
  return (
    <section aria-label="Claude's team" className="rounded-[14px] border border-border bg-surface px-3.5 pb-3 pt-2.5">
      <div className="mb-2 flex flex-wrap items-center gap-2.5 text-[12.5px] font-semibold">
        <Icon name="team" size={15} />
        Claude&apos;s team
        {filter === null ? null : (
          <button
            type="button"
            onClick={() => {
              onFilter(null);
            }}
            className="inline-flex h-6 items-center gap-1 rounded-full bg-gold-soft px-2.5 text-[11.5px] font-medium text-gold-ink hover:underline"
          >
            Showing one agent · Show everyone
            <Icon name="x" size={11} />
          </button>
        )}
        {legend}
      </div>
      {team.planner === null && team.specialists.length === 0 ? (
        <p className="m-0 py-3 text-[12.5px] text-muted-foreground">The team appears when the run starts.</p>
      ) : (
        <div className="flex items-center overflow-x-auto p-[4px]">
          <Diamond label="Gate 1" who={gate1} done />
          <Arrow />
          {team.planner === null ? null : (
            <div className="w-[112px] shrink-0">
              <NodeButton node={team.planner} mono="orchestrator" stacked selected={filter === team.planner.id} onSelect={select} />
            </div>
          )}
          {team.specialists.length === 0 ? (
            <Arrow count={team.tasks} />
          ) : (
            <>
              <Fan rows={team.specialists.length} />
              <div className="flex min-w-[170px] max-w-[300px] flex-1 flex-col gap-[5px]">
                {team.specialists.map((n) => (
                  <NodeButton key={n.id} node={n} mono={n.id} selected={filter === n.id} onSelect={select} />
                ))}
              </div>
              <Fan rows={team.specialists.length} reverse />
            </>
          )}
          {team.validator === null ? null : (
            <div className="w-[112px] shrink-0">
              <NodeButton node={team.validator} mono="replay, no model" stacked selected={filter === 'validator'} onSelect={select} />
            </div>
          )}
          <Arrow count={team.proven} />
          <Diamond label="Gate 3" who={gate3} done={false} />
          <Arrow />
          <div className="shrink-0 rounded-[10px] border border-border bg-surface px-2.5 py-1.5 text-[12px] leading-4">
            <b className="font-semibold">Report</b>
            <div className="text-[11px] text-muted-foreground">{team.proven} proven so far</div>
          </div>
        </div>
      )}
    </section>
  );
}
