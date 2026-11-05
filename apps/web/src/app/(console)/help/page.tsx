// Help (experience spec §2): how an audit works, where you stay in control (the gates and Stop), Claude's team, the
// three voices, the words we use (plain first, technical second) and the keyboard shortcuts.
import { Kbd, VoiceTag, type Voice } from '../../../components/console/design';
import { AGENT_IDS, agentDoes, agentName } from '../../../lib/agents';

import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = { title: 'Help' };

const STEPS: readonly { who: 'You' | 'Claude'; title: string; body: string }[] = [
  { who: 'You', title: 'Tell us what to audit', body: 'Paste the address of a site you own and answer four short questions. Then prove the site is yours.' },
  { who: 'You', title: 'Approve the plan', body: 'Blackwing reads the whole plan back in plain words. Nothing reaches the site until you approve it.' },
  { who: 'Claude', title: "Claude's team works", body: 'The planner hands work to specialists, and you watch their conversation live. Anything that would change data waits for your yes.' },
  { who: 'You', title: 'Release the findings', body: 'The validator proves each issue by replaying it with a control. You decide what goes into the report.' },
];

const GATES: readonly { name: string; term: string; body: string }[] = [
  {
    name: 'Proof of ownership',
    term: 'asset verification',
    body: 'We only audit sites you show you control: a file on the site, or your recorded confirmation for internal hosts and labs.',
  },
  {
    name: 'Your approval',
    term: 'Gate 1',
    body: 'Before any test traffic: the site, what to look for, how careful to be, paths to avoid and the limits. Your name and reason go on the ledger.',
  },
  {
    name: 'Your decision',
    term: 'Gate 2 · runtime exception',
    body: 'When an agent wants to send a request that could change data, it stops and asks. Allowing needs a reason and lasts for this audit only. No answer in time means denied.',
  },
  {
    name: 'Release or dismiss',
    term: 'Gate 3 · triage',
    body: 'Proven issues wait for your release unless you chose automatic release on the plan. Only released issues reach the report and your webhook.',
  },
  {
    name: 'Stop testing',
    term: 'kill switch',
    body: 'Stops every agent at once. Requests already on the wire may finish; nothing new is sent. Open decisions are denied and findings so far are kept.',
  },
];

const VOICES: readonly { voice: Voice; body: string }[] = [
  { voice: 'claude', body: "Claude's own words: explanations, plans and fix suggestions. Useful, and never treated as proof." },
  { voice: 'blackwing', body: 'Blackwing describing what the runner recorded: counts, limits, times and requests.' },
  { voice: 'validator', body: 'The validator: code, not a model. It replays each issue three times with a control. Only it can prove an issue.' },
  { voice: 'you', body: 'Your decisions, each with your name and reason on the ledger.' },
];

const GLOSSARY: readonly [string, string][] = [
  ['Audit', 'assessment request and its run'],
  ['Target, site', 'asset'],
  ["Look, don't touch", 'passive: GET, HEAD and OPTIONS only'],
  ['Probe gently', 'active_safe: crafted read requests'],
  ['As a visitor / Signed-in testing', 'black box / grey box'],
  ['Proven', 'confirmed by deterministic replay'],
  ['Kept back', 'suspected queue'],
  ['Ledger', 'hash-chained audit ledger'],
];

const SHORTCUTS: readonly [ReactNode, string][] = [
  [<Kbd key="n">N</Kbd>, 'New audit'],
  [<Kbd key="q">?</Kbd>, 'Open Help'],
  [<Kbd key="e">Enter</Kbd>, 'Continue (Ctrl+Enter in a text box)'],
  [<Kbd key="esc">Esc</Kbd>, 'Back, or close a dialog'],
  [<Kbd key="1">1–9</Kbd>, 'Pick an option'],
  [
    <span key="da" className="inline-flex gap-1">
      <Kbd>D</Kbd>
      <Kbd>A</Kbd>
    </span>,
    'On a decision: deny, or start allowing',
  ],
  [<Kbd key="r">R</Kbd>, 'On a finding: release it to the report'],
  [<Kbd key="stop">Ctrl Shift .</Kbd>, 'Stop testing (asks once to confirm)'],
];

const TOC = [
  ['how', 'How it works'],
  ['control', 'Where you stay in control'],
  ['team', "Claude's team"],
  ['voices', 'Who is speaking'],
  ['words', 'Words we use'],
  ['keys', 'Keyboard shortcuts'],
] as const;

