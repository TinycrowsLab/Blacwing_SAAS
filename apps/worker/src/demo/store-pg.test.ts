import { describe, expect, it, vi } from 'vitest';

import { demoAuditHash, type DemoAuditPayload } from '@blackwing/audit';

import { pgHuntStore } from './store-pg.js';

import type pg from 'pg';

const event = { kind: 'run.killed', stage: 'control', message: 'Run killed.', data: {} };

describe('pgHuntStore.appendEvent', () => {
  it('retries when the API took the same seq, so the worker event is not dropped', async () => {
    const query = vi.fn().mockRejectedValueOnce({ code: '23505' }).mockResolvedValueOnce({ rows: [] });
    await expect(pgHuntStore({ query } as unknown as pg.Pool).appendEvent('run-1', event)).resolves.toBeUndefined();
    expect(query).toHaveBeenCalledTimes(2);
    expect(String(query.mock.calls[1]?.[0])).toContain('max(seq)');
  });

  it('rethrows any other error at once', async () => {
    const query = vi.fn().mockRejectedValue({ code: '08006' });
    await expect(pgHuntStore({ query } as unknown as pg.Pool).appendEvent('run-1', event)).rejects.toEqual({ code: '08006' });
    expect(query).toHaveBeenCalledTimes(1);
  });
});

describe('pgHuntStore.claimQueuedRun release mode', () => {
  const claimed = (request: Record<string, unknown>) => ({
    rows: [
      {
        id: 'run-1',
        tenant_id: 't',
        request_id: 'q',
        test_accounts: [],
        pins: {
          asset: { id: 'a', name: 'A', allowedOrigins: ['https://t.example'], excludedPaths: [] },
          request: { id: 'q', objective: 'o', budget: { requests: 10, seconds: 60, costUsd: 1 }, ...request },
        },
      },
    ],
  });

  it('reads hold from the pins, and defaults runs pinned before release modes to auto', async () => {
    const hold = vi.fn().mockResolvedValue(claimed({ releaseProven: 'hold' }));
    expect((await pgHuntStore({ query: hold } as unknown as pg.Pool).claimQueuedRun())?.releaseProven).toBe('hold');
    const old = vi.fn().mockResolvedValue(claimed({}));
    expect((await pgHuntStore({ query: old } as unknown as pg.Pool).claimQueuedRun())?.releaseProven).toBe('auto');
  });
});

describe('pgHuntStore request status (single-use Gate 1 approvals)', () => {
  const run = { id: 'run-1', tenantId: 't', requestId: 'q' } as unknown as Parameters<ReturnType<typeof pgHuntStore>['finishRun']>[0];
  const statusSet = (query: ReturnType<typeof vi.fn>): [string, unknown][] =>
    query.mock.calls.filter((c) => String(c[0]).includes('demo.assessment_requests')).map((c): [string, unknown] => [String(c[0]), c[1]]);

  it('ends the request completed or failed with its run, never back to approved', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const store = pgHuntStore({ query } as unknown as pg.Pool);
    await store.finishRun(run, { state: 'failed', requestsUsed: 1, costUsd: 0, summary: null });
    await store.finishRun(run, { state: 'completed', requestsUsed: 1, costUsd: 0, summary: null });
    expect(statusSet(query).map(([, params]) => (params as unknown[])[2])).toEqual(['failed', 'completed']);
  });

  it('ends a killed run request killed', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ halt_ms: 7 }] });
    await expect(pgHuntStore({ query } as unknown as pg.Pool).markKilled(run)).resolves.toBe(7);
    expect(statusSet(query)[0]?.[0]).toContain("status = 'killed'");
  });

  it('fails stale runs, their requests and closes their asks as worker_restarted', async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [{ id: 'run-1', request_id: 'q', requests_used: 3, cost_usd: '0.5', findings: 1 }] }).mockResolvedValue({ rows: [] });
    const stale = await pgHuntStore({ query } as unknown as pg.Pool).failStaleRuns();
    expect(stale).toEqual([{ id: 'run-1', requestsUsed: 3, costUsd: 0.5, findings: 1 }]);
    const sql = query.mock.calls.map((c) => String(c[0])).join('\n');
    expect(sql).toContain("SELECT id FROM demo.gate2_requests WHERE run_id = ANY($1) AND status = 'pending'");
    expect(sql).toContain("UPDATE demo.assessment_requests SET status = 'failed'");
    expect(sql).not.toContain("'approved'");
  });
});

