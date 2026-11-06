/* eslint-disable @typescript-eslint/no-magic-numbers -- design pixel values, see design/README.md */
'use client';

// Claude's team (experience spec §5.2 item 3): Your approval → Planner → one node per subagent in the run.started
// manifest → Validator → Your review → Report. Node states come from teamNodes() in run-model.ts; clicking a node
// filters the conversation to that agent. A node spins only while its agent spoke in the last 10 s, never under reduced
// motion. Plain name first, the mono agent id second (spec §1, prototype 04); the gate names sit in tooltips. Every
// node has the same fixed height and the connectors a fixed width, so the map never changes size mid-run. Desktop draws
// a row (collapsible); the phone's Team sheet draws the same nodes as a column.
// The map row has 4px padding because its horizontal scroll box clips the selected and focus rings otherwise.
import { Icon } from './design';

import type { Team, TeamNode } from './run-model';

function Ring({ className = '' }: { readonly className?: string }) {
  return <span aria-hidden="true" className={`size-[9px] shrink-0 rounded-full border-2 border-current ${className}`} />;
}

const STATE_WORD: Readonly<Record<TeamNode['state'], string>> = {
  working: 'working',
  waiting: 'waiting on you',
  done: 'done',
  idle: 'idle',
  stopped: 'stopped',
};

function NodeButton({
  node,
  mono,
  selected,
  onSelect,
  wide = false,
  stacked = false,
}: {
  readonly node: TeamNode;
  /** The technical id, shown in the tooltip (or "replay, no model" for the validator). */
  readonly mono: string;
  readonly selected: boolean;
  readonly onSelect: (id: string) => void;
  /** Column layout (phones): full width with a taller touch target. */
  readonly wide?: boolean;
  /** A narrow row node (planner, validator): the action gets two lines. */
  readonly stacked?: boolean;
}) {
  const tone = {
    working: 'border-slate bg-surface',
    waiting: 'border-[1.5px] border-gold-ink bg-[repeating-linear-gradient(135deg,var(--gold-soft)_0_6px,var(--surface)_6px_12px)]',
    done: 'border-border bg-surface',
    idle: 'border-border bg-surface',
    stopped: 'border-dashed border-border-strong bg-surface-2',
  }[node.state];
  const word = STATE_WORD[node.state];
  const said = node.sub.startsWith(word) ? `${node.name}: ${node.sub}` : `${node.name}, ${word}: ${node.sub}`;
  return (
    <button
      type="button"
      aria-pressed={selected}
      title={`${node.name} (${mono}): ${node.sub}. Click to show only its part of the conversation.`}
      aria-label={`${said}. Show only its part of the conversation.`}
      onClick={() => {
        onSelect(node.id);
      }}
      className={`flex w-full min-w-0 flex-col rounded-[10px] border px-2 py-1 text-left text-[12px] leading-4 transition-shadow hover:shadow-[0_0_0_3px_var(--focus)] focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-focus ${wide ? 'min-h-11 justify-center' : ''} ${tone} ${selected ? 'shadow-[0_0_0_2px_var(--gold-ink)]' : ''}`}
    >
      {/* Line 1: the plain name (it gives way, never the state mark). */}
      <span className="flex min-w-0 items-center gap-1.5 font-semibold text-foreground">
        <span className="min-w-0 truncate">{node.name}</span>
        {node.state === 'done' ? <span aria-hidden="true" className="ml-auto size-[7px] shrink-0 rounded-full bg-ok" /> : null}
        {node.state === 'stopped' ? <span aria-hidden="true" className="ml-auto h-[2px] w-2 shrink-0 rounded-full bg-muted-foreground" /> : null}
        {node.state === 'working' ? (
          <Ring className={`ml-auto text-slate ${node.spinning ? 'border-t-transparent motion-safe:animate-[bwspin_0.9s_linear_infinite]' : ''}`} />
        ) : null}
      </span>
      {/* Fixed lines (the tooltip has everything), so the map never changes size mid-run: the name, then the mono id on
          its own line (never cut at the widths the row allows), then the latest action, which gives way first. The
          narrow planner and validator give the action two lines. */}
      <span className="truncate font-mono text-[10.5px] leading-[14px] text-muted-foreground">{mono}</span>
      <span
        className={`text-[11px] leading-[14px] ${stacked ? 'line-clamp-2 h-7 break-words' : 'truncate'} ${node.state === 'waiting' ? 'font-medium text-gold-ink' : 'text-muted-foreground'}`}
      >
        {node.sub}
      </span>
    </button>
  );
}

