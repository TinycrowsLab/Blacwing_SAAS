import { brokerStateResponseSchema, type AgentSessionDescriptor } from '@blackwing/contracts';

import {
  buildRunOptions,
  drive,
  EXIT_CODES,
  preToolUseHooks,
  recordDenials,
  recordSession,
  SessionExit,
  type SessionPorts,
  type SessionResultMessage,
} from './run-session.js';

import type { ResumeGrant } from '../hooks/pre-tool-use.js';
import type { Options, SessionStore } from '@anthropic-ai/claude-agent-sdk';

/**
 * Resumes a session that stopped with `tool_deferred` once Gate 2 decided its deferred call (GATE2-007, #208;
 * CONTEXT_PACK §4.3, §8.3, §8.11; REFERENCES §3.3).
 *
 * The session is resumed with `resume: sessionId` from its `sessionStore`, so it survives the loss of the process
 * that first ran it. The deferred call is re-evaluated under a one-call grant: the PreToolUse hook answers allow
 * iff a human approved that exact call (same tool-use id, name and targets), the call is not state-changing without
 * its reversal-journal entry, and the grant has not been spent. Every other call re-enters the gate. The grant
 * never widens the envelope.
 *
 * A resume is applied at most once per decision (`createSessionResumer` keeps the applied keys). Once the session
 * is driven, the key stays applied, because the approved call may already have run. A retry must never run it again.
 */

/** The prompt that continues the session once its deferred call has been decided. */
export const RESUME_PROMPT =
  'The deferred tool call has been decided. Continue the task within the same envelope.';

/** The call Gate 2 deferred. The targets are the hook's extracted targets, never the call's input. */
interface DeferredCall {
  readonly toolUseId: string;
  readonly toolName: string;
  readonly targets: readonly string[];
}

export interface ResumeDeferredInput {
  /** The original session's descriptor: the envelope, tool gate and brokered run it belongs to. */
  readonly descriptor: AgentSessionDescriptor;
  readonly exceptionId: string;
  readonly call: DeferredCall;
  readonly decision: 'approve_once' | 'deny';
  /**
   * True when the call is state-changing and the reversal journal holds no entry for it. The caller reads the journal,
   * because the runtime has no read path to it. The grant then denies the call (§8.3).
   */
  readonly journalMissing: boolean;
}

type ResumeOutcome =
  /** The session resumed and ran to its next stop. `status` is `tool_deferred` when it stopped on another call. */
  | {
      readonly outcome: 'resumed';
      readonly status: string;
      readonly numTurns: number;
      readonly totalCostUsd: number;
    }
  /** The session cannot be resumed (store missing, corrupt or expired, or the SDK failed). Terminal: treat as a deny. */
  | { readonly outcome: 'session_expired' }
  /** The run is no longer active (killed or closed), so the session is not resumed. Terminal. */
  | { readonly outcome: 'run_inactive' }
  /** This decision was already applied. Nothing ran again. */
  | { readonly outcome: 'duplicate' };

export type ResumePorts = SessionPorts & { readonly sessionStore: SessionStore };

/** A resumer that applies each decision at most once. Keep one per process, shared by every resume call. */
export interface SessionResumer {
  resume(input: ResumeDeferredInput): Promise<ResumeOutcome>;
}

/** Builds the resumer over its ports. The applied-keys set lives in this closure, not at module scope. */
export function createSessionResumer(ports: ResumePorts): SessionResumer {
  const applied = new Set<string>();

  return {
    async resume(input) {
      const { descriptor, exceptionId, call, decision } = input;
      const key = `${descriptor.sessionId}:${exceptionId}:${call.toolUseId}`;
      const log = (outcome: string): void => {
        ports.log.info(
          { sessionId: descriptor.sessionId, exceptionId, decision, outcome },
          'gate2.resume',
        );
      };
      if (applied.has(key)) {
        ports.metrics.gate2Resumes.inc({ decision, outcome: 'duplicate' });
        log('duplicate');
        return { outcome: 'duplicate' };
      }
      applied.add(key);

      // Fail closed before anything runs. A broker that cannot answer throws, so the caller retries; nothing ran, so
      // the decision is released for that retry.
      let active: boolean;
      try {
        active = (await ports.broker.get('state', brokerStateResponseSchema)).active;
      } catch (error) {
        applied.delete(key);
        throw error;
      }
      if (!active) {
        ports.metrics.gate2Resumes.inc({ decision, outcome: 'run_inactive' });
        log('run_inactive');
        return { outcome: 'run_inactive' };
      }

      const grant: ResumeGrant = {
        toolUseId: call.toolUseId,
        toolName: call.toolName,
        targets: [...call.targets],
        approved: decision === 'approve_once',
        journalMissing: input.journalMissing,
      };
      const buildOptions = (): Options => ({
        ...buildRunOptions(
          descriptor,
          new AbortController(),
          preToolUseHooks(descriptor, ports, grant),
          ports.sessionStore,
        ),
        resume: descriptor.sessionId,
      });

      let result: SessionResultMessage;
      try {
        result = await drive(RESUME_PROMPT, ports.runQuery, buildOptions);
      } catch (error) {
        // A lost or corrupt snapshot, or an SDK error before the session produced its result, is unrecoverable.
        if (!(error instanceof SessionExit) || error.exitCode !== EXIT_CODES.unhandledError) {
          throw error;
        }
        ports.metrics.gate2ResumeFailures.inc();
        ports.metrics.gate2Resumes.inc({ decision, outcome: 'session_expired' });
        log('session_expired');
        return { outcome: 'session_expired' };
      }
      recordDenials(descriptor, result.permission_denials, ports);
      const status = await recordSession(descriptor, result, ports);
      ports.metrics.gate2Resumes.inc({ decision, outcome: 'resumed' });
      log('resumed');
      return {
        outcome: 'resumed',
        status,
        numTurns: result.num_turns,
        totalCostUsd: result.total_cost_usd,
      };
    },
  };
}
