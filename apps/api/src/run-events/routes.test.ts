import { afterEach, describe, expect, it } from 'vitest';

import {
  bearer,
  closeAll,
  DEFAULT_LIMITS,
  eventItem,
  FOREIGN_RUN_ID,
  OTHER_RUN_ID,
  openStream,
  request,
  RUN_ID,
  runEvent,
  serve,
  TENANT_A,
  TENANT_B,
  until,
} from './fixtures.test-helpers.js';

const path = (runId: string = RUN_ID): string => `/v1/runs/${runId}/events`;
const READER = bearer('reader');

afterEach(async () => {
  await closeAll();
});

describe('refusals before the stream opens (RFC 9457, no stream, no subscription)', () => {
  it('answers 401 without a credential and never touches the bus', async () => {
    const h = await serve();
    const res = await request(h.base, path());
    expect(res.status).toBe(401);
    expect(res.contentType).toContain('application/problem+json');
    expect(JSON.parse(res.body)).toMatchObject({ status: 401, code: 'UNAUTHENTICATED' });
    expect(h.buses.size).toBe(0);
  });

  it('answers 403 when the caller has no tenant context', async () => {
    const h = await serve();
    const res = await request(h.base, path(), bearer('tenantless'));
    expect(res.status).toBe(403);
    expect(JSON.parse(res.body)).toMatchObject({ code: 'TENANT_CONTEXT_MISSING' });
    expect(h.buses.size).toBe(0);
  });

  it('answers 403 without run:read and never reads the run', async () => {
    const h = await serve();
    const res = await request(h.base, path(), bearer('nobody'));
    expect(res.status).toBe(403);
    expect(JSON.parse(res.body)).toMatchObject({ code: 'FORBIDDEN' });
    expect(h.buses.size).toBe(0);
  });

  it('answers 403 for a run of another tenant, the same as for a run that does not exist (no oracle)', async () => {
    const h = await serve();
    const foreign = await request(h.base, path(FOREIGN_RUN_ID), READER);
    const missing = await request(h.base, path('01890a5d-ac96-774b-bcce-b30209999999'), READER);
    expect(foreign.status).toBe(403);
    expect(missing.status).toBe(403);
    // Only the per-response trace id may differ.
    const withoutTrace = (body: string): Record<string, unknown> => {
      const parsed = JSON.parse(body) as Record<string, unknown>;
      delete parsed.traceId;
      return parsed;
    };
    expect(withoutTrace(foreign.body)).toEqual(withoutTrace(missing.body));
    expect(h.bus(TENANT_A).subscriptions).toHaveLength(0);
  });

  it('refuses a run row that comes back under another tenant (defence in depth)', async () => {
    const h = await serve({
      rows: [],
      foreign: [{ id: RUN_ID, tenantId: TENANT_B, state: 'executing' }],
    });
    const res = await request(h.base, path(), READER);
    expect(res.status).toBe(403);
    expect(h.buses.size).toBe(0);
  });

  it.each([
    ['not a uuid', '/v1/runs/not-a-run/events'],
    ['an uppercase uuid', `/v1/runs/${RUN_ID.toUpperCase()}/events`],
    ['a uuid v4', '/v1/runs/0190a5d0-0000-4000-8000-00000000000a/events'],
  ])('answers 422 for a run id that is %s', async (_label, url) => {
    const h = await serve();
    const res = await request(h.base, url, READER);
    expect(res.status).toBe(422);
    expect(JSON.parse(res.body)).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(h.buses.size).toBe(0);
  });

  it.each(['abc', '1-2-3', '$', '0 0'])('answers 422 for a Last-Event-ID of %j', async (cursor) => {
    const h = await serve();
    const res = await request(h.base, path(), { ...READER, 'last-event-id': cursor });
    expect(res.status).toBe(422);
    expect(h.bus(TENANT_A).subscriptions).toHaveLength(0);
  });

  it('answers 422 for a repeated lastEventId query', async () => {
    const h = await serve();
    const res = await request(h.base, `${path()}?lastEventId=1-0&lastEventId=2-0`, READER);
    expect(res.status).toBe(422);
    expect(h.bus(TENANT_A).subscriptions).toHaveLength(0);
  });

  it('answers 429 when the tenant is at its stream cap, and frees the slot when a stream closes', async () => {
    const h = await serve({ limits: { maxConnectionsPerTenant: 1 } });
    const first = await openStream(h.base, path(), READER);
    expect(first.status).toBe(200);
    await until(() => h.bus(TENANT_A).subscriptions.length === 1);

    const refused = await request(h.base, path(), READER);
    expect(refused.status).toBe(429);
    expect(JSON.parse(refused.body)).toMatchObject({ code: 'RATE_LIMITED' });

    first.close();
    await until(() => h.metrics.calls.some((c) => c.startsWith('closed:')));
    const second = await openStream(h.base, path(), READER);
    expect(second.status).toBe(200);
    second.close();
  });
});

