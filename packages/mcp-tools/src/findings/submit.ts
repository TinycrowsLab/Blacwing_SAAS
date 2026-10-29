import { createHash } from 'node:crypto';

import { SpanStatusCode, trace } from '@opentelemetry/api';
import { z } from 'zod';

import {
  cweIdSchema,
  findingLocationSchema,
  LIMITS,
  oracleSchema,
  uuidV7Schema,
} from '@blackwing/contracts';
import { redactBuiltinSecrets } from '@blackwing/errors';

import { submitCandidateOutputSchema, type SubmitCandidateInput } from './submit-candidate.js';

import type { ToolDefinition, ToolRuntime } from '../tool.js';
import type { CandidateMetrics } from './metrics.js';

/**
 * The shared candidate path of every web and API detection module (WEBAPI-002, REFERENCES §7). It refuses a
 * candidate without a pre-declared oracle, a negative control or a positive that fired and a clean control.
 * It pulls the gateway's captured HAR and raw request and response for each exchange, verifies the gateway's
 * digests, redacts secrets (§8.7), stores the evidence with a sha256 per object (§8.8), and only then calls
 * `submit_candidate`. Nothing is enqueued unless every step above succeeded (fail closed).
 */

const EXCHANGE_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const ROLE = /^[a-z][a-z0-9_-]{0,63}$/;
const CAPTURES_MAX = 20;
const STANDARD_REFS_MAX = 20;
const SHA256_HEX = /^[0-9a-f]{64}$/;
/** The evidence id shape the output limiter accepts (`limitOutput` in `truncate.ts`). */
const EVIDENCE_ID = /^[A-Za-z0-9._-]{1,128}$/;

export const WEB_API_CAPTURE_KINDS = ['har', 'request', 'response'] as const;
export type WebApiCaptureKind = (typeof WEB_API_CAPTURE_KINDS)[number];

/** A candidate as the detection module assembles it. The model never supplies the oracle or the control. */
export const webApiCandidateSchema = z.strictObject({
  testCaseId: uuidV7Schema,
  class: z.string().min(1).max(LIMITS.shortTextMax),
  wstgRefs: z.array(z.string().min(1).max(LIMITS.keyMax)).min(1).max(STANDARD_REFS_MAX),
  cweId: cweIdSchema,
  owaspCategory: z.string().min(1).max(LIMITS.shortTextMax),
  location: findingLocationSchema.refine(
    (location) => location.urlTemplate !== null || location.file !== null,
    'a location needs a URL template or a file',
  ),
  role: z.string().regex(ROLE, 'must be a lowercase role key'),
  /** The oracle declared before the test ran; `null` when none was declared. */
  declaredOracle: oracleSchema.nullable(),
  /** The negative control declared before the test ran; `null` when none was declared. */
  negativeControlRef: z.string().min(1).max(LIMITS.keyMax).nullable(),
  positiveFired: z.boolean(),
  negativeControlFired: z.boolean(),
  captures: z
    .array(z.strictObject({ exchangeId: z.string().regex(EXCHANGE_ID, 'must be an exchange id') }))
    .min(1)
    .max(CAPTURES_MAX),
  confidence: z.number().min(0).max(1),
  summary: z.string().min(1),
});
export type WebApiCandidate = z.infer<typeof webApiCandidateSchema>;

/** One object the gateway captured, with the digest the gateway computed over its raw bytes. */
export interface GatewayPart {
  readonly content: string;
  readonly sha256: string;
}

/** What the egress gateway captured for one exchange (HAR plus raw request and response). */
export interface GatewayCapture {
  readonly exchangeId: string;
  readonly har: GatewayPart;
  readonly request: GatewayPart;
  readonly response: GatewayPart;
}

/** Reads a capture from the gateway. `null` means the gateway has no capture for the exchange. */
export interface CaptureSource {
  fetch(exchangeId: string, signal: AbortSignal): Promise<GatewayCapture | null>;
}

/** Why a candidate was not submitted (`mcp_candidate_rejections_total{reason}`). */
export type WebApiRejection =
  | 'invalid_candidate'
  | 'missing_oracle'
  | 'missing_negative_control'
  | 'positive_not_fired'
  | 'negative_control_fired'
  | 'evidence_capture_failed'
  | 'killed'
  | 'submit_rejected';

export interface StoredEvidence {
  /** Evidence id returned by the sink; referenced by the candidate. */
  readonly id: string;
  readonly kind: WebApiCaptureKind;
  readonly exchangeId: string;
  /** sha256 of the redacted bytes that were stored. */
  readonly sha256: string;
}

export type WebApiSubmitResult =
  | { readonly ok: true; readonly findingId: string; readonly evidence: readonly StoredEvidence[] }
  | { readonly ok: false; readonly reason: WebApiRejection; readonly message: string };

export interface WebApiSubmitDeps {
  readonly runtime: ToolRuntime;
  /** `submit_candidate`, already bound to this test case (its oracle and control checks run there too). */
  readonly submitTool: ToolDefinition;
  readonly captures: CaptureSource;
  readonly metrics: CandidateMetrics;
}

const tracer = trace.getTracer('blackwing.mcp-tools');

const sha256Hex = (content: string): string =>
  createHash('sha256').update(content, 'utf8').digest('hex');

/** Redacts known secret values from text before it is stored or submitted (§8.7). */
function redactor(runtime: ToolRuntime): (text: string) => string {
  return (text) => (runtime.redact ?? ((value: string) => value))(redactBuiltinSecrets(text));
}

