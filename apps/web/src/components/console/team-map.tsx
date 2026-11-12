/* eslint-disable @typescript-eslint/no-magic-numbers -- design pixel values, see design/README.md */
'use client';

// Blackwing's team (experience spec §5.2 item 3): Your approval → Planner → one node per subagent in the run.started
// manifest → Validator → Your review → Report, drawn as a true connected node-graph. Node states come from
// teamNodes() in run-model.ts; clicking a node filters the conversation to that agent.
//
// Why it is built this way (one source of truth, no DOM measurement):
// every node AND every connector is placed from the SAME layout model in one fixed coordinate space (`buildRow` /
// `buildColumn` below). The whole scene is then scaled uniformly to fit its container with a single CSS transform, so
// an edge can never drift away from a node — nodes and edges scale together. Connectors are drawn in an SVG layer that
// sits *behind* the opaque node cards and overshoot a couple of pixels into them, so a join can never show a gap. The
// human gates are diamonds (a different shape, so the row never reads as a list of identical cards); the planner fans
// out to the specialists through one shared junction point and they fan back into the validator, which is what makes it
// look like one wire splitting and re-joining rather than three stray lines.
//
// The desktop inline map draws the horizontal graph (collapsible); the phone's Team sheet draws the same model as a
// vertical graph. The header's Full screen button opens the same horizontal graph, larger, on a faint dot grid, with a
// side drawer that shows the picked agent and a button to read only its part of the conversation.
import { useEffect, useRef, useState, type RefObject } from 'react';

import { Icon } from './design';
import { Modal } from './modal';

import type { Team, TeamNode } from './run-model';

type GState = TeamNode['state'];

function Ring({ className = '' }: { readonly className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={`size-[9px] shrink-0 rounded-full border-2 border-current ${className}`}
    />
  );
}

const TONE: Readonly<Record<GState, string>> = {
  working: 'border-slate bg-surface',
  waiting:
    'border-[1.5px] border-gold-ink bg-[repeating-linear-gradient(135deg,var(--gold-soft)_0_6px,var(--surface)_6px_12px)]',
  done: 'border-border bg-surface',
  idle: 'border-border bg-surface',
  stopped: 'border-dashed border-border-strong bg-surface-2',
};

const STATE_WORD: Readonly<Record<GState, string>> = {
  working: 'working',
  waiting: 'waiting on you',
  done: 'done',
  idle: 'idle',
  stopped: 'stopped',
};

