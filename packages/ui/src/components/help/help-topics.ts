/**
 * Just-in-time help topics (CONSOLE help, #819). Copy is short on purpose: the popover shows the summary
 * and links out to the versioned user guide for depth. Never put customer data, identifiers, secrets or
 * example tokens in a summary (CONTEXT_PACK §8.7); `help-topics.test.ts` enforces the shape.
 */
export const HELP_TOPIC_IDS = [
  'intrusiveness',
  'approval-gates',
  'separation-of-duties',
  'confirmed-vs-suspected',
  'coverage',
  'baseline',
  'budgets',
] as const;

/** A help topic id. Also the `topic` label on `help_popover_opened_total`. */
export type HelpTopicId = (typeof HELP_TOPIC_IDS)[number];

/** One help entry: a title, a short summary and where the full explanation lives in the guide. */
export interface HelpTopic {
  readonly title: string;
  readonly summary: string;
  /** Guide page id (the file name under `docs/user`, without extension). */
  readonly page: string;
  /** Anchor on that page (lowercase, hyphenated). */
  readonly anchor: string;
}

/** Every help topic the console shows. Keys match `HELP_TOPIC_IDS`. */
export const HELP_TOPICS: Readonly<Record<HelpTopicId, HelpTopic>> = Object.freeze({
  intrusiveness: {
    title: 'Intrusiveness class',
    summary:
      'Each test case is passive (no crafted traffic), active-safe (crafted requests that should not change state) or state-changing (reversible changes that need explicit approval). Destructive tests are blocked by platform policy.',
    page: 'user-guide',
    anchor: 'intrusiveness-classes',
  },
  'approval-gates': {
    title: 'Approval gates',
    summary:
      'Gate 1 approves the test plan before any traffic. Gate 2 decides a runtime exception when an action falls outside the approved envelope. No answer before the timeout means denied. Gate 3 releases confirmed findings.',
    page: 'user-guide',
    anchor: 'approval-gates',
  },
  'separation-of-duties': {
    title: 'Separation of duties',
    summary:
      'The person who requests an authorisation, a test plan or an exception can never approve it. Every approval is recorded in the audit ledger.',
    page: 'user-guide',
    anchor: 'separation-of-duties',
  },
  'confirmed-vs-suspected': {
    title: 'Confirmed vs suspected',
    summary:
      'A confirmed finding was reproduced by the deterministic validator against its declared oracle, with negative controls. A suspected finding failed validation and waits in the analyst queue until it is re-validated.',
    page: 'user-guide',
    anchor: 'confirmed-vs-suspected',
  },
  coverage: {
    title: 'Coverage',
    summary:
      'Coverage shows which planned test cases actually ran. Reports and exports include it, so a finding is marked fixed only when the test that found it was executed again.',
    page: 'user-guide',
    anchor: 'coverage',
  },
  baseline: {
    title: 'Baseline states',
    summary:
      'Compared with the asset baseline, a finding is new, open, fixed, returned or not retested. A finding counts as fixed only when its test is in the coverage manifest.',
    page: 'user-guide',
    anchor: 'baseline-states',
  },
  budgets: {
    title: 'Budgets and cost cap',
    summary:
      'Each test case has a request budget, and each run has a cost cap. When either limit is reached the run pauses instead of continuing, and you decide whether to resume.',
    page: 'user-guide',
    anchor: 'budgets-and-cost-cap',
  },
});

/** Type guard for a help topic id. */
export function isHelpTopicId(value: unknown): value is HelpTopicId {
  return typeof value === 'string' && (HELP_TOPIC_IDS as readonly string[]).includes(value);
}