function Section({ id, title, children }: { readonly id: string; readonly title: string; readonly children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-h`} className="flex scroll-mt-6 flex-col gap-3">
      <h2 id={`${id}-h`} className="m-0 text-[18px] font-semibold text-foreground">
        {title}
      </h2>
      {children}
    </section>
  );
}

export default function HelpPage(): ReactNode {
  return (
    <div className="mx-auto flex w-full max-w-[860px] flex-col gap-8">
      <div className="flex flex-col gap-2">
        <h1 className="m-0 text-[28px] font-semibold leading-9 tracking-[-0.01em] text-foreground">Help</h1>
        <p className="m-0 text-[15px] leading-6 text-muted-foreground">
          Blackwing arranges a security audit of a web app you own. Claude&rsquo;s agents do the testing; you approve at
          every step that matters, and every decision is recorded.
        </p>
        <nav aria-label="On this page" className="mt-1 flex flex-wrap gap-1.5">
          {TOC.map(([id, label]) => (
            <a
              key={id}
              href={`#${id}`}
              className="inline-flex h-8 items-center rounded-full bg-surface-2 px-3 text-[12.5px] text-foreground hover:bg-gold-soft focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-focus"
            >
              {label}
            </a>
          ))}
        </nav>
      </div>

      <Section id="how" title="How it works">
        <ol className="m-0 grid list-none gap-2.5 p-0 sm:grid-cols-2">
          {STEPS.map((s, i) => (
            <li key={s.title} className="flex flex-col gap-1.5 rounded-[14px] border border-border bg-card p-4">
              <span className="flex items-center gap-2 text-[12px] text-muted-foreground">
                <span className="font-mono">{i + 1}</span>
                <VoiceTag voice={s.who === 'You' ? 'you' : 'claude'}>{s.who}</VoiceTag>
              </span>
              <span className="text-[14.5px] font-semibold text-foreground">{s.title}</span>
              <span className="text-[13px] leading-5 text-muted-foreground">{s.body}</span>
            </li>
          ))}
        </ol>
      </Section>

      <Section id="control" title="Where you stay in control">
        <dl className="m-0 flex flex-col overflow-hidden rounded-[14px] border border-border bg-card">
          {GATES.map((g) => (
            <div key={g.name} className="flex flex-col gap-1 border-b border-border px-4 py-3.5 last:border-b-0">
              <dt className="flex flex-wrap items-baseline gap-2">
                <span className="text-[14.5px] font-semibold text-foreground">{g.name}</span>
                <span className="font-mono text-[11.5px] text-muted-foreground">{g.term}</span>
              </dt>
              <dd className="m-0 text-[13.5px] leading-[21px] text-muted-foreground">{g.body}</dd>
            </div>
          ))}
        </dl>
      </Section>

      <Section id="team" title="Claude's team">
        <ul className="m-0 grid list-none gap-2.5 p-0 sm:grid-cols-2">
          {AGENT_IDS.map((id) => (
            <li key={id} className="flex flex-col gap-1 rounded-[14px] border border-border bg-card p-4">
              <span className="flex flex-wrap items-baseline gap-2">
                <span className="text-[14.5px] font-semibold text-foreground">{agentName(id)}</span>
                <span className="font-mono text-[11.5px] text-muted-foreground">{id}</span>
              </span>
              <span className="text-[13px] leading-5 text-muted-foreground">{agentDoes(id)}</span>
            </li>
          ))}
        </ul>
      </Section>

      <Section id="voices" title="Who is speaking">
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {VOICES.map((v) => (
            <li key={v.voice} className="flex items-start gap-3 text-[13.5px] leading-[21px] text-muted-foreground">
              <span className="mt-0.5 w-[132px] shrink-0">
                <VoiceTag voice={v.voice} />
              </span>
              <span>{v.body}</span>
            </li>
          ))}
        </ul>
      </Section>

      <Section id="words" title="Words we use">
        <dl className="m-0 flex flex-col overflow-hidden rounded-[14px] border border-border bg-card">
          {GLOSSARY.map(([plain, term]) => (
            <div key={plain} className="grid gap-0.5 border-b border-border px-4 py-2.5 last:border-b-0 sm:grid-cols-[240px_minmax(0,1fr)] sm:gap-4">
              <dt className="text-[13.5px] font-medium text-foreground">{plain}</dt>
              <dd className="m-0 font-mono text-[12px] leading-5 text-muted-foreground">{term}</dd>
            </div>
          ))}
        </dl>
      </Section>

      <Section id="keys" title="Keyboard shortcuts">
        <p className="m-0 text-[13px] text-muted-foreground">Shortcuts never fire while you type in a field.</p>
        <dl className="m-0 flex flex-col overflow-hidden rounded-[14px] border border-border bg-card">
          {SHORTCUTS.map(([key, what]) => (
            <div key={what} className="flex items-center gap-4 border-b border-border px-4 py-2.5 last:border-b-0">
              <dt className="w-[120px] shrink-0 text-foreground">{key}</dt>
              <dd className="m-0 text-[13.5px] text-foreground">{what}</dd>
            </div>
          ))}
        </dl>
      </Section>
    </div>
  );
}