const plural = (n: number, one: string, many: string): string =>
  `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

/** The phase's headline state: someone waiting on you outranks work, work outranks the rest. */
function groupState(agents: readonly TeamNode[]): GState {
  if (agents.length === 0) return 'idle';
  if (agents.some((n) => n.state === 'waiting')) return 'waiting';
  if (agents.some((n) => n.state === 'working')) return 'working';
  if (agents.some((n) => n.state === 'stopped')) return 'stopped';
  if (agents.every((n) => n.state === 'done')) return 'done';
  return 'idle';
}

function StateMark({
  state,
  spinning = false,
}: {
  readonly state: GState;
  readonly spinning?: boolean;
}) {
  if (state === 'working') {
    return (
      <Ring
        className={`text-slate ${spinning ? 'border-t-transparent motion-safe:animate-[bwspin_0.9s_linear_infinite]' : ''}`}
      />
    );
  }
  if (state === 'waiting')
    return (
      <i
        aria-hidden="true"
        className="size-[9px] shrink-0 rounded-[2px] border-[1.5px] border-gold-ink bg-gold-soft motion-safe:animate-pulse"
      />
    );
  if (state === 'done')
    return <i aria-hidden="true" className="size-[9px] shrink-0 rounded-full bg-ok" />;
  if (state === 'stopped')
    return (
      <i aria-hidden="true" className="h-[2px] w-2.5 shrink-0 rounded-full bg-muted-foreground" />
    );
  return (
    <i
      aria-hidden="true"
      className="size-[9px] shrink-0 rounded-full border-[1.5px] border-border-strong"
    />
  );
}

// ---------------------------------------------------------------------------
// Layout model. One coordinate space; nodes and edges both read from it.
// ---------------------------------------------------------------------------

type EdgeTone = 'active' | 'done' | 'pending';

interface GNode {
  readonly key: string;
  readonly role: 'agent' | 'gate' | 'report';
  readonly name: string;
  readonly mono: string | null;
  readonly sub: string | null;
  readonly state: GState;
  readonly spinning: boolean;
  /** Gate only: who/when under the diamond (e.g. "You, 2:02 pm"). */
  readonly who: string | null;
  /** Gate/report tooltip term. */
  readonly term: string | null;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  /** The id handed to onFilter when picked, or null for the gates/report (not filterable). */
  readonly filterId: string | null;
}

interface GEdge {
  readonly d: string;
  readonly tone: EdgeTone;
}

interface GJoint {
  readonly x: number;
  readonly y: number;
  readonly tone: EdgeTone;
}

interface GCaption {
  readonly x: number;
  readonly y: number;
  readonly text: string;
}

interface Scene {
  readonly nodes: readonly GNode[];
  readonly edges: readonly GEdge[];
  readonly joints: readonly GJoint[];
  readonly captions: readonly GCaption[];
  readonly width: number;
  readonly height: number;
}

/** Edge arriving at a real node: gold only once that node is done, animated while it is live and its predecessor is done. */
const eInto = (predDone: boolean, s: GState): EdgeTone =>
  s === 'done' ? 'done' : predDone && (s === 'working' || s === 'waiting') ? 'active' : 'pending';
/** Edge leaving a real node. */
const eOut = (s: GState): EdgeTone =>
  s === 'done' ? 'done' : s === 'working' || s === 'waiting' ? 'active' : 'pending';

// Horizontal geometry.
const AW = 158;
const AH = 58;
const RW = 112;
const GS = 44; // gate diamond side
const GAP = 78; // vertical spacing between stacked specialists
const INSET = 2; // overshoot: edges start/end this far inside the node, hidden under its opaque fill

const halfW = (n: GNode): number =>
  n.role === 'gate' ? 29 : n.role === 'report' ? RW / 2 : AW / 2;
const rightOf = (n: GNode): { x: number; y: number } => ({ x: n.x + halfW(n) - INSET, y: n.y });
const leftOf = (n: GNode): { x: number; y: number } => ({ x: n.x - halfW(n) + INSET, y: n.y });

interface Pt {
  readonly x: number;
  readonly y: number;
}
const cubicH = (a: Pt, b: Pt): string => {
  const dx = Math.max(22, Math.abs(b.x - a.x) * 0.5);
  return `M${a.x} ${a.y} C${a.x + dx} ${a.y} ${b.x - dx} ${b.y} ${b.x} ${b.y}`;
};
const line = (a: Pt, b: Pt): string => `M${a.x} ${a.y} L${b.x} ${b.y}`;
const cubicV = (a: Pt, b: Pt): string => {
  const dy = Math.max(18, Math.abs(b.y - a.y) * 0.5);
  return `M${a.x} ${a.y} C${a.x} ${a.y + dy} ${b.x} ${b.y - dy} ${b.x} ${b.y}`;
};

function buildRow(
  team: Team,
  gate1: string,
  gate3: string,
  ended: boolean,
  withCaptions: boolean,
): Scene {
  const specs = team.specialists;
  const n = Math.max(specs.length, 1);
  const span = (n - 1) * GAP;
  const height = Math.max(190, span + AH + 76);
  const spineY = height / 2;

  const gate1X = 46;
  const plannerX = 196;
  const specX = 460;
  const valX = 726;
  const gate3X = 892;
  const reportX = 1016;
  const width = reportX + RW / 2 + 24;

  const reviewDone = (team.autoReleased && team.proven > 0) || gate3 === 'Review complete';
  const report = `${team.proven.toLocaleString('en-US')} proven${ended ? '' : ' so far'}`;

  const gate1Node: GNode = {
    key: 'gate1',
    role: 'gate',
    name: 'Your approval',
    mono: null,
    sub: null,
    state: 'done',
    spinning: false,
    who: gate1,
    term: 'Gate 1: scope approval',
    x: gate1X,
    y: spineY,
    w: GS,
    h: GS,
    filterId: null,
  };
  const planner: GNode | null =
    team.planner === null
      ? null
      : {
          key: 'planner',
          role: 'agent',
          name: team.planner.name,
          mono: 'orchestrator',
          sub: team.planner.sub,
          state: team.planner.state,
          spinning: team.planner.spinning,
          who: null,
          term: null,
          x: plannerX,
          y: spineY,
          w: AW,
          h: AH,
          filterId: team.planner.id,
        };
  const specNodes: GNode[] = specs.map((s, i) => ({
    key: s.id,
    role: 'agent',
    name: s.name,
    mono: s.id,
    sub: s.sub,
    state: s.state,
    spinning: s.spinning,
    who: null,
    term: null,
    x: specX,
    y: spineY + (i - (specs.length - 1) / 2) * GAP,
    w: AW,
    h: AH,
    filterId: s.id,
  }));
  const validator: GNode | null =
    team.validator === null
      ? null
      : {
          key: 'validator',
          role: 'agent',
          name: team.validator.name,
          mono: 'replay engine',
          sub: team.validator.sub,
          state: team.validator.state,
          spinning: team.validator.spinning,
          who: null,
          term: null,
          x: valX,
          y: spineY,
          w: AW,
          h: AH,
          filterId: 'validator',
        };
  const gate3Node: GNode = {
    key: 'gate3',
    role: 'gate',
    name: 'Your review',
    mono: null,
    sub: null,
    state: reviewDone ? 'done' : 'idle',
    spinning: false,
    who: gate3,
    term: 'Gate 3: triage and release',
    x: gate3X,
    y: spineY,
    w: GS,
    h: GS,
    filterId: null,
  };
  const reportNode: GNode = {
    key: 'report',
    role: 'report',
    name: 'Report',
    mono: null,
    sub: report,
    state: ended ? 'done' : 'idle',
    spinning: false,
    who: null,
    term: 'The final write-up',
    x: reportX,
    y: spineY,
    w: RW,
    h: AH,
    filterId: null,
  };

  const nodes: GNode[] = [gate1Node];
  const edges: GEdge[] = [];
  const joints: GJoint[] = [];

  // gate1 → planner (or straight on to the specialists / validator if no planner yet)
  const head = planner ?? null;
  if (planner) {
    nodes.push(planner);
    edges.push({
      d: cubicH(rightOf(gate1Node), leftOf(planner)),
      tone: eInto(true, planner.state),
    });
  }
  const source = head ?? gate1Node;

  if (specNodes.length > 0) {
    const gs = groupState(specs);
    const tJoint: Pt = { x: rightOf(source).x + 26, y: spineY };
    const mTarget = validator ?? gate3Node;
    const mJoint: Pt = { x: leftOf(mTarget).x - 26, y: spineY };
    // source → split junction
    edges.push({ d: line(rightOf(source), tJoint), tone: eInto(source.state === 'done', gs) });
    joints.push({ ...tJoint, tone: eOut(gs) });
    for (const s of specNodes) {
      nodes.push(s);
      edges.push({ d: cubicH(tJoint, leftOf(s)), tone: eInto(source.state === 'done', s.state) });
      edges.push({ d: cubicH(rightOf(s), mJoint), tone: eOut(s.state) });
    }
    const allSpecsDone = specs.length > 0 && specs.every((s) => s.state === 'done');
    joints.push({
      ...mJoint,
      tone: allSpecsDone
        ? 'done'
        : specs.some((s) => s.state === 'working' || s.state === 'waiting')
          ? 'active'
          : 'pending',
    });
    // merge junction → validator
    edges.push({ d: line(mJoint, leftOf(mTarget)), tone: eInto(allSpecsDone, mTarget.state) });
  } else if (validator) {
    edges.push({
      d: cubicH(rightOf(source), leftOf(validator)),
      tone: eInto(source.state === 'done', validator.state),
    });
  }

  if (validator) {
    nodes.push(validator);
    edges.push({
      d: cubicH(rightOf(validator), leftOf(gate3Node)),
      tone: eInto(validator.state === 'done', gate3Node.state),
    });
  } else if (specNodes.length === 0) {
    edges.push({
      d: cubicH(rightOf(source), leftOf(gate3Node)),
      tone: eInto(source.state === 'done', gate3Node.state),
    });
  }
  nodes.push(gate3Node, reportNode);
  edges.push({
    d: cubicH(rightOf(gate3Node), leftOf(reportNode)),
    tone: eInto(gate3Node.state === 'done', reportNode.state),
  });

  const captions: GCaption[] = [];
  if (withCaptions && specNodes.length > 0) {
    const bottom = Math.max(...specNodes.map((s) => s.y));
    captions.push({
      x: specX,
      y: bottom + AH / 2 + 14,
      text: plural(specNodes.length, 'specialist, in parallel', 'specialists, in parallel'),
    });
  }

  return { nodes, edges, joints, captions, width, height };
}

// Vertical geometry for the phone Team sheet: the same model, top to bottom, with the specialists bracketed off a left rail.
const VW = 320;
const VCX = 164;
const VAW = 226;
const VAH = 54;
const VSW = 198;
const VRAIL = 34;
const VGAP = 64;

const vHalf = (n: GNode): number => (n.role === 'gate' ? 24 : n.h / 2);
const vTop = (n: GNode): Pt => ({ x: n.x, y: n.y - vHalf(n) + INSET });
const vBot = (n: GNode): Pt => ({ x: n.x, y: n.y + vHalf(n) - INSET });

function buildColumn(team: Team, gate1: string, gate3: string, ended: boolean): Scene {
  const specs = team.specialists;
  const reviewDone = (team.autoReleased && team.proven > 0) || gate3 === 'Review complete';
  const report = `${team.proven.toLocaleString('en-US')} proven${ended ? '' : ' so far'}`;

  let y = 30;
  const gate1Node: GNode = {
    key: 'gate1',
    role: 'gate',
    name: 'Your approval',
    mono: null,
    sub: null,
    state: 'done',
    spinning: false,
    who: gate1,
    term: 'Gate 1: scope approval',
    x: VCX,
    y,
    w: GS,
    h: GS,
    filterId: null,
  };
  y += 76;
  const planner: GNode | null =
    team.planner === null
      ? null
      : {
          key: 'planner',
          role: 'agent',
          name: team.planner.name,
          mono: 'orchestrator',
          sub: team.planner.sub,
          state: team.planner.state,
          spinning: team.planner.spinning,
          who: null,
          term: null,
          x: VCX,
          y,
          w: VAW,
          h: VAH,
          filterId: team.planner.id,
        };
  if (planner) y += VAH / 2 + 30;
  else y += 4;
  const specNodes: GNode[] = specs.map((s, i) => ({
    key: s.id,
    role: 'agent',
    name: s.name,
    mono: s.id,
    sub: s.sub,
    state: s.state,
    spinning: s.spinning,
    who: null,
    term: null,
    x: VCX + (VAW - VSW) / 2,
    y: y + VAH / 2 + i * VGAP,
    w: VSW,
    h: VAH,
    filterId: s.id,
  }));
  if (specNodes.length > 0) y = (specNodes[specNodes.length - 1]?.y ?? y) + VAH / 2 + 30;
  const validator: GNode | null =
    team.validator === null
      ? null
      : {
          key: 'validator',
          role: 'agent',
          name: team.validator.name,
          mono: 'replay engine',
          sub: team.validator.sub,
          state: team.validator.state,
          spinning: team.validator.spinning,
          who: null,
          term: null,
          x: VCX,
          y: y + VAH / 2,
          w: VAW,
          h: VAH,
          filterId: 'validator',
        };
  if (validator) y = validator.y + VAH / 2 + 46;
  const gate3Node: GNode = {
    key: 'gate3',
    role: 'gate',
    name: 'Your review',
    mono: null,
    sub: null,
    state: reviewDone ? 'done' : 'idle',
    spinning: false,
    who: gate3,
    term: 'Gate 3: triage and release',
    x: VCX,
    y: y + 2,
    w: GS,
    h: GS,
    filterId: null,
  };
  y = gate3Node.y + 68;
  const reportNode: GNode = {
    key: 'report',
    role: 'report',
    name: 'Report',
    mono: null,
    sub: report,
    state: ended ? 'done' : 'idle',
    spinning: false,
    who: null,
    term: 'The final write-up',
    x: VCX,
    y: y + VAH / 2,
    w: VAW,
    h: VAH,
    filterId: null,
  };
  const height = reportNode.y + VAH / 2 + 26;

  const nodes: GNode[] = [gate1Node];
  const edges: GEdge[] = [];
  const joints: GJoint[] = [];
  if (planner) {
    nodes.push(planner);
    edges.push({ d: cubicV(vBot(gate1Node), vTop(planner)), tone: eInto(true, planner.state) });
  }
  const source = planner ?? gate1Node;
  if (specNodes.length > 0) {
    const gs = groupState(specs);
    const railTop: Pt = { x: VRAIL, y: vBot(source).y + 14 };
    const mTarget = validator ?? gate3Node;
    const railBot: Pt = { x: VRAIL, y: vTop(mTarget).y - 14 };
    edges.push({
      d: `M${vBot(source).x} ${vBot(source).y} C${vBot(source).x} ${vBot(source).y + 14} ${railTop.x} ${railTop.y - 14} ${railTop.x} ${railTop.y}`,
      tone: eInto(source.state === 'done', gs),
    });
    edges.push({ d: line(railTop, railBot), tone: eOut(gs) });
    joints.push({ ...railTop, tone: eOut(gs) });
    for (const s of specNodes) {
      nodes.push(s);
      const sleft: Pt = { x: s.x - VSW / 2 + INSET, y: s.y };
      edges.push({
        d: cubicH({ x: VRAIL, y: s.y }, sleft),
        tone: eInto(source.state === 'done', s.state),
      });
    }
    const allSpecsDone = specs.every((s) => s.state === 'done');
    edges.push({
      d: `M${railBot.x} ${railBot.y} C${railBot.x} ${railBot.y + 14} ${vTop(mTarget).x} ${vTop(mTarget).y - 14} ${vTop(mTarget).x} ${vTop(mTarget).y}`,
      tone: eInto(allSpecsDone, mTarget.state),
    });
    joints.push({
      ...railBot,
      tone: allSpecsDone
        ? 'done'
        : specs.some((s) => s.state === 'working' || s.state === 'waiting')
          ? 'active'
          : 'pending',
    });
  } else if (validator) {
    edges.push({
      d: cubicV(vBot(source), vTop(validator)),
      tone: eInto(source.state === 'done', validator.state),
    });
  }
  if (validator) {
    nodes.push(validator);
    edges.push({
      d: cubicV(vBot(validator), vTop(gate3Node)),
      tone: eInto(validator.state === 'done', gate3Node.state),
    });
  } else if (specNodes.length === 0) {
    edges.push({
      d: cubicV(vBot(source), vTop(gate3Node)),
      tone: eInto(source.state === 'done', gate3Node.state),
    });
  }
  nodes.push(gate3Node, reportNode);
  edges.push({
    d: cubicV(vBot(gate3Node), vTop(reportNode)),
    tone: eInto(gate3Node.state === 'done', reportNode.state),
  });

  return { nodes, edges, joints, captions: [], width: VW, height };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const EDGE_FLOW = `@keyframes bwflow{to{stroke-dashoffset:-16}}.bw-edge-active{stroke-dasharray:3 5;animation:bwflow .9s linear infinite}@media (prefers-reduced-motion:reduce){.bw-edge-active{animation:none}}`;
const edgeStroke = (t: EdgeTone): string =>
  t === 'pending' ? 'var(--border-strong)' : 'var(--gold-ink)';

function EdgeLayer({ scene }: { readonly scene: Scene }) {
  return (
    <svg
      aria-hidden="true"
      width={scene.width}
      height={scene.height}
      viewBox={`0 0 ${scene.width} ${scene.height}`}
      className="pointer-events-none absolute left-0 top-0 overflow-visible"
    >
      <defs>
        <style>{EDGE_FLOW}</style>
      </defs>
      {scene.edges.map((e, i) => (
        <path
          key={i}
          d={e.d}
          fill="none"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
          className={e.tone === 'active' ? 'bw-edge-active' : ''}
          style={{
            stroke: edgeStroke(e.tone),
            strokeWidth: e.tone === 'pending' ? 1.25 : 1.5,
            opacity: e.tone === 'done' ? 0.5 : 1,
          }}
        />
      ))}
      {scene.joints.map((j, i) => (
        <circle
          key={`j${i}`}
          cx={j.x}
          cy={j.y}
          r={2.4}
          style={{ fill: edgeStroke(j.tone), opacity: j.tone === 'done' ? 0.5 : 1 }}
        />
      ))}
    </svg>
  );
}

function NodeView({
  node,
  selected,
  onPick,
}: {
  readonly node: GNode;
  readonly selected: boolean;
  readonly onPick: (n: GNode) => void;
}) {
  const pos = {
    position: 'absolute' as const,
    left: node.x - node.w / 2,
    top: node.y - node.h / 2,
    width: node.w,
    height: node.h,
  };

  if (node.role === 'gate') {
    return (
      <>
        <span
          aria-hidden="true"
          style={{ position: 'absolute', left: node.x - 58, top: node.y - GS / 2 - 18, width: 116 }}
          className="text-center text-[10.5px] leading-[14px] text-muted-foreground"
        >
          {node.name}
        </span>
        <i
          title={node.term ?? undefined}
          aria-hidden="true"
          style={{
            position: 'absolute',
            left: node.x - GS / 2,
            top: node.y - GS / 2,
            width: GS,
            height: GS,
          }}
          className={`rotate-45 rounded-[4px] border-[1.5px] ${node.state === 'done' ? 'border-ok bg-ok-soft' : 'border-border-strong bg-surface'}`}
        />
        <b
          style={{ position: 'absolute', left: node.x - 58, top: node.y + GS / 2 + 3, width: 116 }}
          className="text-center text-[10.5px] font-semibold leading-[14px] text-foreground"
        >
          {node.who}
        </b>
      </>
    );
  }

  if (node.role === 'report') {
    return (
      <div
        title={node.term ?? undefined}
        style={pos}
        className={`flex flex-col justify-center rounded-[12px] border px-2.5 ${TONE[node.state]}`}
      >
        <span className="text-[12.5px] font-semibold leading-4 text-foreground">{node.name}</span>
        <span className="truncate text-[11px] leading-[14px] text-muted-foreground">
          {node.sub}
        </span>
      </div>
    );
  }

  const word = STATE_WORD[node.state];
  const said = node.sub?.startsWith(word)
    ? `${node.name}: ${node.sub}`
    : `${node.name}, ${word}${node.sub ? `: ${node.sub}` : ''}`;
  return (
    <button
      type="button"
      aria-pressed={selected}
      title={`${node.name}${node.mono ? ` (${node.mono})` : ''}${node.sub ? `: ${node.sub}` : ''}. Click to show only its part of the conversation.`}
      aria-label={`${said}. Show only its part of the conversation.`}
      onClick={() => {
        onPick(node);
      }}
      style={pos}
      className={`flex flex-col justify-center gap-0.5 overflow-hidden rounded-[12px] border px-2.5 text-left transition-shadow hover:shadow-[0_0_0_3px_var(--focus)] focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-focus ${TONE[node.state]} ${selected ? 'shadow-[0_0_0_2px_var(--gold-ink)]' : ''}`}
    >
      <span className="flex min-w-0 items-center gap-1.5">
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-semibold leading-4 text-foreground">
          {node.name}
        </span>
        <StateMark state={node.state} spinning={node.spinning} />
      </span>
      {node.mono === null ? null : (
        <span className="truncate font-mono text-[10.5px] leading-[13px] text-muted-foreground">
          {node.mono}
        </span>
      )}
      {node.sub === null ? null : (
        <span
          className={`truncate text-[11px] leading-[14px] ${node.state === 'waiting' ? 'font-medium text-gold-ink' : 'text-muted-foreground'}`}
        >
          {node.sub}
        </span>
      )}
    </button>
  );
}

/** Uniform fit scale. The ONLY measurement; it feeds a single transform, so nodes and edges always scale together. */
function useFitScale(
  width: number,
  height: number,
  min: number,
  max: number,
  byHeight: boolean,
): [RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [scale, setScale] = useState(byHeight ? min : max);
  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const measure = (): void => {
      const bw = el.clientWidth;
      const bh = el.clientHeight;
      let s = bw / width;
      if (byHeight && bh > 0) s = Math.min(s, bh / height);
      s = Math.min(max, Math.max(min, s));
      setScale((prev) => (Math.abs(prev - s) < 0.004 ? prev : s));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => {
      ro.disconnect();
    };
  }, [width, height, min, max, byHeight]);
  return [ref, scale];
}

function GraphScene({
  scene,
  filter,
  onPick,
  variant,
}: {
  readonly scene: Scene;
  readonly filter: string | null;
  readonly onPick: (n: GNode) => void;
  readonly variant: 'inline' | 'full' | 'column';
}) {
  const full = variant === 'full';
  const [ref, scale] = useFitScale(
    scene.width,
    scene.height,
    full ? 0.55 : variant === 'column' ? 0.62 : 0.52,
    full ? 1.9 : 1,
    full,
  );
  return (
    <div
      ref={ref}
      className={
        full
          ? 'relative flex w-full flex-1 items-center justify-center overflow-auto p-2'
          : 'relative w-full overflow-x-auto'
      }
    >
      <div
        className={`relative shrink-0 origin-top-left ${full ? 'rounded-[16px] border border-border bg-[radial-gradient(var(--border)_0.7px,transparent_0.7px)] [background-size:18px_18px]' : ''}`}
        style={{ width: scene.width * scale, height: scene.height * scale }}
      >
        <div
          className="absolute left-0 top-0 origin-top-left"
          style={{ width: scene.width, height: scene.height, transform: `scale(${scale})` }}
        >
          <EdgeLayer scene={scene} />
          {scene.nodes.map((node) => (
            <NodeView
              key={node.key}
              node={node}
              selected={node.filterId !== null && filter === node.filterId}
              onPick={onPick}
            />
          ))}
          {scene.captions.map((c, i) => (
            <span
              key={`c${i}`}
              aria-hidden="true"
              style={{ position: 'absolute', left: c.x - 110, top: c.y, width: 220 }}
              className="text-center text-[11px] font-medium text-muted-foreground"
            >
              {c.text}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

function Legend({ className = '' }: { readonly className?: string }) {
  return (
    <span
      className={`flex flex-wrap gap-x-3 gap-y-1 text-[11px] font-normal text-muted-foreground ${className}`}
    >
      <span className="flex items-center gap-1.5">
        <Ring className="text-slate" />
        Working
      </span>
      <span className="flex items-center gap-1.5">
        <i
          aria-hidden="true"
          className="size-[9px] rounded-[2px] border-[1.5px] border-gold-ink bg-gold-soft"
        />
        Waiting on you
      </span>
      <span className="flex items-center gap-1.5">
        <i aria-hidden="true" className="size-[7px] rounded-full bg-ok" />
        Done
      </span>
    </span>
  );
}

/** Full-screen graph: the same horizontal scene, larger, plus a side drawer for the picked agent. */
function FullGraph({
  team,
  gate1,
  gate3,
  ended,
  filter,
  onFilter,
  onClose,
}: {
  readonly team: Team;
  readonly gate1: string;
  readonly gate3: string;
  readonly ended: boolean;
  readonly filter: string | null;
  readonly onFilter: (id: string | null) => void;
  readonly onClose: () => void;
}) {
  const scene = buildRow(team, gate1, gate3, ended, true);
  const [detail, setDetail] = useState<GNode | null>(
    () => scene.nodes.find((nd) => nd.filterId !== null && nd.filterId === filter) ?? null,
  );
  const total =
    team.specialists.length + (team.planner === null ? 0 : 1) + (team.validator === null ? 0 : 1);
  return (
    <div className="flex h-full flex-col gap-4 p-5 sm:p-6">
      <div className="flex items-start gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h2 className="m-0 flex items-center gap-2 text-[18px] font-semibold text-foreground">
            <Icon name="team" size={18} />
            Blackwing&apos;s team
          </h2>
          <p className="m-0 text-[13px] text-muted-foreground">
            {plural(total, 'agent', 'agents')} from your approval through to the report. Pick any
            agent to read only its part of the conversation.
          </p>
        </div>
        <Legend className="mt-1 hidden md:flex" />
        <button
          type="button"
          data-autofocus
          aria-label="Close full screen team view"
          onClick={onClose}
          className="inline-flex size-10 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-surface-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-focus"
        >
          <Icon name="x" size={16} />
        </button>
      </div>
      <div className="flex min-h-0 flex-1 gap-4">
        <GraphScene
          scene={scene}
          filter={filter}
          variant="full"
          onPick={(n) => {
            setDetail(n);
            if (n.filterId !== null) onFilter(n.filterId);
          }}
        />
        {detail === null ? null : (
          <aside className="flex w-[300px] shrink-0 flex-col gap-3 overflow-y-auto rounded-[14px] border border-border bg-surface p-4">
            <div className="flex items-start justify-between gap-2">
              <div className="flex items-center gap-2">
                <StateMark state={detail.state} spinning={detail.spinning} />
                <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  {STATE_WORD[detail.state]}
                </span>
              </div>
              <button
                type="button"
                aria-label="Close agent detail"
                onClick={() => {
                  setDetail(null);
                }}
                className="inline-flex size-7 items-center justify-center rounded-full text-muted-foreground hover:bg-surface-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-focus"
              >
                <Icon name="x" size={13} />
              </button>
            </div>
            <div className="flex flex-col gap-0.5">
              <h3 className="m-0 text-[15px] font-semibold text-foreground">{detail.name}</h3>
              {detail.mono === null ? null : (
                <span className="font-mono text-[11.5px] text-muted-foreground">{detail.mono}</span>
              )}
            </div>
            {detail.sub === null ? null : (
              <p
                className={`m-0 text-[13px] leading-5 ${detail.state === 'waiting' ? 'font-medium text-gold-ink' : 'text-muted-foreground'}`}
              >
                {detail.sub}
              </p>
            )}
            {detail.filterId === null ? (
              <p className="m-0 text-[12px] leading-5 text-muted-foreground">
                This is a checkpoint, not an agent — nothing to read in the conversation.
              </p>
            ) : (
              <button
                type="button"
                onClick={() => {
                  onFilter(detail.filterId);
                  onClose();
                }}
                className="inline-flex h-10 items-center justify-center gap-1.5 rounded-[10px] bg-gold-soft px-3 text-[13px] font-medium text-gold-ink hover:shadow-[0_0_0_3px_var(--focus)] focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-focus"
              >
                Read only its conversation
                <Icon name="arrow" size={13} />
              </button>
            )}
          </aside>
        )}
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
  readonly onFilter: (id: string | null) => void;
  readonly layout?: 'row' | 'column';
  readonly collapsed?: boolean;
  readonly onToggle?: (() => void) | undefined;
}) {
  const [full, setFull] = useState(false);
  const column = layout === 'column';
  const select = (n: GNode): void => {
    if (n.filterId === null) return;
    onFilter(filter === n.filterId ? null : n.filterId);
  };
  const empty = team.planner === null && team.specialists.length === 0;
  const scene = column
    ? buildColumn(team, gate1, gate3, ended)
    : buildRow(team, gate1, gate3, ended, false);

  const body = empty ? (
    <p className="m-0 py-3 text-[12.5px] text-muted-foreground">
      {ended
        ? 'No agent started: the run ended before testing began.'
        : 'The team appears when the run starts.'}
    </p>
  ) : (
    <GraphScene
      scene={scene}
      filter={filter}
      variant={column ? 'column' : 'inline'}
      onPick={select}
    />
  );

  return (
    <section
      aria-label="Blackwing's team"
      className={column ? '' : 'rounded-[14px] border border-border bg-surface px-3.5 pb-3 pt-2.5'}
    >
      <div
        className={`flex flex-wrap items-center gap-2.5 text-[12.5px] font-semibold ${collapsed && !column ? '' : 'mb-2'}`}
      >
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
        {(collapsed || filter !== null) && !column ? null : <Legend className="ml-auto" />}
        {column ? null : (
          <span
            className={`flex items-center gap-1 ${collapsed || filter !== null ? 'ml-auto' : ''}`}
          >
            {empty ? null : (
              <button
                type="button"
                aria-label="Open the team map full screen"
                onClick={() => {
                  setFull(true);
                }}
                className="inline-flex h-6 items-center gap-1 whitespace-nowrap rounded-md px-2 text-[11.5px] font-medium text-muted-foreground hover:bg-surface-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-focus"
              >
                <svg
                  aria-hidden="true"
                  viewBox="0 0 24 24"
                  width="12"
                  height="12"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
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
          className="h-[min(88vh,720px)] max-w-[1180px]"
        >
          <FullGraph
            team={team}
            gate1={gate1}
            gate3={gate3}
            ended={ended}
            filter={filter}
            onFilter={onFilter}
            onClose={() => {
              setFull(false);
            }}
          />
        </Modal>
      )}
    </section>
  );
}
