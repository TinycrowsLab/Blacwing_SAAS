import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

import { newId } from '@blackwing/ids';

import { caseOutcome, type HuntContext } from './context.js';
import { awaitDecision, modelView, probeSchema, sendRequest, takeNotices } from './http-tool.js';
import { SUBAGENT_NAMES } from './prompts.js';
import { attachProofScreenshots } from './screenshot.js';
import { buildFindingRow, candidateSchema, validateCandidate } from './validator.js';
import { deliverRelease } from './webhook.js';

import type { FindingRow } from './types.js';

const LIST_LIMIT = 100;
const DEFAULT_LIST_LIMIT = 50;
const PURPOSE_MAX_CHARS = 500;
const MAX_CASES_PER_CALL = 60;
const CASE_TITLE_MAX_CHARS = 200;
const CASE_TARGET_MAX_CHARS = 300;
const CASE_NOTE_MAX_CHARS = 300;
const MAX_AWAIT_S = 60;
const DEFAULT_AWAIT_S = 30;
const MS_PER_S = 1000;
/** Stamped by the PreToolUse hook from the calling subagent; never trusted from the model. */
const DEFAULT_AGENT = 'unknown';

function text(value: unknown, notices: readonly string[] = []) {
  const body = typeof value === 'string' ? value : JSON.stringify(value);
  // Gate 2 outcomes reach the asking agent at the top of its next tool result (non-blocking Gate 2).
  return { content: [{ type: 'text' as const, text: notices.length === 0 ? body : `notices: ${JSON.stringify(notices)}\n${body}` }] };
}

/**
 * Stores a validator-proven finding. `auto` (the plan's choice) releases it at once and delivers the webhook; `hold`
 * keeps it `confirmed` for a human release at Gate 3, which delivers the webhook then (API triage).
 * Returns the finding id, or null for a duplicate.
 */
export async function recordProven(ctx: HuntContext, row: Omit<FindingRow, 'status'>, summary: Record<string, unknown>): Promise<string | null> {
  const auto = ctx.run.releaseProven === 'auto';
  const findingId = await ctx.store.insertFinding(ctx.run, { ...row, status: auto ? 'released' : 'confirmed' });
  if (findingId === null) return null;
  ctx.state.findings += 1;
  // One issue waits at Gate 3 once: earlier audits' unreleased copies of it give way to this newer proof.
  if (row.identityKey !== null) await ctx.store.supersedeCopies(ctx.run, findingId, row.identityKey);
  await ctx.log.emit('finding.confirmed', 'validator', `Confirmed: ${row.title}`, { ...summary, findingId });
  if (!auto) return findingId;
  await ctx.log.emit('finding.released', 'validator', `Released automatically: ${row.title} (proven by deterministic replay)`, { ...summary, findingId, auto: true });
  await deliverRelease(ctx, { id: findingId, title: row.title, severity: row.severity, cwe: row.cwe, owasp: row.owasp, reproCurl: row.reproCurl });
  return findingId;
}

