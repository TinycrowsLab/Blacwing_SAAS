/* eslint-disable @typescript-eslint/no-magic-numbers -- design pixel values, see design/README.md */
'use client';

// Blackwing's team (experience spec §5.2 item 3): Your approval → Planner → one node per subagent in the run.started
// manifest → Validator → Your review → Report. Node states come from teamNodes() in run-model.ts; clicking a node
// filters the conversation to that agent. A node spins only while its agent spoke in the last 10 s, never under reduced
// motion. Plain name first, the mono agent id second (spec §1, prototype 04); the gate names sit in tooltips. Every
// node has the same fixed height and the connectors a fixed width, so the map never changes size mid-run. Desktop draws
// a row (collapsible); the phone's Team sheet draws the same nodes as a column.
// The header's Full screen button opens a Modal with the phase view (PhaseMap): one card per phase with its agent count and
// live states; a card expands to list its agents, and picking one filters the conversation to it.
// The map row has 4px padding because its horizontal scroll box clips the selected and focus rings otherwise.
import { useState } from 'react';

import { Icon } from './design';
import { Modal } from './modal';

import type { Team, TeamNode } from './run-model';

function Ring({ className = '' }: { readonly className?: string }) {
  return <span aria-hidden="true" className={`size-[9px] shrink-0 rounded-full border-2 border-current ${className}`} />;
}

