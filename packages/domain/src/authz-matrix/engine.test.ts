import { describe, expect, it } from 'vitest';

import {
  AUTHZ_RATE_LIMITED_STATUS,
  AUTHZ_SKIP_REASONS,
  type AuthzCellResult,
  type AuthzEnginePorts,
  type AuthzReplayRequest,
  runAuthzMatrix,
} from './engine.js';
import { type AuthorisationMatrix, parseAuthorisationMatrix } from './model.js';

import type { RoleSessionStatus } from '@blackwing/contracts';

const JSON_LIST = '{"data":[{"id":1}]}';
const REFUSED = { status: 403, body: 'nope' };
const OK = { status: 200, body: JSON_LIST };
const SOFT_DENY = { status: 200, body: '{"error":"Access denied"}' };

/**
 * A matrix with two roles and three read functions, plus one write function, and one object-level function.
 * `customer` is expected to be denied `list_users`, which is the case the engine must probe.
 */
function matrix(overrides: Record<string, unknown> = {}): AuthorisationMatrix {
  return parseAuthorisationMatrix({
    version: 3,
    roles: ['customer', 'admin'],
    functions: [
      { id: 'list_users', method: 'GET', pathTemplate: '/api/Users' },
      { id: 'view_basket', method: 'GET', pathTemplate: '/rest/basket/{id}' },
      { id: 'delete_user', method: 'DELETE', pathTemplate: '/api/Users/{id}' },
      { id: 'op_only', operationId: 'getThing' },
    ],
    objects: [{ id: 'basket_1', ownerRoleId: 'customer' }],
    cells: [
      { roleId: 'customer', functionId: 'list_users', expected: 'deny' },
      { roleId: 'admin', functionId: 'list_users', expected: 'allow' },
      { roleId: 'customer', functionId: 'view_basket', objectId: 'basket_1', expected: 'allow' },
      { roleId: 'admin', functionId: 'view_basket', objectId: 'basket_1', expected: 'deny' },
      { roleId: 'customer', functionId: 'delete_user', expected: 'deny' },
    ],
    ...overrides,
  });
}

/** Scripted ports: the response per (role, function) and a session status per role. */
function ports(options: {
  responses?: Record<string, { status: number; body?: string; location?: string }[]>;
  sessions?: Record<string, RoleSessionStatus>;
  refresh?: Record<string, RoleSessionStatus>;
}) {
  const sent: AuthzReplayRequest[] = [];
  const cells: AuthzCellResult[] = [];
  const queues = new Map(
    Object.entries(options.responses ?? {}).map(([key, list]) => [key, [...list]]),
  );
  const sleeps: number[] = [];
  const refresh = options.refresh;
  const port: AuthzEnginePorts = {
    sessionStatus: (roleId) => Promise.resolve(options.sessions?.[roleId] ?? 'live'),
    ...(refresh === undefined
      ? {}
      : { refreshSession: (roleId: string) => Promise.resolve(refresh[roleId] ?? 'unavailable') }),
    replay: (request) => {
      sent.push(request);
      const key = `${request.roleId}:${request.functionId}`;
      const next = queues.get(key)?.shift() ?? queues.get(`${request.roleId}:*`)?.shift();
      return Promise.resolve({
        response: next ?? { status: 404 },
        evidenceRef: `ev-${sent.length}`,
      });
    },
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    onCell: (cell) => cells.push(cell),
  };
  return { port, sent, cells, sleeps };
}

