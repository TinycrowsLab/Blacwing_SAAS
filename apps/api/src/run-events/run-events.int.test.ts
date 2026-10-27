import { randomUUID } from 'node:crypto';

import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AuthError } from '@blackwing/errors';
import { createEventBus, type EventBus } from '@blackwing/events';
import { createLogger } from '@blackwing/logger';
import { type ValkeyHandle, withValkey } from '@blackwing/testing/containers';
import { surfaceContainerLogsOnFailure } from '@blackwing/testing/vitest';

import {
  bearer,
  DEFAULT_LIMITS,
  FakeRunReader,
  openStream,
  RecordingMetrics,
  request,
  RUN_ID,
  run,
  runEvent,
  until,
} from './fixtures.test-helpers.js';
import { registerRunEventRoutes, type RunEventsStreamLimits } from './routes.js';

// Runs against a real Valkey (Testcontainers): the `*.int.test.ts` mechanism, `pnpm --filter @blackwing/api test:int`.
let valkey: ValkeyHandle | undefined;
let redis: ReturnType<ValkeyHandle['createClient']>;

beforeAll(async () => {
  valkey = await withValkey();
  redis = valkey.createClient();
});
afterAll(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await valkey?.stop();
});
surfaceContainerLogsOnFailure(() => [valkey]);

const apps: FastifyInstance[] = [];
const PUBLISH_RETRY_MS = 50;
const PUBLISH_ATTEMPTS = 60;

interface Server {
  readonly base: string;
  /** The publisher side: what the workflow writes into the run's stream. */
  readonly publisher: EventBus;
  readonly metrics: RecordingMetrics;
}

/**
 * A real API surface for one tenant: the bearer token is the tenant id. Every tenant gets fresh ids, so
 * tests never share a Valkey key.
 */
