import { upsertSearchAttributes } from '@temporalio/workflow';

import { AppError } from '@blackwing/errors';

import type { RunState } from '@blackwing/contracts';

// Temporal custom search attributes (WORKFLOW-003, CONTEXT_PACK §3.3). They make runs listable and filterable
// in Temporal visibility by tenant, run and state, so operators and kill-by-scope discovery (§8.5) can find them.
// Run state stays authoritative in Postgres; these attributes are a read-side index, never a source of truth.
// This module is also bundled into the deterministic workflow sandbox: keep it free of Node built-ins.

/** Custom search attributes and their Temporal types. Registered idempotently by `register-search-attributes`. */
export const SEARCH_ATTRIBUTES = {
  tenantId: 'Keyword',
  runId: 'Keyword',
  runState: 'Keyword',
} as const;

/** Name of a registered custom search attribute. */
export type SearchAttributeName = keyof typeof SEARCH_ATTRIBUTES;

/** Temporal type of a custom search attribute. Only `Keyword` is used today. */
export type SearchAttributeType = (typeof SEARCH_ATTRIBUTES)[SearchAttributeName];

/** Longest tenant or run identifier accepted as a search attribute value (Temporal keyword limit). */
const MAX_ID_LENGTH = 255;
/** The shape of every Blackwing identifier: UUIDs and prefixed public IDs. No slashes, spaces or Unicode. */
const ID_PATTERN = /^[A-Za-z0-9_.-]+$/;

/**
 * The run states a search attribute may hold. Must equal `runStateSchema.options` in `@blackwing/contracts`
 * (a unit test enforces it). Kept local because contracts pulls Node built-ins that the workflow sandbox forbids.
 */
export const RUN_STATE_VALUES = [
  'draft',
  'preflight',
  'recon',
  'planning',
  'awaiting_gate1',
  'approved',
  'executing',
  'paused',
  'validating',
  'awaiting_gate3',
  'released',
  'reporting',
  'completed',
  'cancelled',
  'killed',
  'failed',
  'expired',
] as const satisfies readonly RunState[];

/** Identity of one run as it is written to Temporal visibility. */
export interface RunSearchAttributeInput {
  readonly tenantId: string;
  readonly runId: string;
  readonly runState: RunState;
}

function parseId(field: 'tenantId' | 'runId', value: string): string {
  if (value.length === 0 || value.length > MAX_ID_LENGTH || !ID_PATTERN.test(value)) {
    throw new AppError(
      'VALIDATION_FAILED',
      `search attribute ${field} must be 1-${String(MAX_ID_LENGTH)} characters of letters, digits, '.', '_' or '-'`,
    );
  }
  return value;
}

/** Fails closed on anything that is not a known run state; an unknown state is never written. */
function parseRunState(value: string): RunState {
  const known = (RUN_STATE_VALUES as readonly string[]).includes(value);
  if (!known) {
    throw new AppError('VALIDATION_FAILED', 'search attribute runState is not a known run state');
  }
  return value as RunState;
}

/**
 * The search attributes to set when a run workflow starts, for `client.workflow.start({ searchAttributes })`.
 * Validates every value: a malformed identifier or unknown state throws instead of being indexed.
 */
export function runStartSearchAttributes(input: RunSearchAttributeInput): {
  readonly tenantId: string[];
  readonly runId: string[];
  readonly runState: string[];
} {
  return {
    tenantId: [parseId('tenantId', input.tenantId)],
    runId: [parseId('runId', input.runId)],
    runState: [parseRunState(input.runState)],
  };
}

/** The search attributes a state change writes. Pure, so tests and callers can inspect it without Temporal. */
export function runStateSearchAttributes(state: RunState): { readonly runState: string[] } {
  return { runState: [parseRunState(state)] };
}

/**
 * Records a run's new state in visibility. Call from workflow code only (`upsertSearchAttributes` is a
 * deterministic workflow API); activities must never call it. Invalid states throw before anything is written.
 */
export function upsertRunSearchAttributes(state: RunState): void {
  upsertSearchAttributes(runStateSearchAttributes(state));
}