function Diamond({ label, term, who, done }: { readonly label: string; readonly term: string; readonly who: string; readonly done: boolean }) {
  return (
    <div title={term} className="flex shrink-0 flex-col items-center gap-0.5 whitespace-nowrap text-[10.5px] text-muted-foreground">
      <span>
        {label}
        <span className="sr-only"> ({term})</span>
      </span>
      <i
        aria-hidden="true"
        className={`my-[3px] size-4 rotate-45 rounded-[2px] border-[1.5px] ${done ? 'border-ok bg-ok-soft' : 'border-border-strong bg-surface'}`}
      />
      <b className="text-[10.5px] font-semibold text-foreground">{who}</b>
    </div>
  );
}

/** A connector. `wide` ones keep room for a count ("3 proven") from the start, so a label appearing moves nothing. */
function Arrow({ label, wide = false }: { readonly label?: string | undefined; readonly wide?: boolean }) {
  return (
    <span className={`flex shrink-0 flex-col items-center gap-0.5 px-1 ${wide ? 'w-12' : 'w-4'}`}>
      <small className="whitespace-nowrap text-[10.5px] text-muted-foreground">{label ?? '\u00a0'}</small>
      <span aria-hidden="true" className="relative h-[1.5px] w-full bg-border-strong">
        <span className="absolute -right-px -top-[3px] border-y-[3.5px] border-l-[5px] border-y-transparent border-l-border-strong" />
      </span>
      <small aria-hidden="true" className="invisible text-[10.5px]">.</small>
    </span>
  );
}

/** The fan between one node and the stack: one curve per specialist, drawn to the stack's rows. */
function Fan({ rows, reverse = false }: { readonly rows: number; readonly reverse?: boolean }) {
  const ys = Array.from({ length: rows }, (_, i) => ((i + 0.5) / Math.max(rows, 1)) * 100);
  const d = ys.map((y) => (reverse ? `M0 ${y} C13 ${y} 13 50 26 50` : `M0 50 C13 50 13 ${y} 26 ${y}`)).join(' ');
  return (
    <svg aria-hidden="true" viewBox="0 0 26 100" preserveAspectRatio="none" className="h-full w-5 shrink-0 self-stretch">
      <path d={d} fill="none" strokeWidth="1.5" vectorEffect="non-scaling-stroke" style={{ stroke: 'var(--border2)' }} />
    </svg>
  );
}

/** Column layout's connector, with optional words. */
function Down({ label }: { readonly label?: string | undefined }) {
  return (
    <span className="flex items-center gap-2 py-0.5 pl-5 text-[11px] text-muted-foreground">
      <span aria-hidden="true" className="h-4 w-[1.5px] bg-border-strong" />
      {label}
    </span>
  );
}

const plural = (n: number, one: string, many: string): string => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

