/**
 * Wire contracts of the Blackwing model gateway's Anthropic-Messages-compatible surface (GATEWAY-001, #404).
 *
 * The gateway mimics the upstream Anthropic Messages API so Claude Code (pointed at it through
 * `ANTHROPIC_BASE_URL`) works unchanged. These schemas validate only what the gateway itself relies on;
 * every other field passes through untouched, because the upstream owns the full request contract.
 * Errors use the Anthropic error envelope, not RFC 9457 (CONTEXT_PACK §9 deliberately does not apply here).
 */
import { z } from 'zod';

/** The `anthropic-version` the gateway pins when a client omits the header. */
export const DEFAULT_ANTHROPIC_VERSION = '2023-06-01';

/** Error `type` values of the Anthropic error envelope that the gateway emits or passes through. */
export const ANTHROPIC_ERROR_TYPES = [
  'invalid_request_error',
  'authentication_error',
  'permission_error',
  'not_found_error',
  'request_too_large',
  'rate_limit_error',
  'api_error',
  'timeout_error',
  'overloaded_error',
] as const;

export type AnthropicErrorType = (typeof ANTHROPIC_ERROR_TYPES)[number];

export const anthropicErrorTypeSchema = z.enum(ANTHROPIC_ERROR_TYPES);

/** `{ "type": "error", "error": { "type": "...", "message": "..." } }`, the body Claude Code parses on failure. */
export const anthropicErrorBodySchema = z.object({
  type: z.literal('error'),
  error: z.object({
    type: anthropicErrorTypeSchema,
    message: z.string(),
  }),
  request_id: z.string().optional(),
});

export type AnthropicErrorBody = z.output<typeof anthropicErrorBodySchema>;

/**
 * `POST /v1/messages` request body, as far as the gateway inspects it. Unknown keys are kept
 * (`looseObject`) so new upstream parameters work without a gateway release.
 */
export const messagesRequestSchema = z.looseObject({
  model: z.string().min(1),
  max_tokens: z.number().int().positive(),
  messages: z.array(z.unknown()),
  stream: z.boolean().optional(),
});

export type MessagesRequest = z.output<typeof messagesRequestSchema>;

/** Server-sent event names of a streamed Messages response, in the order the upstream emits them. */
export const MESSAGES_STREAM_EVENTS = [
  'message_start',
  'content_block_start',
  'ping',
  'content_block_delta',
  'content_block_stop',
  'message_delta',
  'message_stop',
  'error',
] as const;

export type MessagesStreamEvent = (typeof MESSAGES_STREAM_EVENTS)[number];
