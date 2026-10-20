import { describe, expect, it } from 'vitest';

import {
  anthropicErrorBodySchema,
  DEFAULT_ANTHROPIC_VERSION,
  MESSAGES_STREAM_EVENTS,
  messagesRequestSchema,
} from './messages.js';

describe('model-gateway Messages contracts', () => {
  it('pins a dated anthropic-version', () => {
    expect(DEFAULT_ANTHROPIC_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('accepts a minimal request and keeps unknown keys', () => {
    const parsed = messagesRequestSchema.parse({
      model: 'claude-x',
      max_tokens: 16,
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
      metadata: { user_id: 'u' },
    });
    expect(parsed).toMatchObject({ stream: true, metadata: { user_id: 'u' } });
  });

  it.each([
    [{ max_tokens: 1, messages: [] }],
    [{ model: '', max_tokens: 1, messages: [] }],
    [{ model: 'm', max_tokens: 0, messages: [] }],
    [{ model: 'm', max_tokens: 1, messages: 'x' }],
    [{ model: 'm', max_tokens: 1, messages: [], stream: 'yes' }],
  ])('rejects %j', (body) => {
    expect(messagesRequestSchema.safeParse(body).success).toBe(false);
  });

  it('validates the Anthropic error envelope', () => {
    expect(
      anthropicErrorBodySchema.safeParse({
        type: 'error',
        error: { type: 'request_too_large', message: 'too big' },
      }).success,
    ).toBe(true);
    expect(
      anthropicErrorBodySchema.safeParse({ type: 'error', error: { type: 'nope', message: '' } })
        .success,
    ).toBe(false);
  });

  it('lists the stream lifecycle events', () => {
    expect(MESSAGES_STREAM_EVENTS).toEqual(
      expect.arrayContaining([
        'message_start',
        'content_block_delta',
        'message_delta',
        'message_stop',
      ]),
    );
  });
});
