import type { OutboxClaim, ClaimedOutboxRow } from '@blackwing/db';

// Test doubles for the outbox relay (shared by the unit tests). Not exported from the package.

export const TENANT = '0190a000-0000-7000-8000-000000000001';
const ID_DIGITS = 12;
const ROW_AGE_MS = 2_000;
const AGGREGATE = '0190a000-0000-7000-8000-0000000000a1';

let counter = 0;
export function makeRow(over: Partial<ClaimedOutboxRow> = {}): ClaimedOutboxRow {
  counter += 1;
  return {
    id: `0190a000-0000-7000-8000-${String(counter).padStart(ID_DIGITS, '0')}`,
    tenantId: TENANT,
    type: 'notify.send',
    aggregateType: 'run',
    aggregateId: AGGREGATE,
    payload: { template: 'run_done' },
    dedupeKey: `key-${String(counter)}`,
    attempts: 0,
    createdAt: new Date(Date.now() - ROW_AGE_MS),
    ...over,
  };
}

export interface RecordingClaim extends OutboxClaim {
  readonly calls: {
    op: 'dispatched' | 'retry' | 'failed';
    id: string;
    error?: string;
    delayMs?: number;
  }[];
}

export function makeClaim(rows: readonly ClaimedOutboxRow[]): RecordingClaim {
  const calls: RecordingClaim['calls'] = [];
  return {
    rows,
    calls,
    markDispatched: (id) => {
      calls.push({ op: 'dispatched', id });
      return Promise.resolve();
    },
    markRetry: (id, error, delayMs) => {
      calls.push({ op: 'retry', id, error, delayMs });
      return Promise.resolve();
    },
    markFailed: (id, error) => {
      calls.push({ op: 'failed', id, error });
      return Promise.resolve();
    },
  };
}