describe('runAuthzMatrix: cell iteration', () => {
  it('walks every role x function x object cell in projected order and records one result per cell', async () => {
    const { port, cells } = ports({});
    const result = await runAuthzMatrix(matrix(), port, { maxRequests: 100 });
    expect(result.cells.map((c) => `${c.roleId}/${c.functionId}/${c.objectId ?? '-'}`)).toEqual([
      'customer/list_users/basket_1',
      'customer/view_basket/basket_1',
      'customer/delete_user/basket_1',
      'customer/op_only/basket_1',
      'admin/list_users/basket_1',
      'admin/view_basket/basket_1',
      'admin/delete_user/basket_1',
      'admin/op_only/basket_1',
    ]);
    expect(cells).toEqual(result.cells);
    expect(result.complete).toBe(true);
    expect(result.nextOffset).toBe(8);
    expect(result.matrixVersion).toBe(3);
  });

  it('never sends a request for a write function or an operation-id function', async () => {
    const { port, sent } = ports({});
    const result = await runAuthzMatrix(matrix(), port, { maxRequests: 100 });
    expect(sent.map((r) => r.functionId)).not.toContain('delete_user');
    expect(sent.map((r) => r.functionId)).not.toContain('op_only');
    const skipped = result.cells.filter((c) => c.verdict === 'skipped');
    expect(skipped.map((c) => c.reason)).toEqual(
      expect.arrayContaining([AUTHZ_SKIP_REASONS.writeMethod, AUTHZ_SKIP_REASONS.noReadMethod]),
    );
    expect(result.counts.skipped).toBe(4);
  });

  it('sends only GET, HEAD or OPTIONS, the read methods of the matrix', async () => {
    const { port, sent } = ports({});
    await runAuthzMatrix(matrix(), port, { maxRequests: 100 });
    for (const request of sent) expect(['GET', 'HEAD', 'OPTIONS']).toContain(request.method);
  });

  it('replays each cell under the acting role by reference, with the role id and no credential', async () => {
    const { port, sent } = ports({});
    await runAuthzMatrix(matrix(), port, { maxRequests: 100 });
    const first = sent[0];
    expect(first).toEqual({
      roleId: 'customer',
      functionId: 'list_users',
      objectId: 'basket_1',
      method: 'GET',
      pathTemplate: '/api/Users',
    });
    expect(Object.keys(first ?? {})).not.toContain('credential');
  });

  it('reports observed-only for a cell the matrix does not declare, with no pass or fail', async () => {
    const m = matrix({
      cells: [{ roleId: 'admin', functionId: 'list_users', expected: 'allow' }],
    });
    const { port } = ports({
      responses: { 'customer:*': [OK] },
    });
    const result = await runAuthzMatrix(m, port, { maxRequests: 100 });
    const undeclared = result.cells.find(
      (c) => c.roleId === 'customer' && c.functionId === 'list_users',
    );
    expect(undeclared?.expected).toBe('unknown');
    expect(undeclared?.verdict).toBe('unknown');
    expect(undeclared?.flagged).toBe(false);
    expect(undeclared?.actual).toBe('allow');
  });
});

