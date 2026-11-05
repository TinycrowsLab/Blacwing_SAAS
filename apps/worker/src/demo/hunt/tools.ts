import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

import { newId } from '@blackwing/ids';

import { modelView, probeSchema, sendRequest } from './http-tool.js';
import { buildEvidence, candidateSchema, fingerprint, reproCurl, validateCandidate } from './validator.js';

import type { HuntContext } from './context.js';

const LIST_LIMIT = 100;
const DEFAULT_LIST_LIMIT = 50;
const PURPOSE_MAX_CHARS = 500;
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

  const submitCandidate = tool(
    'submit_candidate',
    'Submit a suspected vulnerability for deterministic validation. The probe is replayed 3 times and the negative control once; it is confirmed only if every probe replay matches the oracle and the control does not. Oracle types: body_contains, body_regex, status_equals, header_contains ("Header-Name: substring").',
    { ...candidateSchema.shape, agent: z.string().optional() },
    async (args) => {
      const { agent: stamped, ...candidate } = args;
      const agent = stamped ?? DEFAULT_AGENT;
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
      if (verdict.confirmed && verdict.probe !== null && verdict.control !== null) {
        const findingId = newId();
        const evidence = buildEvidence(candidate, verdict.probe, verdict.control, verdict.replays);
        const inserted = await ctx.store.insertFinding(ctx.run, {
          id: findingId,
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
          evidence,
          replay: { replays: verdict.replays, control: { status: verdict.control.status, matched: false } },
          reproCurl: reproCurl(candidate.probe),
        });
        if (inserted) ctx.state.findings += 1;
        if (inserted) await ctx.log.emit('finding.confirmed', 'validator', `Confirmed: ${candidate.title}`, { ...summary, findingId });
        return text({ verdict: 'confirmed', findingId, duplicate: !inserted });
      }
      await ctx.log.emit('finding.not_confirmed', 'validator', `Not confirmed: ${candidate.title} (${verdict.reason})`, summary);
      return text({ verdict: 'not_confirmed', reason: verdict.reason });
    },
  );

  const listExchanges = tool(
    'list_exchanges',
    'List the most recent requests this run has already sent (method, url, status, bytes).',
    { limit: z.number().int().min(1).max(LIST_LIMIT).optional() },
    async (args) => text(await ctx.store.listExchanges(ctx.run.id, args.limit ?? DEFAULT_LIST_LIMIT)),
  );

  return createSdkMcpServer({ name: 'blackwing', tools: [httpRequest, submitCandidate, listExchanges] });
}
