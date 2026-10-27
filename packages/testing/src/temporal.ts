// Time-skipping Temporal test harness (WORKFLOW-009, #29). Entry point: "@blackwing/testing/temporal".
// It boots the SDK's time-skipping test server, so it is not part of the pure root entry and needs the
// Temporal test-server binary (downloaded and cached by the SDK on first use, no Docker).
import { randomUUID } from 'node:crypto';

import { TestWorkflowEnvironment, type ClientOptionsForTestEnv } from '@temporalio/testing';
import { Worker, type InjectedSinks } from '@temporalio/worker';

import type { Client, WorkflowHandle } from '@temporalio/client';
import type { ActivityFunction } from '@temporalio/common';
import type { Sinks } from '@temporalio/workflow';

export interface TestWorkflowEnvOptions {
  /** Path of the workflow module(s) under test. The worker bundles it, so activities stay out of the sandbox. */
  readonly workflowsPath: string;
  /**
   * Workflow interceptor modules to register (for example the project's context and audit entry). They are
   * passed in by the caller: this package may not import `apps/*`, which hold the project interceptors.
   */
  readonly workflowInterceptorModules?: readonly string[];
  /** Activity implementations the workflows call. Audit capture and fakes are supplied here. */
  readonly activities?: Readonly<Record<string, ActivityFunction>>;
  /** Sinks the interceptors report to. Empty by default: nothing is recorded unless the test asks for it. */
  readonly sinks?: InjectedSinks<Sinks>;
  /** Client-side options for the test client, for example client interceptors. */
  readonly client?: ClientOptionsForTestEnv;
  /** Task queue for this environment. Defaults to a unique queue so parallel tests never share a worker. */
  readonly taskQueue?: string;
}

export interface TestWorkflowEnv {
  /** The time-skipping environment. Its `sleep` skips virtual time forward. */
  readonly env: TestWorkflowEnvironment;
  /** Client bound to the test server; awaiting a workflow result auto-skips time. */
  readonly client: Client;
  readonly taskQueue: string;
}

/**
 * Boots a time-skipping test server and a worker on it, runs `fn`, then tears both down, even when `fn`
 * throws. The worker runs only while `fn` is pending.
 */
export async function withTestWorkflowEnv<T>(
  fn: (testEnv: TestWorkflowEnv) => Promise<T>,
  options: TestWorkflowEnvOptions,
): Promise<T> {
  const env = await TestWorkflowEnvironment.createTimeSkipping({
    ...(options.client === undefined ? {} : { client: options.client }),
  });
  try {
    const taskQueue = options.taskQueue ?? `test-${randomUUID()}`;
    const worker = await Worker.create({
      connection: env.nativeConnection,
      namespace: env.namespace ?? 'default',
      taskQueue,
      workflowsPath: options.workflowsPath,
      ...(options.workflowInterceptorModules === undefined
        ? {}
        : { interceptors: { workflowModules: [...options.workflowInterceptorModules] } }),
      activities: { ...options.activities },
      ...(options.sinks === undefined ? {} : { sinks: options.sinks }),
    });
    return await worker.runUntil(fn({ env, client: env.client, taskQueue }));
  } finally {
    await env.teardown();
  }
}

/** Skips virtual time forward by `ms`. Timers fire only as time is skipped, never in real time. */
export async function advanceTime(testEnv: TestWorkflowEnv, ms: number): Promise<void> {
  if (!Number.isSafeInteger(ms) || ms < 0) {
    throw new RangeError(
      `advanceTime needs a non-negative whole number of milliseconds, got ${ms}`,
    );
  }
  await testEnv.env.sleep(ms);
}

/** Waits for a workflow's result. Through the test client this also skips time to the next timer. */
export async function getWorkflowResult<T>(handle: { result(): Promise<T> }): Promise<T> {
  return handle.result();
}

/**
 * Sends a signal and waits until the workflow has recorded it. The server appends the signal to history
 * before the call returns, so a later result or time skip always sees it.
 */
export async function sendSignalAndSettle(
  handle: WorkflowHandle,
  signal: string,
  args: readonly unknown[],
): Promise<void> {
  await handle.signal(signal, ...args);
}