describe('runAuthzMatrix: outcome classification and mismatch flagging', () => {
  it('passes a cell whose observed access matches the expectation', async () => {
    const { port } = ports({ responses: { 'admin:list_users': [OK] } });
    const result = await runAuthzMatrix(matrix(), port, { maxRequests: 100 });
    const admin = result.cells.find((c) => c.roleId === 'admin' && c.functionId === 'list_users');
    expect(admin).toMatchObject({ verdict: 'pass', actual: 'allow', flagged: false });
  });

  it('flags a violation when the matrix denies, the acting role is allowed and the control is allowed', async () => {
    const { port, sent } = ports({
      responses: {
        'customer:list_users': [OK],
        'admin:list_users': [OK],
      },
    });
    const result = await runAuthzMatrix(matrix(), port, { maxRequests: 100 });
    const cell = result.cells.find((c) => c.roleId === 'customer' && c.functionId === 'list_users');
    expect(cell).toMatchObject({
      verdict: 'violation',
      actual: 'allow',
      control: 'allow',
      controlRoleId: 'admin',
      flagged: true,
      evidenceRefs: ['ev-1', 'ev-2'],
    });
    expect(sent.filter((r) => r.roleId === 'admin' && r.functionId === 'list_users')).toHaveLength(
      2,
    );
    expect(result.counts.flagged).toBe(1);
  });

  it('marks the cell suspected, not a finding, when the negative control is denied', async () => {
    const { port } = ports({
      responses: { 'customer:list_users': [OK], 'admin:list_users': [REFUSED] },
    });
    const result = await runAuthzMatrix(matrix(), port, { maxRequests: 100 });
    const cell = result.cells.find((c) => c.roleId === 'customer' && c.functionId === 'list_users');
    expect(cell).toMatchObject({
      verdict: 'suspected',
      reason: 'negative_control_missing_or_failed',
      control: 'deny',
      flagged: false,
    });
  });

  it('marks the cell suspected when no control role exists for the function', async () => {
    const m = matrix({
      cells: [
        { roleId: 'customer', functionId: 'list_users', expected: 'deny' },
        { roleId: 'admin', functionId: 'list_users', expected: 'deny' },
      ],
    });
    const { port, sent } = ports({
      responses: { 'customer:list_users': [OK], 'admin:list_users': [OK] },
    });
    const result = await runAuthzMatrix(m, port, { maxRequests: 100 });
    const cell = result.cells.find((c) => c.roleId === 'customer' && c.functionId === 'list_users');
    expect(cell).toMatchObject({ verdict: 'suspected', flagged: false });
    expect(cell?.controlRoleId).toBeUndefined();
    expect(
      sent.filter((r) => r.roleId === 'customer' && r.functionId === 'list_users'),
    ).toHaveLength(1);
  });

  it('flags a mismatch when the matrix allows but the acting role is denied (a functional gap)', async () => {
    const { port } = ports({ responses: { 'admin:list_users': [REFUSED] } });
    const result = await runAuthzMatrix(matrix(), port, { maxRequests: 100 });
    const admin = result.cells.find((c) => c.roleId === 'admin' && c.functionId === 'list_users');
    expect(admin).toMatchObject({
      verdict: 'mismatch',
      reason: 'denied_where_allowed',
      actual: 'deny',
      flagged: true,
    });
    expect(result.counts.mismatch).toBe(1);
  });

  it('treats a soft-deny 200 as ambiguous and surfaces it as suspected, never as a finding', async () => {
    const { port } = ports({
      responses: { 'customer:list_users': [SOFT_DENY], 'admin:list_users': [OK] },
    });
    const result = await runAuthzMatrix(matrix(), port, { maxRequests: 100 });
    const cell = result.cells.find((c) => c.roleId === 'customer' && c.functionId === 'list_users');
    expect(cell).toMatchObject({
      actual: 'ambiguous',
      verdict: 'suspected',
      reason: 'ambiguous_response',
      flagged: false,
    });
    expect(result.counts.ambiguous).toBeGreaterThanOrEqual(1);
  });

  it('does not run a negative control for an expected allow, nor for a denied acting role', async () => {
    const { port, sent } = ports({
      responses: { 'customer:list_users': [REFUSED], 'admin:list_users': [OK] },
    });
    await runAuthzMatrix(matrix(), port, { maxRequests: 100 });
    expect(sent.filter((r) => r.roleId === 'admin' && r.functionId === 'list_users')).toHaveLength(
      1,
    );
  });

  it('uses the object owner as the negative control for an object-level expectation', async () => {
    const m = matrix({
      cells: [
        { roleId: 'customer', functionId: 'view_basket', objectId: 'basket_1', expected: 'allow' },
        { roleId: 'admin', functionId: 'view_basket', objectId: 'basket_1', expected: 'deny' },
      ],
    });
    const { port } = ports({
      responses: { 'admin:view_basket': [OK], 'customer:view_basket': [OK, OK] },
    });
    const result = await runAuthzMatrix(m, port, { maxRequests: 100 });
    const cell = result.cells.find((c) => c.roleId === 'admin' && c.functionId === 'view_basket');
    expect(cell).toMatchObject({
      verdict: 'violation',
      controlRoleId: 'customer',
      control: 'allow',
      flagged: true,
    });
  });
});

