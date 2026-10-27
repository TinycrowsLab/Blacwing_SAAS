import Fastify, { type FastifyInstance } from 'fastify';

import { AuthError } from '@blackwing/errors';
import { createLogger } from '@blackwing/logger';

import { type RunEventsStreamLimits, registerRunEventRoutes } from './routes.js';

import type { RunEventsMetrics } from './metrics.js';
import type { RunEventsPrincipal, RunEventsRunReader, RunEventsRunRecord } from './ports.js';
import type { RunEvent, RunState } from '@blackwing/contracts';
import type { EventBus, SubscribeOptions, SubscriptionItem } from '@blackwing/events';

export const TENANT_A = '0190a5d0-0000-7000-8000-00000000000a';
export const TENANT_B = '0190a5d0-0000-7000-8000-00000000000b';
export const RUN_ID = '01890a5d-ac96-774b-bcce-b302099a8058';
export const OTHER_RUN_ID = '01890a5d-ac96-774b-bcce-b302099a8059';
export const FOREIGN_RUN_ID = '01890a5d-ac96-774b-bcce-b302099a8060';

/** How often the helpers re-check a condition. */
const POLL_MS = 5;

export const DEFAULT_LIMITS: RunEventsStreamLimits = {
  heartbeatMs: 60_000,
  maxDurationMs: 60_000,
  maxReplay: 3,
  maxConnectionsPerTenant: 100,
};

/** A run event as the bus delivers it. */
export function runEvent(
  seq: number,
  type = 'message.partial',
  payload: Record<string, unknown> = {},
): RunEvent {
  return { type, ts: '2026-10-20T10:00:00.000Z', seq, payload };
}

/** A live subscription item: a run event with its stream id. */
export function eventItem(id: string, event: RunEvent): SubscriptionItem {
  return { kind: 'event', id, event };
}

/**
 * An in-memory event bus for the stream route. Items pushed with `push` reach the open subscription;
 * the subscription ends when its signal aborts, as the real bus does. `countAfter` answers `countResult`.
 */
class FakeEventBus implements EventBus {
  readonly subscriptions: {
    readonly runId: string;
    readonly options: SubscribeOptions | undefined;
  }[] = [];
  readonly counts: { readonly runId: string; readonly fromId: string; readonly limit: number }[] =
    [];
  countResult: number | Error = 0;
  readonly #queue: SubscriptionItem[] = [];
  #waiters: (() => void)[] = [];

  constructor(readonly tenantId: string) {}

  push(item: SubscriptionItem): void {
    this.#queue.push(item);
    for (const wake of this.#waiters.splice(0)) wake();
  }

  subscribe(runId: string, options?: SubscribeOptions): AsyncIterableIterator<SubscriptionItem> {
    this.subscriptions.push({ runId, options });
    return this.#items(options?.signal);
  }

  async *#items(
    signal: AbortSignal | undefined,
  ): AsyncGenerator<SubscriptionItem, void, undefined> {
    for (;;) {
      if (signal?.aborted === true) return;
      const next = this.#queue.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      await new Promise<void>((resolve) => {
        this.#waiters.push(resolve);
        signal?.addEventListener(
          'abort',
          () => {
            resolve();
          },
          { once: true },
        );
      });
    }
  }

  countAfter(runId: string, fromId: string, limit: number): Promise<number> {
    this.counts.push({ runId, fromId, limit });
    if (this.countResult instanceof Error) return Promise.reject(this.countResult);
    return Promise.resolve(Math.min(this.countResult, limit));
  }

  publish(): Promise<string> {
    throw new Error('the stream route never publishes');
  }
  consume(): AsyncIterableIterator<never> {
    throw new Error('the stream route never consumes groups');
  }
  ack(): Promise<number> {
    throw new Error('the stream route never acks');
  }
  trim(): Promise<number> {
    throw new Error('the stream route never trims');
  }
  expire(): Promise<boolean> {
    throw new Error('the stream route never expires streams');
  }
  remove(): Promise<boolean> {
    throw new Error('the stream route never removes streams');
  }
}

/** Runs keyed by tenant and id. `foreign` lets a test return a row that belongs to another tenant. */
export class FakeRunReader implements RunEventsRunReader {
  readonly #rows: RunEventsRunRecord[];
  readonly #foreign: RunEventsRunRecord[];

  constructor(rows: readonly RunEventsRunRecord[], foreign: readonly RunEventsRunRecord[] = []) {
    this.#rows = [...rows];
    this.#foreign = [...foreign];
  }

  getRun(tenantId: string, runId: string): Promise<RunEventsRunRecord | null> {
    const row = this.#rows.find((r) => r.tenantId === tenantId && r.id === runId);
    const foreign = this.#foreign.find((r) => r.id === runId);
    return Promise.resolve(row ?? foreign ?? null);
  }
}

export function run(
  id: string,
  tenantId: string,
  state: RunState = 'executing',
): RunEventsRunRecord {
  return { id, tenantId, state };
}

/** Metrics that record their calls, for assertions. */
export class RecordingMetrics implements RunEventsMetrics {
  readonly calls: string[] = [];
  connectionOpened(tenant: string): void {
    this.calls.push(`opened:${tenant}`);
  }
  connectionClosed(tenant: string): void {
    this.calls.push(`closed:${tenant}`);
  }
  eventSent(): void {
    this.calls.push('sent');
  }
  dropped(count: number): void {
    this.calls.push(`dropped:${String(count)}`);
  }
  resync(reason: string): void {
    this.calls.push(`resync:${reason}`);
  }
}

