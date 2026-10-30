// Unit tests for the reversal journal repository's input rules. Each refusal happens before any query, so the
// transaction handle is a stub that fails the test if it is ever used.

import { describe, expect, it } from 'vitest';

import { ValidationError } from '@blackwing/errors';
import { newId } from '@blackwing/ids';

import { reversalJournalRepository } from './reversal-journal.repository.js';

import type { TenantTx } from './with-tenant.js';

/** A transaction that must never be touched: any query is a failed assertion. */
const untouchedTx = new Proxy(
  {},
  {
    get(_target, property) {
      throw new Error(
        `repository touched the transaction (${String(property)}) before validating input`,
      );
    },
  },
) as unknown as TenantTx;

const validCreate = {
  tenantId: newId(),
  runId: newId(),
  testCaseId: newId(),
  action: 'create order',
  target: { kind: 'endpoint', ref: 'orders.create', method: 'POST' },
  undoInstructions: { type: 'delete_created_resource', params: { resourceId: 'ord_1' } },
};

const meta = { expectedUpdatedAt: '2026-10-30T07:00:00.000Z' };

describe('reversalJournalRepository input validation (before any query)', () => {
  it('create refuses a missing tenant and writes nothing', async () => {
    const withoutTenant: Record<string, unknown> = { ...validCreate };
    delete withoutTenant.tenantId;
    await expect(reversalJournalRepository.create(untouchedTx, withoutTenant)).rejects.toThrow(
      ValidationError,
    );
  });

  it('create refuses an oversized inline undo descriptor', async () => {
    const big = {
      ...validCreate,
      undoInstructions: { type: 'http_request', params: { blob: 'x'.repeat(17_000) } },
    };
    await expect(reversalJournalRepository.create(untouchedTx, big)).rejects.toThrow(
      ValidationError,
    );
  });

  it('create refuses a free-form undo command', async () => {
    const shell = {
      ...validCreate,
      undoInstructions: { type: 'shell', params: { command: 'rm -rf /' } },
    };
    await expect(reversalJournalRepository.create(untouchedTx, shell)).rejects.toThrow(
      ValidationError,
    );
  });

  it('setUndoStatus refuses an unknown status value with a typed AppError', async () => {
    await expect(
      reversalJournalRepository.setUndoStatus(untouchedTx, newId(), 'reverted', meta),
    ).rejects.toThrow(ValidationError);
  });

  it('setUndoStatus refuses a malformed id and a malformed updatedAt', async () => {
    await expect(
      reversalJournalRepository.setUndoStatus(untouchedTx, 'rvj_nope', 'undone', meta),
    ).rejects.toThrow(ValidationError);
    await expect(
      reversalJournalRepository.setUndoStatus(untouchedTx, newId(), 'undone', {
        expectedUpdatedAt: 'yesterday',
      }),
    ).rejects.toThrow(ValidationError);
  });

  it('getById and listByRun refuse a malformed id', async () => {
    await expect(reversalJournalRepository.getById(untouchedTx, 'not-a-uuid')).rejects.toThrow(
      ValidationError,
    );
    await expect(reversalJournalRepository.listByRun(untouchedTx, 'run_x')).rejects.toThrow(
      ValidationError,
    );
  });

  it('listByRun refuses an unknown status filter', async () => {
    await expect(
      reversalJournalRepository.listByRun(untouchedTx, newId(), { status: 'reverted' as 'failed' }),
    ).rejects.toThrow(ValidationError);
  });
});