describe('runAuthzMatrix: sessions', () => {
  it('marks a cell blocked, with no request, when the acting role has no live session', async () => {
    const { port, sent } = ports({ sessions: { customer: 'expired' } });
    const result = await runAuthzMatrix(matrix(), port, { maxRequests: 100 });
    const cell = result.cells.find((c) => c.roleId === 'customer' && c.functionId === 'list_users');
    expect(cell).toMatchObject({ verdict: 'blocked', reason: 'session_not_live', flagged: false });
    expect(cell?.actual).toBeUndefined();
    expect(sent.some((r) => r.roleId === 'customer' && r.functionId === 'list_users')).toBe(false);
    expect(result.counts.blocked).toBeGreaterThanOrEqual(1);
  });

  it('refreshes an expired session once and replays the cell when the refresh succeeds', async () => {
    const { port, sent } = ports({
      sessions: { customer: 'expired' },
      refresh: { customer: 'live' },
      responses: { 'customer:list_users': [REFUSED] },
    });
    const result = await runAuthzMatrix(matrix(), port, { maxRequests: 100 });
    const cell = result.cells.find((c) => c.roleId === 'customer' && c.functionId === 'list_users');
    expect(cell?.verdict).toBe('pass');
    expect(sent.some((r) => r.roleId === 'customer' && r.functionId === 'list_users')).toBe(true);
  });

  it('stays blocked when the refresh does not restore the session', async () => {
    const { port } = ports({
      sessions: { customer: 'expired' },
      refresh: { customer: 'unavailable' },
    });
    const result = await runAuthzMatrix(matrix(), port, { maxRequests: 100 });
    const cell = result.cells.find((c) => c.roleId === 'customer' && c.functionId === 'list_users');
    expect(cell?.verdict).toBe('blocked');
  });

  it('does not use a negative control whose session is not live', async () => {
    const { port, sent } = ports({
      sessions: { admin: 'unavailable' },
      responses: { 'customer:list_users': [OK] },
    });
    const result = await runAuthzMatrix(matrix(), port, { maxRequests: 100 });
    const cell = result.cells.find((c) => c.roleId === 'customer' && c.functionId === 'list_users');
    expect(cell).toMatchObject({
      verdict: 'suspected',
      reason: 'negative_control_missing_or_failed',
    });
    expect(cell?.control).toBeUndefined();
    expect(sent.some((r) => r.roleId === 'admin')).toBe(false);
  });
});

