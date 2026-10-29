import { readFile, stat } from 'node:fs/promises';

import { trace } from '@opentelemetry/api';

import { isConfigValidationError } from '@blackwing/config';
import { createLogger, type Logger } from '@blackwing/logger';
import { createBrokerClient } from '@blackwing/mcp-tools';

import { DESCRIPTOR_FILE_MAX_BYTES, parseSessionDescriptor } from './descriptor.js';
import { loadRuntimeEnv } from './env.js';
import { createRuntimeMetrics, type RuntimeMetrics } from './metrics.js';
import { SDK_VERSION, runSdkQuery } from './sdk.js';
import { EXIT_CODES, type RunQuery, runSession, SessionExit } from './session/run-session.js';

import type { AgentSessionDescriptor } from '@blackwing/contracts';

/**
 * Boot of one agent-runtime process (RUNTIME-001, #463): read the descriptor named by `BW_SESSION_DESCRIPTOR`,
 * validate it, then run the session. Returns the process exit code. Nothing reaches the model before the
 * descriptor is valid and the run broker has answered.
 */

export interface AppDeps {
  readonly log: Logger;
  readonly runQuery: RunQuery;
  readonly sdkVersion: string;
  /** Defaults to a fresh registry per process (`createRuntimeMetrics`). */
  readonly metrics?: RuntimeMetrics;
}

const defaultDeps = (): AppDeps => ({
  log: createLogger('@blackwing/agent-runtime'),
  runQuery: runSdkQuery,
  sdkVersion: SDK_VERSION,
});

/** Reads the descriptor file, refusing anything over the size cap before it is parsed. */
async function readDescriptor(path: string): Promise<string> {
  const info = await stat(path);
  if (!info.isFile() || info.size > DESCRIPTOR_FILE_MAX_BYTES) {
    throw new Error('descriptor file is missing or too large');
  }
  return readFile(path, 'utf8');
}

export async function runMain(
  source: Readonly<Record<string, string | undefined>>,
  deps: AppDeps = defaultDeps(),
): Promise<number> {
  let descriptorPath: string;
  try {
    descriptorPath = loadRuntimeEnv(source).BW_SESSION_DESCRIPTOR;
  } catch (error) {
    const code = isConfigValidationError(error) ? 'CONFIG_INVALID' : 'INTERNAL';
    deps.log.warn({ code }, 'session.descriptor_invalid');
    return EXIT_CODES.descriptorInvalid;
  }

  let descriptor: AgentSessionDescriptor;
  try {
    descriptor = parseSessionDescriptor(await readDescriptor(descriptorPath));
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? String(error.code) : 'UNREADABLE';
    deps.log.warn({ code }, 'session.descriptor_invalid');
    return EXIT_CODES.descriptorInvalid;
  }

  const metrics = deps.metrics ?? createRuntimeMetrics();
  return trace
    .getTracer('@blackwing/agent-runtime')
    .startActiveSpan('agent.session', async (span) => {
      try {
        return await runAgentSession(descriptor, deps, metrics);
      } finally {
        span.end();
      }
    });
}

/** Runs the validated session and maps its outcome to an exit code. Every failure is logged without values. */
async function runAgentSession(
  descriptor: AgentSessionDescriptor,
  deps: AppDeps,
  metrics: RuntimeMetrics,
): Promise<number> {
  try {
    const broker = createBrokerClient({
      baseUrl: descriptor.brokerBaseUrl,
      runId: descriptor.runId,
      token: descriptor.brokerToken,
    });
    const summary = await runSession(descriptor, {
      broker,
      runQuery: deps.runQuery,
      sdkVersion: deps.sdkVersion,
      log: deps.log,
      metrics,
    });
    deps.log.info({ sessionId: summary.sessionId, status: summary.status }, 'session.finished');
    return EXIT_CODES.success;
  } catch (error) {
    if (error instanceof SessionExit) {
      deps.log.warn({ exitCode: error.exitCode, sessionId: descriptor.sessionId }, error.message);
      return error.exitCode;
    }
    deps.log.warn({ sessionId: descriptor.sessionId }, 'session.unhandled_error');
    return EXIT_CODES.unhandledError;
  }
}