describe('the live stream', () => {
  it('opens as text/event-stream with buffering switched off, and forwards each run event as a frame', async () => {
    const h = await serve();
    const stream = await openStream(h.base, path(), READER);
    expect(stream.status).toBe(200);
    expect(stream.headers.get('content-type')).toContain('text/event-stream');
    expect(stream.headers.get('cache-control')).toContain('no-cache');
    expect(stream.headers.get('x-accel-buffering')).toBe('no');

    await until(() => h.bus(TENANT_A).subscriptions.length === 1);
    const subscription = h.bus(TENANT_A).subscriptions[0];
    expect(subscription?.runId).toBe(RUN_ID);
    expect(subscription?.options?.fromId).toBe('$');

    h.bus(TENANT_A).push(
      eventItem('1700000000000-0', runEvent(1, 'message.partial', { text: 'hi' })),
    );
    await stream.waitFor('id: 1700000000000-0\nevent: message.partial\n');
    expect(stream.text()).toContain('"text":"hi"');
    stream.close();
  });

  it('uses the Last-Event-ID header as the resume cursor and checks the replay size against the cap', async () => {
    const h = await serve();
    h.bus(TENANT_A).countResult = 2;
    const stream = await openStream(h.base, path(), {
      ...READER,
      'last-event-id': '1700000000000-4',
    });
    expect(stream.status).toBe(200);
    await until(() => h.bus(TENANT_A).subscriptions.length === 1);
    expect(h.bus(TENANT_A).counts).toEqual([
      { runId: RUN_ID, fromId: '1700000000000-4', limit: DEFAULT_LIMITS.maxReplay + 1 },
    ]);
    expect(h.bus(TENANT_A).subscriptions[0]?.options?.fromId).toBe('1700000000000-4');
    stream.close();
  });

  it('answers resync and closes when the missed events exceed the replay cap', async () => {
    const h = await serve();
    h.bus(TENANT_A).countResult = DEFAULT_LIMITS.maxReplay + 1;
    const stream = await openStream(h.base, path(), { ...READER, 'last-event-id': '1-0' });
    await stream.waitFor('event: resync');
    expect(stream.text()).toContain('{"reason":"replay_limit"}');
    await stream.ended;
    expect(h.bus(TENANT_A).subscriptions).toHaveLength(0);
    expect(h.metrics.calls).toContain('resync:replay_limit');
  });

  it('answers resync when the cursor was trimmed away (the bus reports a truncated marker)', async () => {
    const h = await serve();
    const stream = await openStream(h.base, path(), READER);
    await until(() => h.bus(TENANT_A).subscriptions.length === 1);
    h.bus(TENANT_A).push({ kind: 'truncated', reason: 'trimmed', requestedId: '1-0' });
    await stream.waitFor('event: resync');
    expect(stream.text()).toContain('{"reason":"trimmed"}');
    await stream.ended;
    expect(h.metrics.calls).toContain('resync:trimmed');
  });

  it('answers resync and counts the drop when a slow consumer lost events (gap marker)', async () => {
    const h = await serve();
    const stream = await openStream(h.base, path(), READER);
    await until(() => h.bus(TENANT_A).subscriptions.length === 1);
    h.bus(TENANT_A).push({ kind: 'gap', dropped: 7, fromId: '1-0', toId: '7-0' });
    await stream.waitFor('event: resync');
    expect(stream.text()).toContain('{"reason":"slow_consumer"}');
    await stream.ended;
    expect(h.metrics.calls).toEqual(expect.arrayContaining(['dropped:7', 'resync:slow_consumer']));
  });

  it('ends with the terminal state when a run event carries a terminal state (kill mid-stream)', async () => {
    const h = await serve();
    const stream = await openStream(h.base, path(), READER);
    await until(() => h.bus(TENANT_A).subscriptions.length === 1);
    h.bus(TENANT_A).push(eventItem('1-0', runEvent(1, 'run.state', { state: 'killed' })));
    await stream.waitFor('event: end');
    expect(stream.text()).toContain('event: end\ndata: {"state":"killed"}');
    await stream.ended;
  });

  it('does not end on a non-terminal state', async () => {
    const h = await serve();
    const stream = await openStream(h.base, path(), READER);
    await until(() => h.bus(TENANT_A).subscriptions.length === 1);
    h.bus(TENANT_A).push(eventItem('1-0', runEvent(1, 'run.state', { state: 'paused' })));
    await stream.waitFor('event: run.state');
    expect(stream.text()).not.toContain('event: end');
    stream.close();
  });

  it('closes the subscription when the client disconnects, and frees the connection slot', async () => {
    const h = await serve({ limits: { maxConnectionsPerTenant: 1 } });
    const stream = await openStream(h.base, path(), READER);
    await until(() => h.bus(TENANT_A).subscriptions.length === 1);
    const signal = h.bus(TENANT_A).subscriptions[0]?.options?.signal;
    expect(signal?.aborted).toBe(false);
    stream.close();
    await until(() => signal?.aborted === true, 10_000);
    await until(() => h.metrics.calls.some((c) => c.startsWith('closed:')), 10_000);
  });

  it('writes a heartbeat comment while the stream is idle', async () => {
    const h = await serve({ limits: { heartbeatMs: 10 } });
    const stream = await openStream(h.base, path(), READER);
    await stream.waitFor(': heartbeat\n\n');
    expect(stream.status).toBe(200);
    stream.close();
  });

  it('ends with event: timeout after the maximum stream duration', async () => {
    const h = await serve({ limits: { maxDurationMs: 20 } });
    const stream = await openStream(h.base, path(), READER);
    await stream.waitFor('event: timeout');
    expect(stream.text()).toContain('{"reason":"max_duration"}');
    await stream.ended;
  });

  it('sends event: error and closes when the event source fails mid-stream', async () => {
    const h = await serve();
    const stream = await openStream(h.base, path(), READER);
    await until(() => h.bus(TENANT_A).subscriptions.length === 1);
    h.bus(TENANT_A).subscriptions[0]?.options?.onError?.(new Error('connection reset'));
    await stream.waitFor('event: error');
    expect(stream.text()).toContain('{"reason":"stream_unavailable"}');
    await stream.ended;
  });

  it('sends event: error when the replay cannot be read, without leaking the cause', async () => {
    const h = await serve();
    h.bus(TENANT_A).countResult = new Error('valkey is down at 10.0.0.5');
    const stream = await openStream(h.base, path(), { ...READER, 'last-event-id': '1-0' });
    await stream.waitFor('event: error');
    expect(stream.text()).toContain('{"reason":"stream_failed"}');
    expect(stream.text()).not.toContain('10.0.0.5');
    await stream.ended;
  });

  it('answers a finished run with its state and end, without opening a subscription', async () => {
    const h = await serve();
    const stream = await openStream(h.base, path(OTHER_RUN_ID), READER);
    expect(stream.status).toBe(200);
    await stream.waitFor('event: end');
    expect(stream.text()).toContain('event: state\ndata: {"state":"completed"}');
    expect(stream.text()).toContain('event: end\ndata: {"state":"completed"}');
    await stream.ended;
    expect(h.bus(TENANT_A).subscriptions).toHaveLength(0);
  });

  it('keeps tenants apart: each tenant reads only from its own bus', async () => {
    const h = await serve({
      rows: [
        { id: RUN_ID, tenantId: TENANT_A, state: 'executing' },
        {
          id: FOREIGN_RUN_ID,
          tenantId: TENANT_B,
          state: 'executing',
        },
      ],
    });
    const stream = await openStream(h.base, path(), READER);
    await until(() => h.bus(TENANT_A).subscriptions.length === 1);
    expect(h.buses.has(TENANT_B)).toBe(false);
    stream.close();
  });
});