describe('runAuthzMatrix: budget, chunking, rate limits and kill switch', () => {
  it('stops at the first cell the budget cannot pay for and reports where to resume', async () => {
    const { port, sent } = ports({});
    const result = await runAuthzMatrix(matrix(), port, { maxRequests: 2 });
    expect(sent).toHaveLength(2);
    expect(result.budgetExhausted).toBe(true);
    expect(result.complete).toBe(false);
    // Cells 0 and 1 are paid for; cells 2 and 3 are skipped without a request; cell 4 cannot be paid for.
    expect(result.nextOffset).toBe(4);
    expect(result.requestsUsed).toBe(2);
  });

  it('chunks a large matrix across runs that together cover every cell once', async () => {
    const m = matrix();
    const { port } = ports({});
    const first = await runAuthzMatrix(m, port, { maxRequests: 100, offset: 0, limit: 3 });
    const second = await runAuthzMatrix(m, port, {
      maxRequests: 100,
      offset: first.nextOffset,
      limit: 3,
    });
    const third = await runAuthzMatrix(m, port, {
      maxRequests: 100,
      offset: second.nextOffset,
      limit: 3,
    });
    expect(first.cells).toHaveLength(3);
    expect(second.cells).toHaveLength(3);
    expect(third.cells).toHaveLength(2);
    expect(third.complete).toBe(true);
    const keys = [...first.cells, ...second.cells, ...third.cells].map(
      (c) => `${c.roleId}/${c.functionId}`,
    );
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('backs off on a 429 and retries within the budget', async () => {
    const limited = { status: AUTHZ_RATE_LIMITED_STATUS, body: '' };
    const { port, sleeps, sent } = ports({
      responses: { 'customer:list_users': [limited, limited, OK] },
    });
    const result = await runAuthzMatrix(matrix(), port, {
      maxRequests: 100,
      backoffMs: 10,
      maxRetries: 2,
    });
    const cell = result.cells.find((c) => c.roleId === 'customer' && c.functionId === 'list_users');
    expect(
      sent.filter((r) => r.roleId === 'customer' && r.functionId === 'list_users'),
    ).toHaveLength(3);
    expect(sleeps).toEqual([10, 20]);
    expect(cell?.actual).toBe('allow');
  });

  it('stops retrying a 429 at the retry ceiling and leaves the cell ambiguous', async () => {
    const limited = { status: AUTHZ_RATE_LIMITED_STATUS, body: '' };
    const { port, sent } = ports({
      responses: { 'customer:list_users': [limited, limited, limited, limited] },
    });
    const result = await runAuthzMatrix(matrix(), port, {
      maxRequests: 100,
      backoffMs: 0,
      maxRetries: 1,
    });
    const cell = result.cells.find((c) => c.roleId === 'customer' && c.functionId === 'list_users');
    expect(
      sent.filter((r) => r.roleId === 'customer' && r.functionId === 'list_users'),
    ).toHaveLength(2);
    expect(cell).toMatchObject({ actual: 'ambiguous', verdict: 'suspected' });
  });

  it('charges every 429 retry to the budget so retries cannot overrun it', async () => {
    const limited = { status: AUTHZ_RATE_LIMITED_STATUS, body: '' };
    const { port, sent } = ports({
      responses: { 'customer:list_users': [limited, limited, limited] },
    });
    const result = await runAuthzMatrix(matrix(), port, {
      maxRequests: 2,
      backoffMs: 0,
      maxRetries: 5,
    });
    expect(sent).toHaveLength(2);
    expect(result.budgetExhausted).toBe(true);
    expect(result.nextOffset).toBe(0);
    expect(result.cells).toHaveLength(0);
  });

  it('stops before the next cell when the kill switch is pulled, sending nothing further', async () => {
    const controller = new AbortController();
    const { port, cells, sent } = ports({});
    const killable: AuthzEnginePorts = {
      ...port,
      onCell: (cell) => {
        cells.push(cell);
        if (cells.length === 1) controller.abort();
      },
    };
    const result = await runAuthzMatrix(matrix(), killable, {
      maxRequests: 100,
      signal: controller.signal,
    });
    expect(result.aborted).toBe(true);
    expect(result.complete).toBe(false);
    expect(result.cells).toHaveLength(1);
    expect(result.nextOffset).toBe(1);
    expect(sent).toHaveLength(1);
  });

  it('sends nothing when the kill switch is already set', async () => {
    const controller = new AbortController();
    controller.abort();
    const { port, sent } = ports({});
    const result = await runAuthzMatrix(matrix(), port, {
      maxRequests: 100,
      signal: controller.signal,
    });
    expect(result.aborted).toBe(true);
    expect(result.cells).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it('rejects a malformed budget or chunk before any request is sent', async () => {
    const { port, sent } = ports({});
    await expect(runAuthzMatrix(matrix(), port, { maxRequests: -1 })).rejects.toThrow(
      /authz engine options are invalid/,
    );
    await expect(runAuthzMatrix(matrix(), port, { maxRequests: 10, limit: 0 })).rejects.toThrow(
      /authz engine options are invalid/,
    );
    expect(sent).toHaveLength(0);
  });
});

describe('runAuthzMatrix: evidence and privacy', () => {
  it('records no response body in a cell result, only the role, function, outcome and evidence refs', async () => {
    const secret = 'sk-live-THIS-MUST-NOT-APPEAR';
    const { port, cells } = ports({
      responses: { 'customer:list_users': [{ status: 200, body: secret }] },
    });
    const result = await runAuthzMatrix(matrix(), port, { maxRequests: 100 });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(cells)).not.toContain(secret);
  });
});
