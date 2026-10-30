import { isAppError, ScopeViolationError, ValidationError } from '@blackwing/errors';

import { bodyDigest, type ObservedHeader, type ObservedResponse } from './oracle.js';
import { log, markSpanError, tracer, type ReplayMetrics } from './telemetry.js';

import type { ReplaySpec, ReplayStep, RunPins } from '@blackwing/contracts';
import type { Span } from '@opentelemetry/api';

/**
 * The deterministic replay engine (#719). It provisions a fresh sandbox pinned to the spec's image digest,
 * executes the declared steps in fixed order through the egress port, captures evidence and returns a
 * {@link RawObservation}. It never decides pass or fail: {@link dispatch} routes the observation to the
 * evaluator that owns the oracle type (CONTEXT_PACK §3.2 step 9, §8.11).
 */

/** Provisioning attempts before a replay gives up. Bounded so a broken sandbox never loops forever. */
export const MAX_PROVISION_ATTEMPTS = 3;
/** Longest body kept in memory per exchange. The full body goes to evidence (§4.3), never into the result. */
export const MAX_EXCHANGE_BODY_BYTES = 65_536;
/** Most response headers kept per exchange. Extra headers are dropped, never read into memory. */
export const MAX_EXCHANGE_HEADERS = 128;
/** Longest value kept per response header. A longer value is cut, and the cut is never read as a match. */
export const MAX_EXCHANGE_HEADER_VALUE_CHARS = 4_096;

/** A running sandbox. `terminate` must always be called, including when the replay fails. */
export interface Sandbox {
  readonly id: string;
  readonly imageDigest: string;
  readonly terminate: () => Promise<void>;
}

/** Starts a fresh sandbox for one replay. The proxy URL is the egress gateway every byte must pass through. */
export interface SandboxProvider {
  readonly provision: (request: { imageDigest: string; proxyUrl: string }) => Promise<Sandbox>;
}

/**
 * The egress port, the only way the engine reaches a target. Implementations must fail closed: an out-of-scope
 * or non-lab target throws {@link ScopeViolationError} before any traffic. Any other rejection is a transport
 * failure and is recorded as `no_observation`.
 */
export interface Egress {
  readonly request: (request: {
    method: string;
    url: string;
    body: string | null;
  }) => Promise<ObservedResponse>;
  readonly probe: (host: string, port: number) => Promise<void>;
}

/** Step kinds that need a handler from the sandbox side (browser, out-of-band listener, workspace script). */
type HandledStepKind = 'browser_action' | 'oob_check' | 'script';
export type StepHandler = (step: ReplayStep, input: string | null) => Promise<ObservedResponse>;
export type StepHandlers = Partial<Record<HandledStepKind, StepHandler>>;

/** Resolves an `inputsRef` evidence reference to its content (EVIDENCE). */
export interface EvidenceReader {
  readonly read: (ref: string) => Promise<string>;
}

/** Stores one exchange's full body and returns the evidence reference that points at it. */
export interface EvidenceCapture {
  readonly capture: (entry: {
    replayId: string;
    stepIndex: number;
    kind: ReplayStep['kind'];
    status: number | null;
    body: string;
  }) => Promise<string>;
}

/** Whether a state-changing step has a reversal-journal entry (§8.3). Without one the step is denied. */
export interface ReversalJournal {
  readonly hasEntry: (replayId: string, stepIndex: number) => Promise<boolean>;
}

/** Re-verifies the standing authorisation at replay start. Throws when it is not valid at `now`. */
export interface AuthorisationGate {
  readonly assertValid: (now: Date) => void;
}

type ReplayAuditType = 'validation.replay.started' | 'validation.replay.finished';

export interface ReplayAuditEvent {
  readonly type: ReplayAuditType;
  readonly candidateId: string;
  readonly oracleType: string;
  readonly outcome?: ReplayStatus | 'blocked' | 'error';
  readonly replayMs?: number;
}