/** Bearer tokens the fake authenticator knows. Anything else is refused as unauthenticated. */
const TOKENS: Readonly<Record<string, RunEventsPrincipal>> = {
  reader: { type: 'user', id: 'u-reader', tenantId: TENANT_A, roles: ['appsec_engineer'] },
  developer: { type: 'user', id: 'u-dev', tenantId: TENANT_A, roles: ['developer'] },
  nobody: { type: 'user', id: 'u-none', tenantId: TENANT_A, roles: [] },
  tenantless: { type: 'user', id: 'u-x', tenantId: null, roles: ['org_admin'] },
  other: { type: 'user', id: 'u-b', tenantId: TENANT_B, roles: ['org_admin'] },
};

export interface Harness {
  readonly app: FastifyInstance;
  readonly base: string;
  readonly buses: Map<string, FakeEventBus>;
  readonly metrics: RecordingMetrics;
  bus(tenantId?: string): FakeEventBus;
}

export interface HarnessOptions {
  readonly rows?: readonly RunEventsRunRecord[];
  readonly foreign?: readonly RunEventsRunRecord[];
  readonly limits?: Partial<RunEventsStreamLimits>;
}

/** A real HTTP server with the stream route mounted, so the frames are the ones a client reads. */
export async function serve(options: HarnessOptions = {}): Promise<Harness> {
  const app = Fastify({ logger: false });
  const buses = new Map<string, FakeEventBus>();
  const metrics = new RecordingMetrics();
  const runs = new FakeRunReader(
    options.rows ?? [
      run(RUN_ID, TENANT_A, 'executing'),
      run(OTHER_RUN_ID, TENANT_A, 'completed'),
      run(FOREIGN_RUN_ID, TENANT_B, 'executing'),
    ],
    options.foreign ?? [],
  );
  const busFor = (tenantId: string): FakeEventBus => {
    let bus = buses.get(tenantId);
    if (bus === undefined) {
      bus = new FakeEventBus(tenantId);
      buses.set(tenantId, bus);
    }
    return bus;
  };
  registerRunEventRoutes(app, {
    authenticate: (request) => {
      const token = /^Bearer (\w+)$/.exec(request.headers.authorization ?? '')?.[1];
      const principal = token === undefined ? undefined : TOKENS[token];
      if (principal === undefined) return Promise.reject(new AuthError('no valid credential'));
      return Promise.resolve(principal);
    },
    runs,
    buses: busFor,
    limits: { ...DEFAULT_LIMITS, ...options.limits },
    metrics,
    logger: createLogger('run-events-test', { level: 'fatal', nodeEnv: 'test' }),
    environment: 'test',
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  openApps.push(app);
  return {
    app,
    base: `http://127.0.0.1:${String(port)}`,
    buses,
    metrics,
    bus: (tenantId = TENANT_A) => busFor(tenantId),
  };
}

const openApps: FastifyInstance[] = [];

export async function closeAll(): Promise<void> {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
}

export const bearer = (token: string): Record<string, string> => ({
  authorization: `Bearer ${token}`,
});

export interface Stream {
  readonly status: number;
  readonly headers: Headers;
  /** Every byte received so far. */
  text(): string;
  /** Resolves once the body contains `needle`; rejects after `timeoutMs`. */
  waitFor(needle: string, timeoutMs?: number): Promise<void>;
  /** Resolves when the server ends the response. */
  readonly ended: Promise<void>;
  /** Client disconnect. */
  close(): void;
}

/** Opens a stream and reads its body in the background. */
export async function openStream(
  base: string,
  path: string,
  headers: Record<string, string> = {},
): Promise<Stream> {
  const controller = new AbortController();
  const response = await fetch(`${base}${path}`, { headers, signal: controller.signal });
  let body = '';
  const decoder = new TextDecoder();
  const reader = response.body?.getReader();
  const ended =
    reader === undefined
      ? Promise.resolve()
      : (async (): Promise<void> => {
          for (;;) {
            const chunk: { readonly done: boolean; readonly value?: Uint8Array } =
              await reader.read();
            if (chunk.done || chunk.value === undefined) return;
            body += decoder.decode(chunk.value, { stream: true });
          }
        })().catch(() => undefined);
  return {
    status: response.status,
    headers: response.headers,
    text: () => body,
    waitFor: async (needle, timeoutMs = 2_000) => {
      const deadline = Date.now() + timeoutMs;
      while (!body.includes(needle)) {
        if (Date.now() > deadline)
          throw new Error(
            `timed out waiting for ${JSON.stringify(needle)} in ${JSON.stringify(body)}`,
          );
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      }
    },
    ended,
    close: () => {
      controller.abort();
    },
  };
}

/** A plain (non-stream) request, for the refusals that answer before the stream opens. */
export async function request(
  base: string,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; contentType: string | null; body: string }> {
  const response = await fetch(`${base}${path}`, { headers });
  return {
    status: response.status,
    contentType: response.headers.get('content-type'),
    body: await response.text(),
  };
}

/** Waits until `predicate` holds or the timeout passes. */
export async function until(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}