/** Reads one capture; a gateway error is a missing capture, never a partial one. */
async function fetchCapture(
  source: CaptureSource,
  exchangeId: string,
  signal: AbortSignal,
): Promise<GatewayCapture | null> {
  try {
    return await source.fetch(exchangeId, signal);
  } catch {
    return null;
  }
}

/** The gateway's digest must match the bytes it sent; a mismatch means the capture cannot be trusted. */
function digestMatches(part: GatewayPart): boolean {
  return SHA256_HEX.test(part.sha256) && sha256Hex(part.content) === part.sha256;
}

/** A tool envelope from `submit_candidate`: `{ ok: true, data }` or `{ ok: false, code, message }`. */
const toolEnvelopeSchema = z.union([
  z.strictObject({ ok: z.literal(true), data: submitCandidateOutputSchema }),
  z.strictObject({ ok: z.literal(false), code: z.string(), message: z.string() }),
]);

/** The JSON text of a tool result; anything unparsable yields `null`, which fails the envelope check. */
function parseEnvelope(result: { readonly content: readonly unknown[] }): unknown {
  const first = result.content[0];
  if (typeof first !== 'object' || first === null || !('text' in first)) return null;
  try {
    return JSON.parse(String(first.text));
  } catch {
    return null;
  }
}

/**
 * Captures, redacts and stores the evidence for `captures`, then submits the candidate. Returns the outcome; it
 * never throws for a rejected candidate. Every path that does not submit leaves no candidate behind.
 */
export async function submitWebApiCandidate(
  raw: unknown,
  deps: WebApiSubmitDeps,
): Promise<WebApiSubmitResult> {
  const { runtime, submitTool, captures, metrics } = deps;
  const span = tracer.startSpan('webapi.submit');
  const reject = (reason: WebApiRejection, message: string): WebApiSubmitResult => {
    metrics.rejections.inc({ reason });
    span.setStatus({ code: SpanStatusCode.ERROR, message: reason });
    return { ok: false, reason, message };
  };
  // A function, not a narrowed property: TypeScript would keep `aborted` as false across the awaits below.
  const killed = (): boolean => runtime.signal.aborted;
  try {
    if (killed()) return reject('killed', 'the run was killed');

    const parsed = webApiCandidateSchema.safeParse(raw);
    if (!parsed.success) {
      const fields = parsed.error.issues.map((issue) => issue.path.join('.') || '(input)');
      return reject('invalid_candidate', `Invalid candidate: ${[...new Set(fields)].join(', ')}`);
    }
    const candidate = parsed.data;
    if (candidate.declaredOracle === null) {
      return reject('missing_oracle', 'no oracle was declared before the test ran');
    }
    if (candidate.negativeControlRef === null) {
      return reject('missing_negative_control', 'no negative control was declared before the test');
    }
    if (!candidate.positiveFired) {
      return reject('positive_not_fired', 'the declared oracle did not fire');
    }
    if (candidate.negativeControlFired) {
      return reject(
        'negative_control_fired',
        'the negative control fired: likely a false positive',
      );
    }

    const redact = redactor(runtime);
    const stored: StoredEvidence[] = [];
    for (const { exchangeId } of candidate.captures) {
      const capture = await fetchCapture(captures, exchangeId, runtime.signal);
      if (capture?.exchangeId !== exchangeId) {
        return reject('evidence_capture_failed', 'the gateway capture is missing');
      }
      for (const kind of WEB_API_CAPTURE_KINDS) {
        const part = capture[kind];
        if (!digestMatches(part)) {
          return reject('evidence_capture_failed', 'the gateway capture digest does not match');
        }
        const content = redact(part.content);
        const id = await runtime.evidence.store({
          content,
          contentType: kind === 'har' ? 'application/json' : 'text/plain',
          description: `${kind} capture of ${exchangeId} for role ${candidate.role}`,
        });
        if (!EVIDENCE_ID.test(id)) {
          return reject('evidence_capture_failed', 'the evidence store returned an invalid id');
        }
        stored.push({ id, kind, exchangeId, sha256: sha256Hex(content) });
      }
    }

    // A kill that lands during capture stops the candidate before anything is enqueued.
    if (killed()) return reject('killed', 'the run was killed');

    const submission: SubmitCandidateInput = {
      testCaseId: candidate.testCaseId,
      class: candidate.class,
      wstgRefs: candidate.wstgRefs,
      cweId: candidate.cweId,
      owaspCategory: candidate.owaspCategory,
      location: candidate.location,
      oracleBinding: candidate.declaredOracle,
      negativeControlRef: candidate.negativeControlRef,
      evidenceRefs: stored.map((item) => item.id),
      confidence: candidate.confidence,
      summary: redact(candidate.summary),
    };
    const result = await submitTool.invoke(submission, runtime);
    const envelope = toolEnvelopeSchema.safeParse(parseEnvelope(result));
    if (!envelope.success) return reject('submit_rejected', 'the submission answer was invalid');
    const body = envelope.data;
    if (!body.ok) {
      if (body.code === 'TOOL_KILLED') return reject('killed', 'the run was killed');
      return reject('submit_rejected', body.message);
    }
    return { ok: true, findingId: body.data.findingId, evidence: stored };
  } catch (error) {
    span.setStatus({ code: SpanStatusCode.ERROR });
    throw error;
  } finally {
    span.end();
  }
}