export interface ReplayAudit {
  readonly record: (event: ReplayAuditEvent) => Promise<void>;
}

export interface ReplayEngineDeps {
  readonly sandboxes: SandboxProvider;
  readonly egress: Egress;
  readonly evidence: EvidenceReader;
  readonly capture: EvidenceCapture;
  readonly journal: ReversalJournal;
  readonly authorisation: AuthorisationGate;
  readonly audit: ReplayAudit;
  readonly egressProxyUrl: string;
  /** Injected clock. The engine reads time only through this, so a replay is reproducible in tests. */
  readonly now: () => Date;
  readonly handlers?: StepHandlers;
  /** Metrics sink for `replay_runs_total` and `replay_duration_ms`. Defaults to recording nothing. */
  readonly metrics?: ReplayMetrics;
}

export interface RunOptions {
  /** The kill switch. Once aborted, no further step starts and the result is `aborted`. */
  readonly signal?: AbortSignal;
}

/**
 * `completed`: every step ran. `no_observation`: a step hit a transport failure, so nothing was observed.
 * `aborted`: the kill switch fired. Both non-`completed` states route to Suspected, never Confirmed.
 */
export type ReplayStatus = 'completed' | 'no_observation' | 'aborted';

/**
 * One executed step. `body` is in memory for the evaluator and is truncated; `bodySha256` and `evidenceRef`
 * prove the full observation. Only the digest and the reference are meant to be persisted.
 */
export interface ReplayExchange {
  readonly stepIndex: number;
  readonly kind: ReplayStep['kind'];
  readonly status: number | null;
  readonly body: string;
  readonly bodySha256: string;
  readonly truncated: boolean;
  readonly evidenceRef: string;
  /** Response headers, present only when the transport reported them. A handler step may report none. */
  readonly headers?: readonly ObservedHeader[];
}

export interface RawObservation {
  readonly replayId: string;
  readonly candidateId: string;
  readonly testCaseId: string;
  readonly oracleType: string;
  readonly status: ReplayStatus;
  readonly exchanges: readonly ReplayExchange[];
  readonly evidenceRefs: readonly string[];
  readonly replayMs: number;
  readonly attempts: number;
  readonly pins: RunPins;
}

/** A step that changes state: any non-read HTTP method, a form submit, or a script. */
const READ_ONLY_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

export function isStateChanging(step: ReplayStep): boolean {
  if (step.kind === 'http_request') return !READ_ONLY_METHODS.has(step.method);
  if (step.kind === 'browser_action') return step.action === 'submit';
  return step.kind === 'script';
}

interface Observed {
  readonly status: number | null;
  readonly body: string;
  readonly headers?: readonly ObservedHeader[];
}

export class ReplayEngine {
  constructor(private readonly deps: ReplayEngineDeps) {}

  /**
   * Replays `spec`. Throws (and never returns a result) when the authorisation is invalid, a state-changing step
   * has no journal entry, the sandbox cannot be provisioned or pinned, a step kind has no handler, or the egress
   * refuses a target. Every thrown error is an `AppError` or a validation failure, so the caller leaves the
   * candidate Suspected.
   */
  async run(spec: ReplaySpec, options: RunOptions = {}): Promise<RawObservation> {
    return tracer.startActiveSpan('validation.replay', async (span) => {
      span.setAttributes({
        candidateId: spec.candidateId,
        oracleType: spec.oracle.type,
        pinsSha: bodyDigest(JSON.stringify(spec.pins)),
      });
      const started = this.deps.now();
      const event = { candidateId: spec.candidateId, oracleType: spec.oracle.type };
      await this.deps.audit.record({ ...event, type: 'validation.replay.started' });
      try {
        const observation = await this.execute(spec, options, started, span);
        await this.deps.audit.record({
          ...event,
          type: 'validation.replay.finished',
          outcome: observation.status,
          replayMs: observation.replayMs,
        });
        this.observeFinished(spec, observation.status, observation.replayMs);
        if (observation.status !== 'completed') {
          log.warn({ ...event, result: observation.status }, 'replay did not complete');
        }
        return observation;
      } catch (error) {
        const outcome = error instanceof ScopeViolationError ? 'blocked' : 'error';
        const replayMs = this.deps.now().getTime() - started.getTime();
        const errorName = error instanceof Error ? error.name : 'unknown';
        markSpanError(span, errorName);
        await this.deps.audit.record({ ...event, type: 'validation.replay.finished', outcome });
        this.observeFinished(spec, outcome, replayMs);
        log.warn({ ...event, result: outcome, errorName }, 'replay refused');
        throw error;
      } finally {
        span.end();
      }
    });
  }