export function TeamMap({
  team,
  gate1,
  gate3,
  ended,
  filter,
  onFilter,
  layout = 'row',
  collapsed = false,
  onToggle,
}: {
  readonly team: Team;
  /** Who approved and when, e.g. "You, 2:02 pm". */
  readonly gate1: string;
  /** "Automatic" when proven issues release themselves, else whose turn it is. */
  readonly gate3: string;
  /** The run is over: counts are final, not "so far". */
  readonly ended: boolean;
  readonly filter: string | null;
  readonly onFilter: (agent: string | null) => void;
  readonly layout?: 'row' | 'column';
  /** Row layout only: the map folds to its title bar to give the conversation room. */
  readonly collapsed?: boolean;
  readonly onToggle?: () => void;
}) {
  const select = (id: string): void => {
    onFilter(filter === id ? null : id);
  };
  const column = layout === 'column';
  const anyStopped = [team.planner, ...team.specialists, team.validator].some((n) => n?.state === 'stopped');
  const legend = (
    <span className={`flex flex-wrap gap-3 text-[11px] font-normal text-muted-foreground ${column ? 'basis-full' : 'ml-auto'}`}>
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
      {anyStopped ? (
        <span className="flex items-center gap-1.5">
          <i aria-hidden="true" className="h-[2px] w-2 rounded-full bg-muted-foreground" />
          Stopped
        </span>
      ) : null}
    </span>
  );
  const report = `${team.proven.toLocaleString('en-US')} proven${ended ? '' : ' so far'}`;
  const proven = team.proven === 0 ? undefined : `${team.proven.toLocaleString('en-US')} proven`;
  const empty = team.planner === null && team.specialists.length === 0;

  const body = empty ? (
    <p className="m-0 py-3 text-[12.5px] text-muted-foreground">The team appears when the run starts.</p>
  ) : column ? (
    <div className="flex flex-col">
      <p className="m-0 text-[12px] text-muted-foreground">
        Your approval: <b className="font-semibold text-foreground">{gate1}</b>
      </p>
      <Down />
      {team.planner === null ? null : <NodeButton node={team.planner} mono="orchestrator" wide selected={filter === team.planner.id} onSelect={select} />}
      <Down label={team.tasks === 0 ? undefined : plural(team.tasks, 'task given', 'tasks given')} />
      <div className="flex flex-col gap-1.5">
        {team.specialists.map((n) => (
          <NodeButton key={n.id} node={n} mono={n.id} wide selected={filter === n.id} onSelect={select} />
        ))}
      </div>
      <Down label={team.candidates === 0 ? undefined : plural(team.candidates, 'candidate', 'candidates')} />
      {team.validator === null ? null : (
        <NodeButton node={team.validator} mono="replay, no model" wide selected={filter === 'validator'} onSelect={select} />
      )}
      <Down label={proven} />
      <p className="m-0 text-[12px] text-muted-foreground">
        Your review: <b className="font-semibold text-foreground">{gate3}</b> · Report: {report}
      </p>
    </div>
  ) : (
    <div className="flex items-center overflow-x-auto p-[4px] [scrollbar-color:var(--border2)_transparent] [scrollbar-width:thin]">
      <Diamond label="Your approval" term="Gate 1: scope approval" who={gate1} done />
      <Arrow />
      {team.planner === null ? null : (
        <div className="w-[100px] shrink-0">
          <NodeButton node={team.planner} mono="orchestrator" stacked selected={filter === team.planner.id} onSelect={select} />
        </div>
      )}
      {team.specialists.length === 0 ? (
        <Arrow wide label={team.tasks === 0 ? undefined : plural(team.tasks, 'task', 'tasks')} />
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
        <div className="w-[128px] shrink-0">
          <NodeButton node={team.validator} mono="replay, no model" stacked selected={filter === 'validator'} onSelect={select} />
        </div>
      )}
      <Arrow wide label={proven} />
      <Diamond label="Your review" term="Gate 3: triage and release" who={gate3} done={team.autoReleased && team.proven > 0} />
      <Arrow />
      <div className="shrink-0 rounded-[10px] border border-border bg-surface px-2.5 py-1.5 text-[12px] leading-4">
        <b className="font-semibold">Report</b>
        <div className="text-[11px] text-muted-foreground">{report}</div>
      </div>
    </div>
  );

  return (
    <section aria-label="Claude's team" className={column ? '' : 'rounded-[14px] border border-border bg-surface px-3.5 pb-3 pt-2.5'}>
      <div className={`flex flex-wrap items-center gap-2.5 text-[12.5px] font-semibold ${collapsed && !column ? '' : 'mb-2'}`}>
        <Icon name="team" size={15} />
        Claude&apos;s team
        {filter === null ? null : (
          <button
            type="button"
            onClick={() => {
              onFilter(null);
            }}
            className="inline-flex h-6 items-center gap-1 whitespace-nowrap rounded-full bg-gold-soft px-2.5 text-[11.5px] font-medium text-gold-ink hover:underline max-md:min-h-11"
          >
            Showing one agent · Show everyone
            <Icon name="x" size={11} />
          </button>
        )}
        {/* One header line whatever happens: in the row, the filter chip takes the legend's place. */}
        {(collapsed || filter !== null) && !column ? null : legend}
        {onToggle === undefined || column ? null : (
          <button
            type="button"
            aria-expanded={!collapsed}
            onClick={onToggle}
            className={`inline-flex h-6 items-center gap-1 whitespace-nowrap rounded-md px-2 text-[11.5px] font-medium text-muted-foreground hover:bg-surface-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-focus ${collapsed || filter !== null ? 'ml-auto' : ''}`}
          >
            {collapsed ? 'Show map' : 'Hide map'}
            <Icon name="chevron" size={12} className={collapsed ? '' : 'rotate-180'} />
          </button>
        )}
      </div>
      {collapsed && !column ? null : body}
    </section>
  );
}