describe('pgHuntStore Gate 2 and findings columns', () => {
  it('parses lab origins from the pins (none for older pins)', async () => {
    const pins = (asset: Record<string, unknown>) => ({
      rows: [{ id: 'r', tenant_id: 't', request_id: 'q', test_accounts: [], pins: { asset: { id: 'a', name: 'A', allowedOrigins: ['http://127.0.0.1:3001'], excludedPaths: [], ...asset }, request: { id: 'q', objective: 'o', budget: { requests: 1, seconds: 1, costUsd: 1 } } } }],
    });
    const lab = vi.fn().mockResolvedValue(pins({ labOrigins: ['http://127.0.0.1:3001'] }));
    expect((await pgHuntStore({ query: lab } as unknown as pg.Pool).claimQueuedRun())?.labOrigins).toEqual(['http://127.0.0.1:3001']);
    const old = vi.fn().mockResolvedValue(pins({}));
    expect((await pgHuntStore({ query: old } as unknown as pg.Pool).claimQueuedRun())?.labOrigins).toEqual([]);
  });

  it('writes the ask body and role, and denies pending asks with the reason', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ id: 'g1' }] });
    const store = pgHuntStore({ query } as unknown as pg.Pool);
    const run = { id: 'run-1', tenantId: 't' } as unknown as Parameters<typeof store.insertGate2>[0];
    await store.insertGate2(run, { id: 'g1', agent: 'a', method: 'POST', url: 'u', pathKey: 'k', reason: 'r', whyOutside: 'w', deadlineAt: new Date(0), body: '{"a":1}', asRole: 'alice' });
    expect(String(query.mock.calls[0]?.[0])).toContain('request_body, as_role');
    expect((query.mock.calls[0]?.[1] as unknown[]).slice(-2)).toEqual(['{"a":1}', 'alice']);
    expect(query.mock.calls.length).toBe(1);
  });

  it('records an expiry on the ledger in the same transaction, chained after the last entry', async () => {
    const deadline = new Date('2026-11-08T12:05:00.000Z');
    const prev = 'a'.repeat(64);
    const clientQuery = vi.fn((sql: string) => {
      if (sql.startsWith('UPDATE demo.gate2_requests')) return Promise.resolve({ rows: [{ tenant_id: 't', run_id: 'run-1', method: 'POST', url: 'http://127.0.0.1:3001/api/Users', deadline_at: deadline }] });
      if (sql.startsWith('SELECT seq, hash')) return Promise.resolve({ rows: [{ seq: 41, hash: prev }] });
      return Promise.resolve({ rows: [] });
    });
    const release = vi.fn();
    const query = vi.fn().mockResolvedValue({ rows: [{ status: 'expired', decided_by: null }] });
    const store = pgHuntStore({ query, connect: () => Promise.resolve({ query: clientQuery, release }) } as unknown as pg.Pool);
    await expect(store.closeGate2('g1', 'expired', 'deadline')).resolves.toBe('expired');
    const sqls = clientQuery.mock.calls.map((c) => c[0]);
    expect(sqls[0]).toBe('BEGIN');
    expect(sqls.some((s) => s.includes('pg_advisory_xact_lock'))).toBe(true);
    expect(sqls.at(-1)).toBe('COMMIT');
    const insert = clientQuery.mock.calls.find((c) => c[0].startsWith('INSERT INTO demo.audit_events')) as unknown as [string, unknown[]];
    const [, tenant, seq, actorName, action, targetType, targetId, payload, prevHash, hash, at] = insert[1];
    expect([tenant, seq, actorName, action, targetType, targetId, prevHash]).toEqual(['t', 42, 'Blackwing', 'gate2.expired', 'gate2', 'g1', prev]);
    const fields = { seq: 42, at: at as Date, actorId: null, actorName: 'Blackwing', action: 'gate2.expired', targetType: 'gate2', targetId: 'g1', payload: JSON.parse(payload as string) as DemoAuditPayload };
    expect(JSON.parse(payload as string)).toEqual({ runId: 'run-1', method: 'POST', url: 'http://127.0.0.1:3001/api/Users', reason: 'deadline', deadlineAt: deadline.toISOString() });
    expect(hash).toBe(demoAuditHash(prev, fields));
    expect(release).toHaveBeenCalledOnce();
  });

  it('writes no ledger entry when the ask was already decided or is denied', async () => {
    const clientQuery = vi.fn().mockResolvedValue({ rows: [] });
    const query = vi.fn().mockResolvedValue({ rows: [{ status: 'approved', decided_by: 'u' }] });
    const store = pgHuntStore({ query, connect: () => Promise.resolve({ query: clientQuery, release: vi.fn() }) } as unknown as pg.Pool);
    await expect(store.closeGate2('g1', 'expired', 'deadline')).resolves.toBe('approved');
    expect(clientQuery.mock.calls.some((c) => String(c[0]).includes('audit_events'))).toBe(false);
  });

  it('stores the identity key with a finding', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ id: 'f1' }] });
    const store = pgHuntStore({ query } as unknown as pg.Pool);
    const run = { id: 'run-1', tenantId: 't', assetId: 'a' } as unknown as Parameters<typeof store.insertFinding>[0];
    const row = { id: 'f1', fingerprint: 'fp', identityKey: 'ik', agent: 'a', title: 't', vulnClass: 'c', cwe: 'CWE-1', owasp: 'A01:2021 Broken Access Control', severity: 'low', description: 'd', location: {}, oracle: {}, evidence: {}, replay: {}, reproCurl: 'curl', status: 'confirmed' as const, testCaseId: null };
    await expect(store.insertFinding(run, row)).resolves.toBe('f1');
    expect(String(query.mock.calls[0]?.[0])).toContain('identity_key');
    expect((query.mock.calls[0]?.[1] as unknown[]).at(-1)).toBe('ik');
  });
});