  private observeFinished(
    spec: ReplaySpec,
    result: ReplayStatus | 'blocked' | 'error',
    durationMs: number,
  ): void {
    this.deps.metrics?.runFinished({ oracleType: spec.oracle.type, result }, durationMs);
  }

  private async execute(
    spec: ReplaySpec,
    options: RunOptions,
    started: Date,
    span: Span,
  ): Promise<RawObservation> {
    // Fail closed before any traffic: an expired or invalid authorisation blocks the whole replay.
    this.deps.authorisation.assertValid(started);
    await this.assertJournaled(spec);
    const inputs = await this.resolveInputs(spec);
    const { sandbox, attempts } = await this.provision(spec);
    span.setAttribute('sandboxId', sandbox.id);
    try {
      const run = await this.runSteps(spec, inputs, options);
      return {
        replayId: spec.id,
        candidateId: spec.candidateId,
        testCaseId: spec.testCaseId,
        oracleType: spec.oracle.type,
        status: run.status,
        exchanges: run.exchanges,
        evidenceRefs: run.exchanges.map((exchange) => exchange.evidenceRef),
        replayMs: this.deps.now().getTime() - started.getTime(),
        attempts,
        pins: spec.pins,
      };
    } finally {
      await sandbox.terminate();
    }
  }

  private async assertJournaled(spec: ReplaySpec): Promise<void> {
    for (const [stepIndex, step] of spec.steps.entries()) {
      if (!isStateChanging(step)) continue;
      if (!(await this.deps.journal.hasEntry(spec.id, stepIndex))) {
        throw new ScopeViolationError(
          `step ${stepIndex} changes state and has no reversal-journal entry`,
        );
      }
    }
  }

  private async resolveInputs(spec: ReplaySpec): Promise<ReadonlyMap<string, string>> {
    const inputs = new Map<string, string>();
    for (const ref of spec.inputsRef) {
      inputs.set(ref, await this.deps.evidence.read(ref));
    }
    return inputs;
  }

  /** Provisions a sandbox with the spec's pinned digest, retrying a failed start a bounded number of times. */
  private async provision(spec: ReplaySpec): Promise<{ sandbox: Sandbox; attempts: number }> {
    for (let attempt = 1; ; attempt += 1) {
      let sandbox: Sandbox;
      try {
        sandbox = await this.deps.sandboxes.provision({
          imageDigest: spec.pins.sandboxImageDigest,
          proxyUrl: this.deps.egressProxyUrl,
        });
      } catch (error) {
        if (attempt >= MAX_PROVISION_ATTEMPTS) {
          throw new ValidationError('the sandbox could not be provisioned', { cause: error });
        }
        continue;
      }
      if (sandbox.imageDigest !== spec.pins.sandboxImageDigest) {
        await sandbox.terminate();
        throw new ValidationError('the sandbox image does not match the pinned digest');
      }
      return { sandbox, attempts: attempt };
    }
  }

