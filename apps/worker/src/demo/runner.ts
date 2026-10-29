// DEMO-STORY runner loop: claims one queued demo run at a time (SKIP LOCKED), executes the pinned case through
// ./replay.ts and persists events, the finding and the terminal state. Demo only: the worker starts it with
// BW_DEMO_MODE=1 (see ./main.ts). It does not use Temporal; the demo stubs that (see the demo runbook).
import { newId } from '@blackwing/ids';

import { BudgetExhausted, runPinnedCase, ScopeRefusal, type ObservedResponse, type ReplayPins, type RunDeps, type StageEvent } from './replay.js';


export interface QueuedRun {
  readonly id: string;
  readonly tenant_id: string;
  readonly request_id: string;
  readonly pins: ReplayPins;
  readonly budget_requests: number;
}

/** Persistence the runner needs. Implemented over `pg` (demo schema) in ./store-pg.ts, faked in unit tests. */
export interface RunnerStore {
  claimQueuedRun(): Promise<QueuedRun | null>;
  nextSeq(runId: string): Promise<number>;
  appendEvent(runId: string, seq: number, event: StageEvent): Promise<void>;
  insertFinding(row: FindingInsert): Promise<void>;
  finishRun(runId: string, state: 'completed' | 'failed', requestsUsed: number): Promise<void>;
  setRequestStatus(tenantId: string, requestId: string, status: 'completed' | 'approved'): Promise<void>;
}

export interface FindingInsert {
  readonly id: string;
  readonly tenant_id: string;
  readonly run_id: string;
  readonly asset_id: string;
  readonly fingerprint: string;
  readonly title: string;
  readonly test_case_id: string;
  readonly class: string;
  readonly cwe_id: string;
  readonly owasp_category: string;
  readonly severity: Record<string, unknown>;
  readonly location: Record<string, unknown>;
  readonly confidence: number;
  readonly oracle: Record<string, unknown>;
  readonly evidence: Record<string, unknown>;
  readonly replay: Record<string, unknown>;
  readonly repro_curl: string;
}

export interface RunnerLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}

/** Real HTTP GET with a timeout, no redirects (a redirect could leave the scope). */
export async function httpGet(url: string): Promise<ObservedResponse> {
  const response = await fetch(url, {
    method: 'GET',
    redirect: 'manual',
    headers: { 'user-agent': 'blackwing-demo-runner/1' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  return {
    status: response.status,
    contentType: response.headers.get('content-type') ?? '',
    body: await response.text(),
  };
}

const REQUEST_TIMEOUT_MS = 8000;

/**
 * Executes one queued run end to end. Never throws: a refusal or a failure becomes a `failed` run with an event,
 * so the console shows the reason. A confirmed finding is written only when the oracle result is conclusive.
 */
export async function executeRun(
  store: RunnerStore,
  run: QueuedRun,
  deps: { readonly fetch: RunDeps['fetch']; readonly sleep: RunDeps['sleep']; readonly stageDelayMs: number },
  logger: RunnerLogger,
): Promise<void> {
  let seq = await store.nextSeq(run.id);
  const emit = async (event: StageEvent): Promise<void> => {
    await store.appendEvent(run.id, seq, event);
    seq += 1;
  };
  try {
    const outcome = await runPinnedCase(run.pins, run.id, {
      fetch: deps.fetch,
      sleep: deps.sleep,
      stageDelayMs: deps.stageDelayMs,
      budgetRequests: run.budget_requests,
      emit,
    });
    if (outcome.confirmed) {
      const severity = { cvssV4Vector: 'CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:N/SC:N/SI:N/SA:N', cvssV4Score: 8.7, cvssV31Vector: null };
      await store.insertFinding({
        id: newId(),
        tenant_id: run.tenant_id,
        run_id: run.id,
        asset_id: run.pins.asset.id,
        fingerprint: outcome.fingerprint,
        title: `${run.pins.testCase.title} (GET ${run.pins.scope.pathPrefix}, parameter ${run.pins.scope.parameter})`,
        test_case_id: run.pins.testCase.id,
        class: 'injection.sqli',
        cwe_id: run.pins.testCase.cwe,
        owasp_category: run.pins.testCase.owasp,
        severity,
        location: { method: 'GET', urlTemplate: run.pins.scope.pathPrefix, parameter: run.pins.scope.parameter, file: null, line: null },
        confidence: 0.95,
        oracle: { ...run.pins.testCase.oracle, bindingType: run.pins.testCase.oracle.type },
        evidence: {
          recorded: false,
          probe: { request: { method: 'GET', url: outcome.probe.url }, response: outcome.probe.response },
          negativeControl: { request: { method: 'GET', url: outcome.negativeControl.url }, response: outcome.negativeControl.response },
        },
        replay: {
          reproduced: true,
          replays: outcome.replays.map((r) => ({ n: r.n, status: r.response.status, matched: r.matched, bodySha256: r.response.bodySha256 })),
          negativeControl: { status: outcome.negativeControl.response.status, matched: false },
        },
        repro_curl: outcome.reproCurl,
      });
      await emit({ kind: 'finding.confirmed', stage: 'report', message: 'Finding confirmed: every replay matched and the negative control did not.', data: { fingerprint: outcome.fingerprint } });
    } else {
      await emit({ kind: 'finding.not_confirmed', stage: 'report', message: 'Not confirmed: the oracle result was not conclusive. No finding written.', data: {} });
    }
    await emit({ kind: 'run.completed', stage: 'done', message: 'Run completed.', data: { requestsUsed: outcome.requestsUsed, confirmed: outcome.confirmed } });
    await store.finishRun(run.id, 'completed', outcome.requestsUsed);
    await store.setRequestStatus(run.tenant_id, run.request_id, 'completed');
    logger.info({ event: 'demo.run.completed', runId: run.id, confirmed: outcome.confirmed }, 'demo run completed');
  } catch (error) {
    const refusal = error instanceof ScopeRefusal || error instanceof BudgetExhausted;
    const message = refusal ? error.message : 'The lab target did not answer the probe.';
    await emit({
      kind: refusal ? 'run.refused' : 'run.failed',
      stage: 'done',
      message: `Run stopped: ${message}`,
      data: { reason: error instanceof Error ? error.name : 'unknown' },
    });
    await store.finishRun(run.id, 'failed', 0);
    await store.setRequestStatus(run.tenant_id, run.request_id, 'approved');
    logger.error({ event: 'demo.run.failed', runId: run.id, reason: error instanceof Error ? error.name : 'unknown' }, 'demo run failed');
  }
}

/** One poll: claims at most one queued run and executes it. Returns whether a run was taken. */
export async function pollOnce(
  store: RunnerStore,
  deps: { readonly fetch: RunDeps['fetch']; readonly sleep: RunDeps['sleep']; readonly stageDelayMs: number },
  logger: RunnerLogger,
): Promise<boolean> {
  const run = await store.claimQueuedRun();
  if (run === null) return false;
  await executeRun(store, run, deps, logger);
  return true;
}

