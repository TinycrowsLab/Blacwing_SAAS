// Unit: the opaque endpoint cursor. A forged or malformed cursor is a validation error, never a partial position.
import { describe, expect, it } from 'vitest';

import { ValidationError } from '@blackwing/errors';

import { decodeEndpointCursor, encodeEndpointCursor } from './endpoint-cursor.js';

const KEY =
  'endpoint:0198f0a0-0000-7000-8000-00000000000a:0198f0a0-0000-7000-8000-0000000000d1:GET:/users/{id}';

describe('endpoint cursor', () => {
  it('round-trips the natural key of the last endpoint of a page', () => {
    expect(decodeEndpointCursor(encodeEndpointCursor(KEY))).toBe(KEY);
  });

  it.each([
    ['not base64 JSON', Buffer.from('not json', 'utf8').toString('base64url')],
    ['a non-object payload', Buffer.from('"text"', 'utf8').toString('base64url')],
    ['an empty key', Buffer.from('{"k":""}', 'utf8').toString('base64url')],
    ['an unknown field', Buffer.from('{"k":"x","extra":1}', 'utf8').toString('base64url')],
    ['a key that is not text', Buffer.from('{"k":3}', 'utf8').toString('base64url')],
  ])('refuses %s as a validation error', (_name, cursor) => {
    expect(() => decodeEndpointCursor(cursor)).toThrow(ValidationError);
  });
});
