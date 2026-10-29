// DEMO-STORY deterministic replay runner. It executes one pinned test case (issue #881) against the lab target:
// a benign detection probe, two replays of it and a negative control. The oracle is a plain string match on the
// error signature in the response body (a deterministic oracle, not a model judgement). Nothing is extracted.
// Every request is checked against the run's scope first and counted against the run's request budget.
import { createHash } from 'node:crypto';

/** The part of the run pins the runner needs (written by the API when the run starts). */
export interface ReplayPins {
  readonly asset: { readonly id: string; readonly baseUrl: string; readonly name: string };
  readonly scope: { readonly method: string; readonly host: string; readonly pathPrefix: string; readonly parameter: string };
  readonly testCase: {
    readonly id: string;
    readonly title: string;
    readonly cwe: string;
    readonly owasp: string;
    readonly wstg: string;
    readonly probe: { readonly value: string; readonly label: string };
    readonly negativeControl: { readonly value: string; readonly label: string };
    readonly oracle: { readonly id: string; readonly type: string; readonly params: { readonly signature: string } };
    readonly replayCount: number;
  };
}

export interface ObservedResponse {
  readonly status: number;
  readonly contentType: string;
  readonly body: string;
}

export interface RunDeps {
  /** Performs one HTTP GET. Injected so the unit tests need no network. */
  readonly fetch: (url: string) => Promise<ObservedResponse>;
  readonly sleep: (ms: number) => Promise<void>;
  readonly stageDelayMs: number;
  readonly budgetRequests: number;
  readonly emit: (event: StageEvent) => Promise<void>;
}

export interface StageEvent {
  readonly kind: string;
  readonly stage: string;
  readonly message: string;
  readonly data: Record<string, unknown>;
}

export interface ProbeRecord {
  readonly url: string;
  readonly value: string;
  readonly response: { readonly status: number; readonly contentType: string; readonly bytes: number; readonly bodySha256: string; readonly bodyExcerpt: string };
  readonly matched: boolean;
}

export interface ReplayOutcome {
  readonly confirmed: boolean;
  readonly requestsUsed: number;
  readonly probe: ProbeRecord;
  readonly replays: readonly ({ readonly n: number } & ProbeRecord)[];
  readonly negativeControl: ProbeRecord;
  readonly fingerprint: string;
  readonly reproCurl: string;
}

export class ScopeRefusal extends Error {
  override readonly name = 'ScopeRefusal';
}

export class BudgetExhausted extends Error {
  override readonly name = 'BudgetExhausted';
}

const EXCERPT_CHARS = 400;

/** Deterministic oracle: the signature appears in the body of a 4xx/5xx or 2xx response alike. */
export function errorSignatureMatches(response: ObservedResponse, signature: string): boolean {
  return signature.length > 0 && response.body.includes(signature);
}