/** The Blackwing tools of one run (exported for tests; the run uses createHuntServer). */
export function huntTools(ctx: HuntContext) {
  const httpRequest = tool(
    'http_request',
    'Send one HTTP request to the authorised target. Scope, method class, budget and human gates are enforced for you; refusals are returned as text. A request that needs Gate 2 is not sent: you get its Gate 2 id at once and carry on; the decision arrives later as a notice. Redirects are not followed. The body is cut at 8 KB.',
    {
      ...probeSchema.shape,
      purpose: z.string().max(PURPOSE_MAX_CHARS).describe('Why this request, in one sentence'),
      case_id: z.string().optional().describe('The recorded test case this request belongs to; always pass it once test cases exist'),
      agent: z.string().optional(),
    },
    async (args) => {
      const { purpose, agent: stamped, case_id: caseId, ...request } = args;
      const agent = stamped ?? DEFAULT_AGENT;
      const known = caseId !== undefined && ctx.state.cases.has(caseId) ? caseId : undefined;
      const result = await sendRequest(ctx, agent, request, { purpose, askGate2: true, caseId: known });
      return text(result.ok ? modelView(result) : result.refusal, takeNotices(ctx, agent));
    },
  );

  const recordTestCases = tool(
    'record_test_cases',
    'Record the test plan after recon: one entry per concrete test. Call again to add cases.',
    {
      cases: z
        .array(
          z.object({
            id: z.string().regex(/^[a-z0-9-]{1,40}$/),
            title: z.string().min(1).max(CASE_TITLE_MAX_CHARS),
            agent: z.enum(SUBAGENT_NAMES),
            target: z.string().max(CASE_TARGET_MAX_CHARS),
          }),
        )
        .min(1)
        .max(MAX_CASES_PER_CALL),
      agent: z.string().optional(),
    },
    async (args) => {
      for (const c of args.cases) {
        if (!ctx.state.cases.has(c.id)) ctx.state.cases.set(c.id, { title: c.title, agent: c.agent, target: c.target, status: 'proposed', note: null, requests: 0, candidates: 0 });
      }
      const total = ctx.state.cases.size;
      const by = args.agent ?? DEFAULT_AGENT;
      await ctx.log.emit('plan.cases', 'plan', `${by} recorded ${args.cases.length} test cases (${total} in plan)`, { agent: by, cases: args.cases, total });
      return text({ recorded: args.cases.length, total }, takeNotices(ctx, by));
    },
  );

  const updateTestCase = tool(
    'update_test_case',
    'Update the status of a recorded test case when you start it (executing) or skip it. Use model_declined when you decide not to run a case yourself, and say why in note.',
    {
      id: z.string(),
      status: z.enum(['executing', 'executed', 'skipped', 'blocked', 'model_declined']),
      note: z.string().max(CASE_NOTE_MAX_CHARS).optional(),
      agent: z.string().optional(),
    },
    async (args) => {
      const agent = args.agent ?? DEFAULT_AGENT;
      const testCase = ctx.state.cases.get(args.id);
      if (testCase === undefined) return text(`Unknown test case id ${args.id}. Record it first.`, takeNotices(ctx, agent));
      testCase.status = args.status;
      if (args.note !== undefined) testCase.note = args.note;
      await ctx.log.emit('case.status', 'plan', `Test case ${args.id}: ${args.status}`, {
        caseId: args.id,
        status: args.status,
        agent,
        by: 'model',
        ...(args.note === undefined ? {} : { note: args.note }),
      });
      return text({ ok: true }, takeNotices(ctx, agent));
    },
  );

  const submitCandidate = tool(
    'submit_candidate',
    'Submit a suspected vulnerability for deterministic validation. The probe is replayed 3 times and the negative control once; it is confirmed only if every probe replay matches the oracle and the control does not. Oracle types: body_contains, body_regex, status_equals, header_contains ("Header-Name: substring"). case_id is required once test cases are recorded.',
    { ...candidateSchema.shape, case_id: z.string().optional(), agent: z.string().optional() },
    async (args) => {
      const { agent: stamped, case_id: caseId, ...candidate } = args;
      const agent = stamped ?? DEFAULT_AGENT;
      const notices = takeNotices(ctx, agent);
      const testCaseId = caseId !== undefined && ctx.state.cases.has(caseId) ? caseId : null;
      // Runner-owned coverage: once a plan exists, every candidate must name its case (no validation is spent otherwise).
      if (testCaseId === null && ctx.state.cases.size > 0) {
        return text(`case_id is required and must be one of the recorded test cases (${[...ctx.state.cases.keys()].join(', ')}). Nothing was sent; submit again with case_id.`, notices);
      }
      const testCase = testCaseId === null ? undefined : ctx.state.cases.get(testCaseId);
      if (testCase !== undefined) testCase.candidates += 1;
      const candidateId = newId();
      await ctx.log.emit('candidate.submitted', 'validator', `${agent} submitted candidate: ${candidate.title}`, {
        agent,
        candidateId,
        title: candidate.title,
        severity: candidate.severity,
      });
      const verdict = await validateCandidate(candidate, {
        send: (request) => sendRequest(ctx, 'validator', request, { purpose: `validate ${candidate.title}`, askGate2: false }),
        replay: (n, status, matched) => ctx.log.emit('validator.replay', 'validator', `Replay ${n}: status ${status}, oracle ${matched ? 'matched' : 'did not match'}`, { candidateId, n, status, matched }),
        control: (status, matched) => ctx.log.emit('validator.control', 'validator', `Negative control: status ${status}, oracle ${matched ? 'matched' : 'did not match'}`, { candidateId, status, matched }),
      });
      const summary = { candidateId, title: candidate.title, severity: candidate.severity };
      const credentialHeader = ctx.run.testAccounts.find((a) => a.role.toLowerCase() === candidate.probe.as_role?.toLowerCase())?.headerName;
      const { proven, row } = buildFindingRow({ run: ctx.run, candidate, verdict, agent, testCaseId, credentialHeader });
      const finish = async (): Promise<void> => {
        if (testCaseId === null || testCase === undefined) return;
        testCase.status = 'executed';
        await ctx.log.emit('case.status', 'plan', `Test case ${testCaseId}: executed`, { caseId: testCaseId, status: 'executed', agent: 'validator', by: 'validator' });
      };
      if (proven) {
        const findingId = await recordProven(ctx, { ...row, id: newId() }, summary);
        if (findingId !== null) await attachProofScreenshots(ctx, findingId, candidate, verdict);
        if (findingId === null) {
          // A copy of an issue already stored: still one outcome event for this candidate.
          const existing = await ctx.store.findingByFingerprint(ctx.run, row.fingerprint);
          const title = existing?.title ?? candidate.title;
          await ctx.log.emit('candidate.merged', 'validator', `Merged into: ${title}`, { candidateId, findingId: existing?.id ?? null, title });
        }
        await finish();
        return text({ verdict: 'confirmed', findingId, released: ctx.run.releaseProven === 'auto', duplicate: findingId === null }, notices);
      }
      const findingId = await ctx.store.insertFinding(ctx.run, { ...row, id: newId(), status: 'suspected' });
      await ctx.log.emit('finding.suspected', 'validator', `Suspected: ${candidate.title} (${verdict.reason})`, { ...summary, findingId, reason: verdict.reason });
      await finish();
      return text({ verdict: 'suspected', reason: verdict.reason }, notices);
    },
  );

  const listExchanges = tool(
    'list_exchanges',
    'List the most recent requests this run has already sent (method, url, status, bytes).',
    { limit: z.number().int().min(1).max(LIST_LIMIT).optional(), agent: z.string().optional() },
    async (args) => text(await ctx.store.listExchanges(ctx.run.id, args.limit ?? DEFAULT_LIST_LIMIT), takeNotices(ctx, args.agent ?? DEFAULT_AGENT)),
  );

  const awaitDecisionTool = tool(
    'await_decision',
    'Wait for a human to decide one of your pending Gate 2 asks. Use it only when nothing else is left to test. Returns the status: approved (send the request again now), denied or expired (do not ask again), or pending (still waiting).',
    {
      gate2Id: z.string(),
      max_seconds: z.number().int().min(1).max(MAX_AWAIT_S).optional().describe(`How long to wait, 1 to ${MAX_AWAIT_S} seconds (default ${DEFAULT_AWAIT_S})`),
      agent: z.string().optional(),
    },
    async (args) => {
      const agent = args.agent ?? DEFAULT_AGENT;
      // A wait while this agent still has cases to run stalls the whole run: refuse it and name them.
      const waitingFor = ctx.state.asks.get(args.gate2Id)?.caseId ?? null;
      const open = [...ctx.state.cases].filter(([id, c]) => c.agent === agent && id !== waitingFor && caseOutcome(c) === 'not_run').map(([id]) => id);
      if (open.length > 0) {
        return text(`Not waiting: you still have test cases to run (${open.join(', ')}). Run them first; the decision arrives as a notice. Call await_decision only when nothing else is left.`, takeNotices(ctx, agent, args.gate2Id));
      }
      const status = await awaitDecision(ctx, args.gate2Id, (args.max_seconds ?? DEFAULT_AWAIT_S) * MS_PER_S);
      const notices = takeNotices(ctx, agent, args.gate2Id);
      if (status === 'unknown') return text(`Unknown Gate 2 id ${args.gate2Id}.`, notices);
      if (status === 'halted') return text('The run was halted.', notices);
      return text({ gate2Id: args.gate2Id, status }, notices);
    },
  );

  return [httpRequest, recordTestCases, updateTestCase, submitCandidate, listExchanges, awaitDecisionTool];
}

export function createHuntServer(ctx: HuntContext) {
  return createSdkMcpServer({ name: 'blackwing', tools: huntTools(ctx) });
}
