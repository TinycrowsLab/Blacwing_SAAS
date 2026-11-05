// Plain-language names of Claude's agents (glossary, experience spec §1). The one map the console uses: the mono id is
// shown second. An unknown id shows as itself.

interface AgentInfo {
  readonly name: string;
  readonly initials: string;
  /** One line for Help and tooltips. */
  readonly does: string;
}

const AGENTS: Readonly<Record<string, AgentInfo>> = {
  orchestrator: { name: 'Planner', initials: 'PL', does: 'Reads your plan, hands work to the specialists and sums up.' },
  recon: { name: 'Recon', initials: 'RE', does: 'Maps the site: pages, scripts, API routes and headers.' },
  'web-api-specialist': {
    name: 'Web & API specialist',
    initials: 'WA',
    does: 'Tests for injection, cross-site scripting, exposed files and misconfiguration.',
  },
  'authz-specialist': {
    name: 'Access control specialist',
    initials: 'AC',
    does: 'Tests who can see or change whose data, and sign-in weaknesses.',
  },
  validator: {
    name: 'Validator',
    initials: 'VA',
    does: 'Replays each suspected issue with a control. Code, not a model: only it can prove an issue.',
  },
  'general-purpose': { name: 'General helper', initials: 'GH', does: 'A helper the planner started for a side task.' },
};

/** The ids in display order (for Help and legends). */
export const AGENT_IDS: readonly string[] = Object.keys(AGENTS);

export const agentName = (id: string): string => AGENTS[id]?.name ?? id;

export const agentInitials = (id: string): string =>
  AGENTS[id]?.initials ?? (id.replace(/[^a-z0-9]/gi, '').slice(0, 2).toUpperCase() || '?');

export const agentDoes = (id: string): string | null => AGENTS[id]?.does ?? null;
