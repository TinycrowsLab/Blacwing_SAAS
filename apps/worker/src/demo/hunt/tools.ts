import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

import { newId } from '@blackwing/ids';

import { modelView, probeSchema, sendRequest } from './http-tool.js';
import { SUBAGENT_NAMES } from './prompts.js';
import { buildEvidence, candidateSchema, fingerprint, reproCurl, sideEvidence, validateCandidate } from './validator.js';
import { deliverRelease } from './webhook.js';

import type { HuntContext } from './context.js';

const LIST_LIMIT = 100;
const DEFAULT_LIST_LIMIT = 50;
const PURPOSE_MAX_CHARS = 500;
const MAX_CASES_PER_CALL = 60;
const CASE_TITLE_MAX_CHARS = 200;
const CASE_TARGET_MAX_CHARS = 300;
const CASE_NOTE_MAX_CHARS = 300;
/** Stamped by the PreToolUse hook from the calling subagent; never trusted from the model. */
const DEFAULT_AGENT = 'unknown';

function text(value: unknown) {
  return { content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value) }] };
}

export function createHuntServer(ctx: HuntContext) {
  const httpRequest = tool(
    'http_request',
    'Send one HTTP request to the authorised target. Scope, method class, budget and human gates are enforced for you; refusals are returned as text. Redirects are not followed. The body is cut at 8 KB.',
    { ...probeSchema.shape, purpose: z.string().max(PURPOSE_MAX_CHARS).describe('Why this request, in one sentence'), agent: z.string().optional() },
    async (args) => {
      const { purpose, agent, ...request } = args;
      const result = await sendRequest(ctx, agent ?? DEFAULT_AGENT, request, { purpose, askGate2: true });
      return text(result.ok ? modelView(result) : result.refusal);
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
      for (const c of args.cases) if (!ctx.state.cases.has(c.id)) ctx.state.cases.set(c.id, 'proposed');
      const total = ctx.state.cases.size;
      const by = args.agent ?? DEFAULT_AGENT;
      await ctx.log.emit('plan.cases', 'plan', `${by} recorded ${args.cases.length} test cases (${total} in plan)`, { agent: by, cases: args.cases, total });
      return text({ recorded: args.cases.length, total });
    },
  );

  const updateTestCase = tool(
    'update_test_case',
    'Update the status of a recorded test case when you start it (executing) or skip it.',
    {
      id: z.string(),
      status: z.enum(['executing', 'executed', 'skipped', 'blocked']),
      note: z.string().max(CASE_NOTE_MAX_CHARS).optional(),
      agent: z.string().optional(),
    },
    async (args) => {
      if (!ctx.state.cases.has(args.id)) return text(`Unknown test case id ${args.id}. Record it first.`);
      ctx.state.cases.set(args.id, args.status);
      await ctx.log.emit('case.status', 'plan', `Test case ${args.id}: ${args.status}`, {
        caseId: args.id,
        status: args.status,
        agent: args.agent ?? DEFAULT_AGENT,
        by: 'model',
        ...(args.note === undefined ? {} : { note: args.note }),
      });
      return text({ ok: true });
    },
  );

  const submitCandidate = tool(
    'submit_candidate',
    'Submit a suspected vulnerability for deterministic validation. The probe is replayed 3 times and the negative control once; it is confirmed only if every probe replay matches the oracle and the control does not. Oracle types: body_contains, body_regex, status_equals, header_contains ("Header-Name: substring"). Pass case_id when the candidate belongs to a recorded test case.',
    { ...candidateSchema.shape, case_id: z.string().optional(), agent: z.string().optional() },
    async (args) => {
      const { agent: stamped, case_id: caseId, ...candidate } = args;
      const agent = stamped ?? DEFAULT_AGENT;
      const testCaseId = caseId !== undefined && ctx.state.cases.has(caseId) ? caseId : null;
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
      const row = {
        fingerprint: fingerprint(ctx.run.id, candidate),
        agent,
        title: candidate.title,
        vulnClass: candidate.vulnClass,
        cwe: candidate.cwe,
        owasp: candidate.owasp,
        severity: candidate.severity,
        description: candidate.description,
        location: { method: candidate.probe.method.toUpperCase(), url: candidate.probe.url },
        oracle: candidate.oracle,
        reproCurl: reproCurl(candidate.probe, credentialHeader),
        testCaseId,
      };
      const finish = async (): Promise<void> => {
        if (testCaseId === null) return;
        ctx.state.cases.set(testCaseId, 'executed');
        await ctx.log.emit('case.status', 'plan', `Test case ${testCaseId}: executed`, { caseId: testCaseId, status: 'executed', agent: 'validator', by: 'validator' });
      };
      if (verdict.confirmed && verdict.probe !== null && verdict.control !== null) {
        const evidence = buildEvidence(candidate, verdict.probe, verdict.control, verdict.replays);
        const findingId = await ctx.store.insertFinding(ctx.run, {
          ...row,
          id: newId(),
          status: 'released',
          evidence,
          replay: { replays: verdict.replays, control: { status: verdict.control.status, matched: false } },
        });
        if (findingId !== null) {
          ctx.state.findings += 1;
          await ctx.log.emit('finding.confirmed', 'validator', `Confirmed: ${candidate.title}`, { ...summary, findingId });
          await ctx.log.emit('finding.released', 'validator', `Released automatically: ${candidate.title} (proven by deterministic replay)`, { ...summary, findingId, auto: true });
          await deliverRelease(ctx, { id: findingId, title: candidate.title, severity: candidate.severity, cwe: candidate.cwe, owasp: candidate.owasp, reproCurl: row.reproCurl });
        }
        await finish();
        return text({ verdict: 'confirmed', findingId, released: true, duplicate: findingId === null });
      }
      const findingId = await ctx.store.insertFinding(ctx.run, {
        ...row,
        id: newId(),
        status: 'suspected',
        evidence: {
          reason: verdict.reason,
          replays: verdict.replays,
          oracle: candidate.oracle,
          ...(verdict.probe === null ? {} : { probe: sideEvidence(candidate.probe, verdict.probe) }),
        },
        replay: { replays: verdict.replays, control: verdict.control === null ? null : { status: verdict.control.status, matched: verdict.controlMatched } },
      });
      await ctx.log.emit('finding.suspected', 'validator', `Suspected: ${candidate.title} (${verdict.reason})`, { ...summary, findingId, reason: verdict.reason });
      await finish();
      return text({ verdict: 'suspected', reason: verdict.reason });
    },
  );

  const listExchanges = tool(
    'list_exchanges',
    'List the most recent requests this run has already sent (method, url, status, bytes).',
    { limit: z.number().int().min(1).max(LIST_LIMIT).optional() },
    async (args) => text(await ctx.store.listExchanges(ctx.run.id, args.limit ?? DEFAULT_LIST_LIMIT)),
  );

  return createSdkMcpServer({ name: 'blackwing', tools: [httpRequest, recordTestCases, updateTestCase, submitCandidate, listExchanges] });
}
