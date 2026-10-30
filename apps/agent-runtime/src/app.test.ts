import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AGENT_BRIEF_MAX_BYTES, AGENT_SESSION_RECORD_SUFFIX } from '@blackwing/contracts';
import { createLogger } from '@blackwing/logger';

import { runMain, type AppDeps } from './app.js';
import { DESCRIPTOR_FILE_MAX_BYTES } from './descriptor.js';
import { EXIT_CODES, type RunQuery, type SessionStreamMessage } from './session/run-session.js';

import type { AddressInfo } from 'node:net';

const TENANT = '01920000-0000-7000-8000-000000000001';
const RUN = '01920000-0000-7000-8000-000000000002';
const SESSION = '01920000-0000-7000-8000-000000000003';
const SHA = 'd'.repeat(64);
const TOKEN = 'bwrun_c2VjcmV0LXRva2VuLXZhbHVl.c2lnbmF0dXJl';

interface Recorded {
  readonly method: string;
  readonly url: string;
  readonly authorization: string | undefined;
  readonly body: unknown;
}

interface StubBroker {
  readonly url: string;
  readonly requests: Recorded[];
  close(): Promise<void>;
}

/** A real HTTP stub of the Run Broker: answers the state read and the session write, and records both. */
async function startBroker(
  options: { active?: boolean; stateStatus?: number; recordStatus?: number } = {},
): Promise<StubBroker> {
  const requests: Recorded[] = [];
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      const url = req.url ?? '';
      requests.push({
        method: req.method ?? '',
        url,
        authorization: req.headers.authorization,
        body: text === '' ? undefined : JSON.parse(text),
      });
      if (url.endsWith('/state')) {
        res.writeHead(options.stateStatus ?? 200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            runId: RUN,
            state: 'executing',
            active: options.active ?? true,
            observedAt: '2026-10-29T10:00:00.000Z',
          }),
        );
        return;
      }
      if (url.endsWith(`/${AGENT_SESSION_RECORD_SUFFIX}`)) {
        res.writeHead(options.recordStatus ?? 201, { 'content-type': 'application/json' });
        res.end('{}');
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"code":"NOT_FOUND"}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(port)}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      }),
  };
}

function descriptor(baseUrl: string, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    runId: RUN,
    sessionId: SESSION,
    tenantId: TENANT,
    persona: 'planner',
    personaVersion: '1.0.0',
    promptSha256: SHA,
    model: 'claude-haiku-5-5',
    effort: 'low',
    maxTurns: 10,
    maxBudgetUsd: 1,
    allowedTools: ['Read'],
    disallowedTools: [],
    brief: 'Plan the next subtask. ✓',
    envelopeHash: SHA,
    brokerBaseUrl: baseUrl,
    brokerToken: TOKEN,
    modelGatewayBaseUrl: 'http://model-gateway.internal:8443',
    virtualKeyRef: 'vk-run-1',
    caBundlePath: '/etc/bw/ca.pem',
    workspaceDir: '/workspace/a',
    ...overrides,
  });
}

function quietLog(): AppDeps['log'] {
  return createLogger('agent-runtime-test', { destination: { write: () => undefined } });
}

/** An async iterable whose first step rejects with `error`, like an SDK stream that fails at start. */
function failingStream(error: Error): AsyncIterable<never> {
  return { [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(error) }) };
}

async function* resultStream(): AsyncGenerator<SessionStreamMessage> {
  await Promise.resolve();
  yield { type: 'result', subtype: 'success', num_turns: 2, total_cost_usd: 0.01, modelUsage: {} };
}

/** A `RunQuery` that records each start (prompt and disallowed tools) and then yields a success result. */
function recordingQuery(): RunQuery & { calls: { prompt: string; disallowed: string[] }[] } {
  const calls: { prompt: string; disallowed: string[] }[] = [];
  const runQuery: RunQuery = (input) => {
    calls.push({ prompt: input.prompt, disallowed: [...(input.options.disallowedTools ?? [])] });
    return resultStream();
  };
  return Object.assign(runQuery, { calls });
}

