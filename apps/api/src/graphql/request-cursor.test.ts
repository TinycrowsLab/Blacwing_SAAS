import { describe, expect, it } from 'vitest';

import { ValidationError } from '@blackwing/errors';

import { decodeRequestCursor, encodeRequestCursor } from './request-cursor.js';

const ID = '0198f0a0-0000-7000-8000-00000000000a';
const WHEN = new Date('2026-01-02T03:04:05.000Z');

describe('assessment request cursor (API-009)', () => {
  it('round-trips the keyset position of a row', () => {
    const cursor = encodeRequestCursor({ createdAt: WHEN, id: ID });
    expect(decodeRequestCursor(cursor)).toEqual({ createdAt: WHEN, id: ID });
  });

  it('is opaque: the encoded form does not show the id', () => {
    expect(encodeRequestCursor({ createdAt: WHEN, id: ID })).not.toContain(ID);
  });

  it.each([
    ['not base64 JSON', '%%%'],
    ['a JSON array', Buffer.from('[1]').toString('base64url')],
    [
      'a non-date timestamp',
      Buffer.from(JSON.stringify({ c: 'soon', i: ID })).toString('base64url'),
    ],
    [
      'a non-UUID id',
      Buffer.from(JSON.stringify({ c: WHEN.toISOString(), i: 'x' })).toString('base64url'),
    ],
    [
      'an extra field',
      Buffer.from(JSON.stringify({ c: WHEN.toISOString(), i: ID, t: 'x' })).toString('base64url'),
    ],
  ])('rejects %s with a validation error', (_label, cursor) => {
    expect(() => decodeRequestCursor(cursor)).toThrow(ValidationError);
  });
});