async function server(
  tenant: string,
  limits: Partial<RunEventsStreamLimits> = {},
): Promise<Server> {
  const app = Fastify({ logger: false });
  apps.push(app);
  const metrics = new RecordingMetrics();
  registerRunEventRoutes(app, {
    authenticate: (request) => {
      const token = /^Bearer (\S+)$/.exec(request.headers.authorization ?? '')?.[1];
      if (token === undefined) return Promise.reject(new AuthError('no credential'));
      return Promise.resolve({
        type: 'user',
        id: 'u-int',
        tenantId: token,
        roles: ['appsec_engineer'],
      });
    },
    runs: new FakeRunReader([run(RUN_ID, tenant, 'executing')]),
    buses: (tenantId) => createEventBus({ redis, tenantId, blockMs: 100 }),
    limits: { ...DEFAULT_LIMITS, ...limits },
    metrics,
    logger: createLogger('run-events-int', { level: 'fatal', nodeEnv: 'test' }),
    environment: 'test',
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    base: `http://127.0.0.1:${String(port)}`,
    publisher: createEventBus({ redis, tenantId: tenant, blockMs: 100 }),
    metrics,
  };
}

/** The stream ids a body carries, in order. */
const idsIn = (body: string): string[] => [...body.matchAll(/^id: (.+)$/gm)].map((m) => m[1] ?? '');

const path = `/v1/runs/${RUN_ID}/events`;

describe('run event stream over Valkey', () => {
  it('replays from Last-Event-ID with no gaps and no duplicates', async () => {
    const tenant = randomUUID();
    const s = await server(tenant);
    const first = await s.publisher.publish(RUN_ID, runEvent(1));
    const second = await s.publisher.publish(RUN_ID, runEvent(2));
    const third = await s.publisher.publish(RUN_ID, runEvent(3));

    const stream = await openStream(s.base, path, { ...bearer(tenant), 'last-event-id': first });
    expect(stream.status).toBe(200);
    await stream.waitFor(`id: ${third}\n`);
    expect(idsIn(stream.text())).toEqual([second, third]);
    stream.close();
  });

  it('delivers live events published after the stream opened', async () => {
    const tenant = randomUUID();
    const s = await server(tenant);
    const stream = await openStream(s.base, path, bearer(tenant));
    // The subscription starts at the newest entry when it attaches, so publish until the frame arrives.
    const marker = `live-${randomUUID()}`;
    for (
      let attempt = 0;
      attempt < PUBLISH_ATTEMPTS && !stream.text().includes(marker);
      attempt += 1
    ) {
      await s.publisher.publish(RUN_ID, runEvent(attempt + 1, 'message.partial', { marker }));
      await new Promise((resolve) => setTimeout(resolve, PUBLISH_RETRY_MS));
    }
    await stream.waitFor(marker);
    expect(stream.text()).toContain('event: message.partial');
    stream.close();
  });

  it('answers resync trimmed when the resume cursor was trimmed away', async () => {
    const tenant = randomUUID();
    const s = await server(tenant);
    const oldest = await s.publisher.publish(RUN_ID, runEvent(1));
    for (let seq = 2; seq <= 5; seq += 1) await s.publisher.publish(RUN_ID, runEvent(seq));
    await s.publisher.trim(RUN_ID, { maxLen: 2 });

    const stream = await openStream(s.base, path, { ...bearer(tenant), 'last-event-id': oldest });
    await stream.waitFor('event: resync');
    expect(stream.text()).toContain('{"reason":"trimmed"}');
    await stream.ended;
    expect(s.metrics.calls).toContain('resync:trimmed');
  });

  it('answers resync replay_limit when more events were missed than API_SSE_MAX_REPLAY', async () => {
    const tenant = randomUUID();
    const s = await server(tenant, { maxReplay: 2 });
    const first = await s.publisher.publish(RUN_ID, runEvent(1));
    for (let seq = 2; seq <= 4; seq += 1) await s.publisher.publish(RUN_ID, runEvent(seq));

    const stream = await openStream(s.base, path, { ...bearer(tenant), 'last-event-id': first });
    await stream.waitFor('{"reason":"replay_limit"}');
    await stream.ended;
    expect(idsIn(stream.text())).toEqual([]);
  });

  it('ends the stream when a run event reports a terminal state (kill mid-stream)', async () => {
    const tenant = randomUUID();
    const s = await server(tenant);
    const stream = await openStream(s.base, path, bearer(tenant));
    for (
      let attempt = 0;
      attempt < PUBLISH_ATTEMPTS && !stream.text().includes('event: end');
      attempt += 1
    ) {
      await s.publisher.publish(RUN_ID, runEvent(attempt + 1, 'run.state', { state: 'killed' }));
      await new Promise((resolve) => setTimeout(resolve, PUBLISH_RETRY_MS));
    }
    await stream.waitFor('event: end\ndata: {"state":"killed"}');
    await stream.ended;
    expect(stream.text()).toContain('event: end');
  });

  it("never carries another tenant's events on the same run id", async () => {
    const tenant = randomUUID();
    const other = randomUUID();
    const s = await server(tenant);
    const otherPublisher = createEventBus({ redis, tenantId: other, blockMs: 100 });
    const stream = await openStream(s.base, path, bearer(tenant));
    const otherMarker = `other-${randomUUID()}`;
    await otherPublisher.publish(RUN_ID, runEvent(1, 'message.partial', { marker: otherMarker }));

    const ownMarker = `own-${randomUUID()}`;
    for (
      let attempt = 0;
      attempt < PUBLISH_ATTEMPTS && !stream.text().includes(ownMarker);
      attempt += 1
    ) {
      await s.publisher.publish(
        RUN_ID,
        runEvent(attempt + 1, 'message.partial', { marker: ownMarker }),
      );
      await new Promise((resolve) => setTimeout(resolve, PUBLISH_RETRY_MS));
    }
    await stream.waitFor(ownMarker);
    expect(stream.text()).not.toContain(otherMarker);
    stream.close();
  });

  it('answers 429 once the tenant holds its maximum number of open streams', async () => {
    const tenant = randomUUID();
    const s = await server(tenant, { maxConnectionsPerTenant: 1 });
    const open = await openStream(s.base, path, bearer(tenant));
    expect(open.status).toBe(200);
    await until(() => s.metrics.calls.some((c) => c.startsWith('opened:')));

    const refused = await request(s.base, path, bearer(tenant));
    expect(refused.status).toBe(429);
    open.close();
  });
});