const TONE: Readonly<Record<TeamNode['state'], string>> = {
  working: 'border-slate bg-surface',
  waiting: 'border-[1.5px] border-gold-ink bg-[repeating-linear-gradient(135deg,var(--gold-soft)_0_6px,var(--surface)_6px_12px)]',
  done: 'border-border bg-surface',
  idle: 'border-border bg-surface',
  stopped: 'border-dashed border-border-strong bg-surface-2',
};

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
  /** The technical id, shown in the tooltip (or "replay engine" for the validator). */
  readonly mono: string;
  readonly selected: boolean;
  readonly onSelect: (id: string) => void;
  /** Column layout (phones): full width with a taller touch target. */
  readonly wide?: boolean;
  /** A narrow row node (planner, validator): the action gets two lines. */
  readonly stacked?: boolean;
}) {
  const tone = TONE[node.state];
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
      {/* Line 1: the plain name, with the whole width (the state mark sits on line 2, so it never pushes the name). */}
      <span className="min-w-0 truncate font-semibold text-foreground">{node.name}</span>
      {/* Line 2: the mono id and the state mark. The id is short enough never to be cut at the widths the row allows.
          Line 3: the latest action, which gives way first; the narrow planner and validator give it two lines. Fixed
          lines (the tooltip has everything), so the map never changes size mid-run. */}
      <span className="flex min-w-0 items-center gap-1">
        <span className="min-w-0 truncate font-mono text-[10.5px] leading-[14px] text-muted-foreground">{mono}</span>
        {node.state === 'done' ? <span aria-hidden="true" className="ml-auto size-[7px] shrink-0 rounded-full bg-ok" /> : null}
        {node.state === 'stopped' ? <span aria-hidden="true" className="ml-auto h-[2px] w-2 shrink-0 rounded-full bg-muted-foreground" /> : null}
        {node.state === 'working' ? (
          <Ring className={`ml-auto text-slate ${node.spinning ? 'border-t-transparent motion-safe:animate-[bwspin_0.9s_linear_infinite]' : ''}`} />
        ) : null}
      </span>
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
function Arrow({ label, wide = false, className = '' }: { readonly label?: string | undefined; readonly wide?: boolean; readonly className?: string }) {
  return (
    <span className={`flex shrink-0 flex-col items-center gap-0.5 px-1 ${wide ? 'w-12' : 'w-4'} ${className}`}>
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
    <svg aria-hidden="true" viewBox="0 0 26 100" preserveAspectRatio="none" className="h-full w-4 shrink-0 self-stretch">
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

type PhaseState = TeamNode['state'];

interface Phase {
  readonly key: string;
  readonly name: string;
  readonly blurb: string;
  readonly agents: readonly TeamNode[];
  /** The agents' technical label when the node has none of its own (planner, validator). */
  readonly mono: string | null;
  /** Phases without agents (the human gates, the report) show this instead of a count. */
  readonly note: string | null;
  readonly state: PhaseState;
}

const STATE_ORDER: readonly PhaseState[] = ['working', 'waiting', 'done', 'idle', 'stopped'];

/** The phase's headline state: someone waiting on you outranks work, work outranks the rest. */
function phaseState(agents: readonly TeamNode[]): PhaseState {
  if (agents.length === 0) return 'idle';
  if (agents.some((n) => n.state === 'waiting')) return 'waiting';
  if (agents.some((n) => n.state === 'working')) return 'working';
  if (agents.some((n) => n.state === 'stopped')) return 'stopped';
  if (agents.every((n) => n.state === 'done')) return 'done';
  return 'idle';
}

function StateMark({ state, spinning = false }: { readonly state: PhaseState; readonly spinning?: boolean }) {
  if (state === 'working') {
    return <Ring className={`text-slate ${spinning ? 'border-t-transparent motion-safe:animate-[bwspin_0.9s_linear_infinite]' : ''}`} />;
  }
  if (state === 'waiting') return <i aria-hidden="true" className="size-[9px] shrink-0 rounded-[2px] border-[1.5px] border-gold-ink bg-gold-soft" />;
  if (state === 'done') return <i aria-hidden="true" className="size-[9px] shrink-0 rounded-full bg-ok" />;
  if (state === 'stopped') return <i aria-hidden="true" className="h-[2px] w-2.5 shrink-0 rounded-full bg-muted-foreground" />;
  return <i aria-hidden="true" className="size-[9px] shrink-0 rounded-full border-[1.5px] border-border-strong" />;
}

function stateSummary(agents: readonly TeamNode[]): string {
  return STATE_ORDER.map((st) => ({ st, n: agents.filter((a) => a.state === st).length }))
    .filter((x) => x.n > 0)
    .map((x) => `${x.n.toLocaleString('en-US')} ${STATE_WORD[x.st]}`)
    .join(' · ');
}

function PhaseCard({
  phase,
  index,
  open,
  onToggle,
  filter,
  onPick,
}: {
  readonly phase: Phase;
  readonly index: number;
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly filter: string | null;
  readonly onPick: (id: string) => void;
}) {
  const count = phase.agents.length;
  const expandable = count > 0;
  const listId = `team-phase-${phase.key}`;
  const head = (
    <>
      <span
        aria-hidden="true"
        className="flex size-8 shrink-0 items-center justify-center rounded-full bg-surface-2 font-mono text-[12px] font-semibold text-muted-foreground"
      >
        {index + 1}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex flex-wrap items-center gap-x-2 text-[15px] font-semibold text-foreground">
          {phase.name}
          {expandable ? (
            <span className="rounded-full bg-gold-soft px-2 py-px text-[11.5px] font-medium text-gold-ink">{plural(count, 'agent', 'agents')}</span>
          ) : null}
        </span>
        <span className="text-[12.5px] text-muted-foreground">{expandable ? stateSummary(phase.agents) : (phase.note ?? phase.blurb)}</span>
      </span>
      <StateMark state={phase.state} spinning={phase.agents.some((a) => a.spinning)} />
      {expandable ? <Icon name="chevron" size={14} className={`shrink-0 text-muted-foreground ${open ? 'rotate-180' : ''}`} /> : null}
    </>
  );
  const frame = `flex w-full items-center gap-3 rounded-[14px] border px-4 py-3.5 text-left ${TONE[phase.state]}`;
  return (
    <div className="flex flex-col">
      {expandable ? (
        <button
          type="button"
          aria-expanded={open}
          aria-controls={listId}
          aria-label={`${phase.name}: ${plural(count, 'agent', 'agents')}, ${stateSummary(phase.agents)}. ${open ? 'Hide' : 'Show'} the agents.`}
          onClick={onToggle}
          className={`${frame} min-h-14 transition-shadow hover:shadow-[0_0_0_3px_var(--focus)] focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-focus`}
        >
          {head}
        </button>
      ) : (
        <div className={frame}>{head}</div>
      )}
      {expandable && open ? (
        <ul id={listId} className="m-0 mt-2 flex list-none flex-col gap-1.5 p-0 pl-4 sm:pl-11">
          {phase.agents.map((n) => (
            <li key={n.id}>
              <button
                type="button"
                aria-pressed={filter === n.id}
                aria-label={`${n.name}, ${STATE_WORD[n.state]}: ${n.sub}. Show only its part of the conversation.`}
                onClick={() => {
                  onPick(n.id);
                }}
                className={`flex min-h-11 w-full items-start gap-3 rounded-[10px] border px-3 py-2 text-left transition-shadow hover:shadow-[0_0_0_3px_var(--focus)] focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-focus ${TONE[n.state]} ${filter === n.id ? 'shadow-[0_0_0_2px_var(--gold-ink)]' : ''}`}
              >
                <span className="mt-[5px]">
                  <StateMark state={n.state} spinning={n.spinning} />
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="flex flex-wrap items-baseline gap-x-2">
                    <span className="text-[13.5px] font-semibold text-foreground">{n.name}</span>
                    <span className="font-mono text-[11px] text-muted-foreground">{phase.mono ?? n.id}</span>
                  </span>
                  <span className={`break-words text-[12.5px] ${n.state === 'waiting' ? 'font-medium text-gold-ink' : 'text-muted-foreground'}`}>{n.sub}</span>
                </span>
                <Icon name="arrow" size={13} className="mt-1 shrink-0 text-muted-foreground" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function PhaseMap({
  team,
  gate1,
  gate3,
  ended,
  filter,
  onPick,
  onClose,
}: {
  readonly team: Team;
  readonly gate1: string;
  readonly gate3: string;
  readonly ended: boolean;
  readonly filter: string | null;
  readonly onPick: (id: string) => void;
  readonly onClose: () => void;
}) {
  const [opened, setOpened] = useState<readonly string[]>(['specialists']);
  const toggle = (key: string): void => {
    setOpened((cur) => (cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key]));
  };
  const reviewDone = (team.autoReleased && team.proven > 0) || gate3 === 'Review complete';
  const phases: readonly Phase[] = [
    { key: 'approval', name: 'Approval', blurb: 'Scope approval', agents: [], mono: null, note: `Your approval: ${gate1}`, state: 'done' },
    { key: 'plan', name: 'Recon and plan', blurb: 'Plans the work', agents: team.planner === null ? [] : [team.planner], mono: 'orchestrator', note: null, state: 'idle' },
    { key: 'specialists', name: 'Specialists', blurb: 'Test the target', agents: team.specialists, mono: null, note: null, state: 'idle' },
    { key: 'validation', name: 'Validation', blurb: 'Proves each finding', agents: team.validator === null ? [] : [team.validator], mono: 'replay engine', note: null, state: 'idle' },
    {
      key: 'review',
      name: 'Your review',
      blurb: 'Triage and release',
      agents: [],
      mono: null,
      note: `${gate3}${team.proven === 0 ? '' : ` · ${plural(team.proven, 'proven issue', 'proven issues')}`}`,
      state: reviewDone ? 'done' : 'idle',
    },
    {
      key: 'report',
      name: 'Report',
      blurb: 'The final write-up',
      agents: [],
      mono: null,
      note: `${plural(team.proven, 'proven issue', 'proven issues')}${ended ? '' : ' so far'}`,
      state: ended ? 'done' : 'idle',
    },
  ];
  const withState = phases.map((p) => (p.agents.length === 0 ? p : { ...p, state: phaseState(p.agents) }));
  const total = withState.reduce((n, p) => n + p.agents.length, 0);
  const links: Readonly<Record<string, string | undefined>> = {
    plan: team.tasks === 0 ? undefined : plural(team.tasks, 'task given', 'tasks given'),
    validation: team.candidates === 0 ? undefined : plural(team.candidates, 'candidate', 'candidates'),
    review: team.proven === 0 ? undefined : plural(team.proven, 'proven issue', 'proven issues'),
  };
  return (
    <div className="flex flex-col gap-5 p-5 sm:p-7">
      <div className="flex items-start gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h2 className="m-0 flex items-center gap-2 text-[18px] font-semibold text-foreground">
            <Icon name="team" size={18} />
            Blackwing&apos;s team
          </h2>
          <p className="m-0 text-[13px] text-muted-foreground">
            {plural(total, 'agent', 'agents')} across {withState.length.toLocaleString('en-US')} phases. Open a phase to see who is in it, then pick an agent to read only its part of the conversation.
          </p>
        </div>
        <button
          type="button"
          data-autofocus
          aria-label="Close full screen team view"
          onClick={onClose}
          className="inline-flex size-11 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-surface-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-focus"
        >
          <Icon name="x" size={16} />
        </button>
      </div>
      <ol aria-label="Phases" className="m-0 flex list-none flex-col p-0">
        {withState.map((p, i) => {
          const link = i === 0 ? undefined : links[p.key];
          return (
            <li key={p.key} className="flex flex-col">
              {i === 0 ? null : (
                <span aria-hidden="true" className="flex items-center gap-2 py-1.5 pl-[31px] text-[11.5px] text-muted-foreground">
                  <span className="h-5 w-[1.5px] bg-border-strong" />
                  {link}
                </span>
              )}
              <PhaseCard
                phase={p}
                index={i}
                open={opened.includes(p.key)}
                onToggle={() => {
                  toggle(p.key);
                }}
                filter={filter}
                onPick={onPick}
              />
            </li>
          );
        })}
      </ol>
      <div role="group" aria-label="Legend" className="flex flex-wrap gap-x-4 gap-y-2 border-t border-border pt-4 text-[12px] text-muted-foreground">
        {STATE_ORDER.map((st) => (
          <span key={st} className="flex items-center gap-1.5">
            <StateMark state={st} />
            {STATE_WORD[st].replace(' on you', '')[0]?.toUpperCase()}
            {STATE_WORD[st].replace(' on you', '').slice(1)}
            {st === 'waiting' ? ' on you' : ''}
          </span>
        ))}
      </div>
    </div>
  );
}

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
  const [full, setFull] = useState(false);
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
    <p className="m-0 py-3 text-[12.5px] text-muted-foreground">
      {ended ? 'No agent started: the run ended before testing began.' : 'The team appears when the run starts.'}
    </p>
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
        <NodeButton node={team.validator} mono="replay engine" wide selected={filter === 'validator'} onSelect={select} />
      )}
      <Down label={proven} />
      <p className="m-0 text-[12px] text-muted-foreground">
        Your review: <b className="font-semibold text-foreground">{gate3}</b> · Report: {report}
      </p>
    </div>
  ) : (
    <div className="flex items-center overflow-x-auto p-[4px] [scrollbar-color:var(--border2)_transparent] [scrollbar-width:thin]">
      {/* Narrow desktops: the approval (also on the spine) and the report count (also in the side panel) give way, so
          the agents keep their full names without a sideways scroll. */}
      <span className="contents max-[1359px]:hidden">
        <Diamond label="Your approval" term="Gate 1: scope approval" who={gate1} done />
        <Arrow />
      </span>
      {team.planner === null ? null : (
        <div className="w-[108px] shrink-0">
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
        <div className="w-[132px] shrink-0">
          <NodeButton node={team.validator} mono="replay engine" stacked selected={filter === 'validator'} onSelect={select} />
        </div>
      )}
      <Arrow wide label={proven} />
      <Diamond label="Your review" term="Gate 3: triage and release" who={gate3} done={(team.autoReleased && team.proven > 0) || gate3 === 'Review complete'} />
      <Arrow className="max-[1359px]:hidden" />
      <div className="max-w-[74px] shrink-0 max-[1359px]:hidden rounded-[10px] border border-border bg-surface px-2.5 py-1.5 text-[12px] leading-4">
        <b className="font-semibold">Report</b>
        <div className="text-[11px] text-muted-foreground">{report}</div>
      </div>
    </div>
  );

  return (
    <section aria-label="Blackwing's team" className={column ? '' : 'rounded-[14px] border border-border bg-surface px-3.5 pb-3 pt-2.5'}>
      <div className={`flex flex-wrap items-center gap-2.5 text-[12.5px] font-semibold ${collapsed && !column ? '' : 'mb-2'}`}>
        <Icon name="team" size={15} />
        Blackwing&apos;s team
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
        {column ? null : (
          <span className={`flex items-center gap-1 ${collapsed || filter !== null ? 'ml-auto' : ''}`}>
            {empty ? null : (
              <button
                type="button"
                aria-label="Open the team map full screen"
                onClick={() => {
                  setFull(true);
                }}
                className="inline-flex h-6 items-center gap-1 whitespace-nowrap rounded-md px-2 text-[11.5px] font-medium text-muted-foreground hover:bg-surface-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-focus"
              >
                <svg aria-hidden="true" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M4 9V4h5 M20 9V4h-5 M4 15v5h5 M20 15v5h-5" />
                </svg>
                Full screen
              </button>
            )}
            {onToggle === undefined ? null : (
              <button
                type="button"
                aria-expanded={!collapsed}
                onClick={onToggle}
                className="inline-flex h-6 items-center gap-1 whitespace-nowrap rounded-md px-2 text-[11.5px] font-medium text-muted-foreground hover:bg-surface-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-focus"
              >
                {collapsed ? 'Show map' : 'Hide map'}
                <Icon name="chevron" size={12} className={collapsed ? '' : 'rotate-180'} />
              </button>
            )}
          </span>
        )}
      </div>
      {collapsed && !column ? null : body}
      {column ? null : (
        <Modal
          open={full}
          onClose={() => {
            setFull(false);
          }}
          label="Blackwing's team"
          className="max-w-[760px]"
        >
          <PhaseMap
            team={team}
            gate1={gate1}
            gate3={gate3}
            ended={ended}
            filter={filter}
            onClose={() => {
              setFull(false);
            }}
            onPick={(id) => {
              onFilter(id);
              setFull(false);
            }}
          />
        </Modal>
      )}
    </section>
  );
}
