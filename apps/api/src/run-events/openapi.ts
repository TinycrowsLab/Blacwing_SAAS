import { errorResponses, type JsonObject } from '../openapi/schema.js';

import type { ErrorCode } from '@blackwing/errors';

/** Error codes `GET /v1/runs/{runId}/events` answers with before the stream opens. */
export const RUN_EVENTS_ERROR_CODES = [
  'UNAUTHENTICATED',
  'TENANT_CONTEXT_MISSING',
  'VALIDATION_FAILED',
  'FORBIDDEN',
  'RATE_LIMITED',
] as const satisfies readonly ErrorCode[];

/**
 * The run event stream as a module of the public document (#65). It is Server-Sent Events, so the 200
 * response is `text/event-stream`, not a JSON schema; the frame vocabulary is documented in its description.
 */
export function runEventsOpenApiModule(): {
  readonly tag: string;
  readonly description: string;
  readonly paths: JsonObject;
  readonly schemas: JsonObject;
} {
  return {
    tag: 'runs',
    description: 'Live run events over Server-Sent Events, with resume after disconnect.',
    schemas: {},
    paths: {
      '/v1/runs/{runId}/events': {
        get: {
          operationId: 'streamRunEvents',
          summary: 'Stream the live events of one run (text/event-stream)',
          description: [
            'Requires run:read in the caller tenant. A run outside that tenant answers 403 exactly like a missing one.',
            'Each run event is one frame: `id` is the stream entry id, `event` the run event type, `data` the JSON event.',
            'Reconnect with the `Last-Event-ID` header (or `lastEventId` query) to replay the missed events; at most API_SSE_MAX_REPLAY are replayed.',
            'Control frames (no id): `state` and `end` for a finished run or a terminal event, `resync` (refetch the run: events were trimmed, the client was too slow, or the replay was too long), `timeout` (API_SSE_MAX_DURATION_MS reached) and `error` (the event source failed; reconnect with backoff).',
            'The `event` names `state`, `resync`, `end`, `timeout` and `error` are reserved for control frames.',
            'A heartbeat comment (`: heartbeat`) is sent every API_SSE_HEARTBEAT_MS while idle.',
          ].join(' '),
          security: [{ bearerAuth: [] }, { sessionCookie: [] }],
          parameters: [
            {
              name: 'runId',
              in: 'path',
              required: true,
              schema: { type: 'string', format: 'uuid' },
              example: '01890a5d-ac96-774b-bcce-b302099a8058',
            },
            {
              name: 'Last-Event-ID',
              in: 'header',
              required: false,
              description: 'Stream id of the last event received; resumes after it.',
              schema: { type: 'string', maxLength: 64 },
              example: '1700000000000-0',
            },
            {
              name: 'lastEventId',
              in: 'query',
              required: false,
              description: 'Same as the Last-Event-ID header, for clients that cannot set headers.',
              schema: { type: 'string', maxLength: 64 },
            },
          ],
          responses: {
            '200': {
              description: 'The event stream.',
              content: {
                'text/event-stream': {
                  schema: { type: 'string' },
                  example:
                    'id: 1700000000000-0\nevent: message.partial\ndata: {"type":"message.partial","ts":"2026-10-20T10:00:00.000Z","seq":1,"payload":{}}\n\n',
                },
              },
            },
            ...errorResponses(RUN_EVENTS_ERROR_CODES),
          },
        },
      },
    },
  };
}