  private async runSteps(
    spec: ReplaySpec,
    inputs: ReadonlyMap<string, string>,
    options: RunOptions,
  ): Promise<{ status: ReplayStatus; exchanges: ReplayExchange[] }> {
    const exchanges: ReplayExchange[] = [];
    for (const [stepIndex, step] of spec.steps.entries()) {
      if (options.signal?.aborted === true) return { status: 'aborted', exchanges };
      let observed: Observed;
      try {
        observed = await this.performStep(step, inputs);
      } catch (error) {
        // Scope, validation and handler errors are refusals, not observations: they propagate.
        if (isAppError(error)) throw error;
        return { status: 'no_observation', exchanges };
      }
      exchanges.push(await this.record(spec.id, stepIndex, step, observed));
    }
    return { status: 'completed', exchanges };
  }

  private async performStep(
    step: ReplayStep,
    inputs: ReadonlyMap<string, string>,
  ): Promise<Observed> {
    const input =
      'inputRef' in step && step.inputRef !== null ? this.input(step.inputRef, inputs) : null;
    switch (step.kind) {
      case 'http_request': {
        const response = await this.deps.egress.request({
          method: step.method,
          url: step.endpoint.urlTemplate,
          body: input,
        });
        return observedFrom(response);
      }
      case 'tcp_probe':
        await this.deps.egress.probe(step.host, step.port);
        return { status: null, body: '' };
      case 'browser_action':
      case 'oob_check':
      case 'script': {
        const handler = this.deps.handlers?.[step.kind];
        if (handler === undefined) {
          throw new ValidationError(`no handler is registered for the ${step.kind} step`);
        }
        const response = await handler(step, input);
        return observedFrom(response);
      }
    }
  }

  private input(ref: string, inputs: ReadonlyMap<string, string>): string {
    const value = inputs.get(ref);
    if (value === undefined)
      throw new ValidationError('a step names an input that was not resolved');
    return value;
  }

  private async record(
    replayId: string,
    stepIndex: number,
    step: ReplayStep,
    observed: Observed,
  ): Promise<ReplayExchange> {
    const evidenceRef = await this.deps.capture.capture({
      replayId,
      stepIndex,
      kind: step.kind,
      status: observed.status,
      body: observed.body,
    });
    const truncated = Buffer.byteLength(observed.body, 'utf8') > MAX_EXCHANGE_BODY_BYTES;
    return {
      stepIndex,
      kind: step.kind,
      status: observed.status,
      body: truncated
        ? Buffer.from(observed.body, 'utf8').subarray(0, MAX_EXCHANGE_BODY_BYTES).toString('utf8')
        : observed.body,
      bodySha256: bodyDigest(observed.body),
      truncated,
      evidenceRef,
      ...(observed.headers === undefined ? {} : { headers: boundedHeaders(observed.headers) }),
    };
  }
}

/** Keeps the in-memory header list within its bounds. Only the first headers are kept, and long values are cut. */
function boundedHeaders(headers: readonly ObservedHeader[]): ObservedHeader[] {
  return headers.slice(0, MAX_EXCHANGE_HEADERS).map(({ name, value }) => ({
    name,
    value: value.slice(0, MAX_EXCHANGE_HEADER_VALUE_CHARS),
  }));
}

/** Keeps the observed fields of a response, and its headers only when the transport returned them. */
function observedFrom(response: ObservedResponse): Observed {
  return response.headers === undefined
    ? { status: response.status, body: response.body }
    : { status: response.status, body: response.body, headers: response.headers };
}

/**
 * The standing-authorisation gate for a run. The replay is valid only strictly before `expiresAt`. An unparsable
 * expiry fails closed, because `NaN` never compares as valid.
 */
export function createExpiryGate(expiresAt: string): AuthorisationGate {
  const expiry = Date.parse(expiresAt);
  return {
    assertValid(now: Date): void {
      if (!(now.getTime() < expiry)) {
        throw new ScopeViolationError('the standing authorisation is not valid at replay start');
      }
    },
  };
}
