import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';

import type { AddressInfo } from 'node:net';

/** One request the mock upstream received. `closed` flips when its socket goes away. */
interface RecordedRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
  closed: boolean;
  /** Resolves when the response socket closes (normally or aborted). */
  readonly closedPromise: Promise<void>;
}

/** Status the mock answers with before a test installs a handler. */
const NO_HANDLER_STATUS = 500;

type MockHandler = (request: RecordedRequest, response: ServerResponse) => void | Promise<void>;

export interface MockAnthropic {
  readonly url: string;
  readonly requests: RecordedRequest[];
  handle(handler: MockHandler): void;
  close(): Promise<void>;
}

/** A local Anthropic-Messages-shaped upstream for tests: no network egress, random port. */
export async function startMockAnthropic(): Promise<MockAnthropic> {
  const requests: RecordedRequest[] = [];
  let handler: MockHandler = (_request, response) => {
    response.writeHead(NO_HANDLER_STATUS).end();
  };

  const server = createServer((incoming: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
    incoming.on('end', () => {
      let markClosed: () => void = () => undefined;
      const closedPromise = new Promise<void>((resolve) => {
        markClosed = resolve;
      });
      const recorded: RecordedRequest = {
        method: incoming.method ?? '',
        url: incoming.url ?? '',
        headers: incoming.headers,
        body: Buffer.concat(chunks).toString('utf8'),
        closed: false,
        closedPromise,
      };
      response.once('close', () => {
        recorded.closed = true;
        markClosed();
      });
      requests.push(recorded);
      void Promise.resolve(handler(recorded, response)).catch(() => response.destroy());
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${String(port)}`,
    requests,
    handle(next) {
      handler = next;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}

/** Serialises SSE events the way the Messages API does: `event: <name>\ndata: <json>\n\n`. */
export function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** A complete, representative streamed Messages response. */
export function sampleStream(): string {
  return [
    sseEvent('message_start', {
      type: 'message_start',
      message: {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        content: [],
        model: 'claude-test',
      },
    }),
    sseEvent('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    }),
    sseEvent('ping', { type: 'ping' }),
    sseEvent('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'Hello, ' },
    }),
    sseEvent('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'wörld ✓' },
    }),
    sseEvent('content_block_stop', { type: 'content_block_stop', index: 0 }),
    sseEvent('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn' },
      usage: { output_tokens: 4 },
    }),
    sseEvent('message_stop', { type: 'message_stop' }),
  ].join('');
}