/** Builds the probe URL. The value is URL-encoded, and a single quote becomes %27 so the URL works in a shell. */
export function probeUrl(baseUrl: string, pins: ReplayPins, value: string): string {
  const encoded = encodeURIComponent(value).replace(/'/g, '%27');
  return `${baseUrl}${pins.scope.pathPrefix}?${pins.scope.parameter}=${encoded}`;
}

/** Refuses any URL outside the run's scope (method, host and path prefix). Fail closed. */
export function assertInScope(url: string, pins: ReplayPins): void {
  const parsed = new URL(url);
  if (pins.scope.method !== 'GET') throw new ScopeRefusal('method outside scope');
  if (parsed.hostname !== pins.scope.host) throw new ScopeRefusal('host outside scope');
  if (!parsed.pathname.startsWith(pins.scope.pathPrefix)) throw new ScopeRefusal('path outside scope');
}

export function fingerprintFor(parts: readonly string[]): string {
  return createHash('sha256').update(parts.join('|')).digest('hex');
}

function digest(body: string): string {
  return createHash('sha256').update(body).digest('hex');
}

async function sendProbe(
  url: string,
  value: string,
  pins: ReplayPins,
  deps: RunDeps,
  state: { used: number },
): Promise<ProbeRecord> {
  assertInScope(url, pins);
  if (state.used >= deps.budgetRequests) throw new BudgetExhausted('request budget exhausted');
  state.used += 1;
  const response = await deps.fetch(url);
  return {
    url,
    value,
    response: {
      status: response.status,
      contentType: response.contentType,
      bytes: Buffer.byteLength(response.body),
      bodySha256: digest(response.body),
      bodyExcerpt: response.body.slice(0, EXCERPT_CHARS),
    },
    matched: errorSignatureMatches(response, pins.testCase.oracle.params.signature),
  };
}

/**
 * Runs the pinned case. Emits one event per stage (persisted by the caller). Returns the outcome; `confirmed`
 * only when every replay matches and the negative control does not (issue #881, acceptance criteria).
 */
export async function runPinnedCase(pins: ReplayPins, runId: string, deps: RunDeps): Promise<ReplayOutcome> {
  const state = { used: 0 };
  const base = pins.asset.baseUrl;
  const stage = async (kind: string, stageName: string, message: string, data: Record<string, unknown> = {}) => {
    await deps.emit({ kind, stage: stageName, message, data });
    await deps.sleep(deps.stageDelayMs);
  };

  await stage('scope.checked', 'scope', `Scope checked: ${pins.scope.method} ${pins.scope.pathPrefix} on ${pins.scope.host} (verified lab asset).`, {
    scope: pins.scope,
  });
  await stage('plan.selected', 'plan', `Planner selected ${pins.testCase.id} (deterministic stub, no model call).`, {
    testCaseId: pins.testCase.id,
    oracleId: pins.testCase.oracle.id,
  });

  const probeAddress = probeUrl(base, pins, pins.testCase.probe.value);
  const probe = await sendProbe(probeAddress, pins.testCase.probe.value, pins, deps, state);
  await stage('probe.sent', 'probe', `Detection probe sent: HTTP ${probe.response.status}, ${probe.response.bytes} bytes.`, {
    url: probe.url,
    status: probe.response.status,
    matched: probe.matched,
  });

  const replayRecords: ({ readonly n: number } & ProbeRecord)[] = [];
  for (let n = 1; n <= pins.testCase.replayCount; n += 1) {
    const record = await sendProbe(probeAddress, pins.testCase.probe.value, pins, deps, state);
    replayRecords.push({ n, ...record });
    await stage(
      'oracle.replayed',
      'validate',
      `Replay ${n}: HTTP ${record.response.status}, oracle ${record.matched ? 'matched' : 'did not match'}.`,
      { replay: n, status: record.response.status, matched: record.matched, oracleId: pins.testCase.oracle.id },
    );
  }

  const controlAddress = probeUrl(base, pins, pins.testCase.negativeControl.value);
  const negativeControl = await sendProbe(controlAddress, pins.testCase.negativeControl.value, pins, deps, state);
  await stage(
    'control.checked',
    'validate',
    `Negative control: HTTP ${negativeControl.response.status}, oracle ${negativeControl.matched ? 'matched (unexpected)' : 'did not match'}.`,
    { status: negativeControl.response.status, matched: negativeControl.matched },
  );

  const confirmed =
    probe.matched && replayRecords.length === pins.testCase.replayCount && replayRecords.every((r) => r.matched) && !negativeControl.matched;
  const fingerprint = fingerprintFor([pins.testCase.id, pins.asset.id, pins.scope.method, pins.scope.pathPrefix, pins.scope.parameter, runId]);
  return {
    confirmed,
    requestsUsed: state.used,
    probe,
    replays: replayRecords,
    negativeControl,
    fingerprint,
    reproCurl: `curl -s -i '${probeAddress}'`,
  };
}