describe('runMain', () => {
  let dir: string;
  let broker: StubBroker | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'bw-agent-runtime-'));
  });

  afterEach(async () => {
    if (broker !== undefined) await broker.close();
    broker = undefined;
    await rm(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  async function writeDescriptor(content: string): Promise<Record<string, string>> {
    const path = join(dir, 'descriptor.json');
    await writeFile(path, content, 'utf8');
    return { BW_SESSION_DESCRIPTOR: path };
  }

  it('exits 2 without any call when BW_SESSION_DESCRIPTOR is unset', async () => {
    const runQuery = recordingQuery();
    const code = await runMain({}, { log: quietLog(), runQuery, sdkVersion: '0.3.308' });
    expect(code).toBe(EXIT_CODES.descriptorInvalid);
    expect(runQuery.calls).toHaveLength(0);
  });

  it('exits 2 when the descriptor file does not exist', async () => {
    const runQuery = recordingQuery();
    const code = await runMain(
      { BW_SESSION_DESCRIPTOR: join(dir, 'missing.json') },
      { log: quietLog(), runQuery, sdkVersion: '0.3.308' },
    );
    expect(code).toBe(EXIT_CODES.descriptorInvalid);
    expect(runQuery.calls).toHaveLength(0);
  });

  it('exits 2 on malformed JSON and on a file over the size cap', async () => {
    const runQuery = recordingQuery();
    const deps = { log: quietLog(), runQuery, sdkVersion: '0.3.308' };
    expect(await runMain(await writeDescriptor('{"runId":'), deps)).toBe(
      EXIT_CODES.descriptorInvalid,
    );
    const oversized = 'x'.repeat(DESCRIPTOR_FILE_MAX_BYTES + 1);
    expect(await runMain(await writeDescriptor(oversized), deps)).toBe(
      EXIT_CODES.descriptorInvalid,
    );
    expect(runQuery.calls).toHaveLength(0);
  });

  it('exits 2 and never contacts the broker when the brief is too large', async () => {
    broker = await startBroker();
    const runQuery = recordingQuery();
    const brief = 'a'.repeat(AGENT_BRIEF_MAX_BYTES + 1);
    const code = await runMain(await writeDescriptor(descriptor(broker.url, { brief })), {
      log: quietLog(),
      runQuery,
      sdkVersion: '0.3.308',
    });
    expect(code).toBe(EXIT_CODES.descriptorInvalid);
    expect(broker.requests).toHaveLength(0);
    expect(runQuery.calls).toHaveLength(0);
  });

  it('runs the session, records it once through the broker and exits 0', async () => {
    broker = await startBroker();
    const runQuery = recordingQuery();
    const code = await runMain(await writeDescriptor(descriptor(broker.url)), {
      log: quietLog(),
      runQuery,
      sdkVersion: '0.3.308',
    });

    expect(code).toBe(EXIT_CODES.success);
    expect(runQuery.calls).toEqual([
      { prompt: 'Plan the next subtask. ✓', disallowed: ['WebFetch', 'WebSearch', 'WebRequest'] },
    ]);
    const posts = broker.requests.filter((r) => r.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(posts[0]?.url).toBe(`/internal/broker/runs/${RUN}/${AGENT_SESSION_RECORD_SUFFIX}`);
    expect(posts[0]?.authorization).toBe(`Bearer ${TOKEN}`);
    expect(posts[0]?.body).toMatchObject({ sessionId: SESSION, status: 'success', numTurns: 2 });
  });

  it('exits 3 and emits no model traffic when the broker is unreachable', async () => {
    const closed = await startBroker();
    const url = closed.url;
    await closed.close();
    const runQuery = recordingQuery();
    const code = await runMain(await writeDescriptor(descriptor(url)), {
      log: quietLog(),
      runQuery,
      sdkVersion: '0.3.308',
    });
    expect(code).toBe(EXIT_CODES.brokerUnavailable);
    expect(runQuery.calls).toHaveLength(0);
  });

  it('exits 3 when the broker refuses the token (expired or revoked)', async () => {
    broker = await startBroker({ stateStatus: 401 });
    const runQuery = recordingQuery();
    const code = await runMain(await writeDescriptor(descriptor(broker.url)), {
      log: quietLog(),
      runQuery,
      sdkVersion: '0.3.308',
    });
    expect(code).toBe(EXIT_CODES.brokerUnavailable);
    expect(runQuery.calls).toHaveLength(0);
  });

  it('exits 3 when the run is not active', async () => {
    broker = await startBroker({ active: false });
    const runQuery = recordingQuery();
    const code = await runMain(await writeDescriptor(descriptor(broker.url)), {
      log: quietLog(),
      runQuery,
      sdkVersion: '0.3.308',
    });
    expect(code).toBe(EXIT_CODES.brokerUnavailable);
    expect(runQuery.calls).toHaveLength(0);
  });

  it('exits 3 when the session record is refused by the broker', async () => {
    broker = await startBroker({ recordStatus: 500 });
    const code = await runMain(await writeDescriptor(descriptor(broker.url)), {
      log: quietLog(),
      runQuery: recordingQuery(),
      sdkVersion: '0.3.308',
    });
    expect(code).toBe(EXIT_CODES.brokerUnavailable);
  });

  it('exits 4 when the SDK query fails', async () => {
    broker = await startBroker();
    const failing: RunQuery = () => failingStream(new Error('boom'));
    const code = await runMain(await writeDescriptor(descriptor(broker.url)), {
      log: quietLog(),
      runQuery: failing,
      sdkVersion: '0.3.308',
    });
    expect(code).toBe(EXIT_CODES.unhandledError);
  });
});
