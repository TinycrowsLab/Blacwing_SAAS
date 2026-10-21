import type { AuditEventInput } from './draft.js';
import type { AuditEmitter } from './emit.js';
import type { AuditSqlTx } from './ports.js';
import type { AuditActor, AuditMetadata, AuditTarget } from '@blackwing/contracts';

/** How an event reaches the ledger: inside the caller's transaction, or through the outbox. */
export interface AuditDelivery {
  readonly emitter: AuditEmitter;
  /** Present: append in this transaction (sync). Absent: enqueue to the outbox. */
  readonly tx?: AuditSqlTx;
}

async function deliver(delivery: AuditDelivery, input: AuditEventInput): Promise<void> {
  if (delivery.tx === undefined) {
    await delivery.emitter.emitAudit(input);
  } else {
    await delivery.emitter.emitAuditInTx(delivery.tx, input);
  }
}

/** Fields every wrapper takes. */
interface CommonArgs {
  readonly tenantId: string;
  readonly actor: AuditActor;
  readonly reason?: string;
  readonly metadata?: AuditMetadata;
  readonly traceId?: string;
  readonly runId?: string;
  readonly ip?: string;
  readonly userAgent?: string;
  readonly dedupeKey?: string;
}

function common(args: CommonArgs): Omit<AuditEventInput, 'action' | 'target' | 'outcome'> {
  return {
    tenantId: args.tenantId,
    actor: args.actor,
    ...(args.reason === undefined ? {} : { reason: args.reason }),
    ...(args.metadata === undefined ? {} : { metadata: args.metadata }),
    ...(args.traceId === undefined ? {} : { traceId: args.traceId }),
    ...(args.runId === undefined ? {} : { runId: args.runId }),
    ...(args.ip === undefined ? {} : { ip: args.ip }),
    ...(args.userAgent === undefined ? {} : { userAgent: args.userAgent }),
    ...(args.dedupeKey === undefined ? {} : { dedupeKey: args.dedupeKey }),
  };
}

export type GateNumber = 1 | 2 | 3;
export type GateDecision = 'approved' | 'denied' | 'timed_out';

export interface GateDecisionArgs extends CommonArgs {
  readonly gate: GateNumber;
  readonly decision: GateDecision;
  readonly target: AuditTarget;
}

const GATE_ACTION = { 1: 'gate1.decided', 2: 'gate2.decided', 3: 'gate3.released' } as const;

/** The event for a gate decision. A timeout is a denial: no reply never means yes (§8.2). */
export function gateDecisionInput(args: GateDecisionArgs): AuditEventInput {
  return {
    ...common(args),
    action: GATE_ACTION[args.gate],
    target: args.target,
    outcome: args.decision === 'approved' ? 'success' : 'denied',
    metadata: { ...args.metadata, gate: args.gate, decision: args.decision },
  };
}

/** Records a Gate 1/2/3 decision. */
export function auditGateDecision(delivery: AuditDelivery, args: GateDecisionArgs): Promise<void> {
  return deliver(delivery, gateDecisionInput(args));
}

export interface LoginArgs extends CommonArgs {
  readonly succeeded: boolean;
  readonly target: AuditTarget;
}

/** The event for a sign-in attempt; a rejected attempt is a `failure`. */
export function loginInput(args: LoginArgs): AuditEventInput {
  return {
    ...common(args),
    action: 'auth.login',
    target: args.target,
    outcome: args.succeeded ? 'success' : 'failure',
  };
}

/** Records a sign-in attempt. */
export function auditLogin(delivery: AuditDelivery, args: LoginArgs): Promise<void> {
  return deliver(delivery, loginInput(args));
}

export interface ExportArgs extends CommonArgs {
  readonly target: AuditTarget;
  readonly outcome: 'success' | 'failure' | 'denied';
}

/** The event for a report or data export. */
export function exportInput(args: ExportArgs): AuditEventInput {
  return {
    ...common(args),
    action: 'export.generated',
    target: args.target,
    outcome: args.outcome,
  };
}

/** Records an export. */
export function auditExport(delivery: AuditDelivery, args: ExportArgs): Promise<void> {
  return deliver(delivery, exportInput(args));
}

export interface ConfigChangeArgs extends CommonArgs {
  readonly target: AuditTarget;
  readonly outcome: 'success' | 'failure' | 'denied';
}

/** The event for a configuration change (record before/after as references, never values). */
export function configChangeInput(args: ConfigChangeArgs): AuditEventInput {
  return {
    ...common(args),
    action: 'config.changed',
    target: args.target,
    outcome: args.outcome,
  };
}

/** Records a configuration change. */
export function auditConfigChange(delivery: AuditDelivery, args: ConfigChangeArgs): Promise<void> {
  return deliver(delivery, configChangeInput(args));
}
