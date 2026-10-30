import { describe, expect, it } from 'vitest';

import { AppError } from '@blackwing/errors';

import {
  OOB_PROTOCOLS,
  oobInteractionSchema,
  toInteraction,
  wireInteractionSchema,
} from './interaction.js';

/** The `AppError` code a synchronous call throws; fails the test if it does not throw an `AppError`. */
function thrownCode(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof AppError) return error.code;
    throw error;
  }
  throw new Error('expected the call to throw');
}

const CID = 'abcdefghijklmnopqrst';
const RECEIVED = new Date('2026-10-31T10:00:05.000Z');

function wire(overrides: Record<string, unknown> = {}) {
  return wireInteractionSchema.parse({
    protocol: 'http',
    'unique-id': `${CID}nonce1234567`,
    'full-id': `${CID}nonce1234567`,
    'remote-address': '203.0.113.7:51234',
    timestamp: '2026-10-31T10:00:01.123456789Z',
    'raw-request': 'GET /x HTTP/1.1\r\nHost: a\r\n\r\n',
    'raw-response': 'HTTP/1.1 200 OK\r\n\r\n',
    ...overrides,
  });
}

describe('wireInteractionSchema', () => {
  it('accepts every protocol the listener reports', () => {
    for (const protocol of OOB_PROTOCOLS) {
      expect(wireInteractionSchema.safeParse({ ...wire(), protocol }).success).toBe(true);
    }
  });

  it('rejects an unknown protocol (a silent miss would hide a new listener feature)', () => {
    expect(wireInteractionSchema.safeParse({ ...wire(), protocol: 'ftp' }).success).toBe(false);
  });

  it('rejects a record without a timestamp', () => {
    expect(wireInteractionSchema.safeParse({ ...wire(), timestamp: undefined }).success).toBe(
      false,
    );
  });

  it('ignores unknown additive fields from the listener', () => {
    expect(wireInteractionSchema.safeParse({ ...wire(), 'q-type': 'A', extra: 1 }).success).toBe(
      true,
    );
  });
});

describe('toInteraction', () => {
  it('maps a correlated record and keeps the listener time and the local receive time apart', () => {
    const interaction = toInteraction(wire(), CID, RECEIVED);
    expect(interaction).toEqual({
      protocol: 'http',
      correlationId: CID,
      fullId: `${CID}nonce1234567`,
      remoteAddress: '203.0.113.7:51234',
      timestamp: new Date('2026-10-31T10:00:01.123Z'),
      receivedAt: RECEIVED,
      rawRequest: Buffer.from('GET /x HTTP/1.1\r\nHost: a\r\n\r\n', 'utf8').toString('base64'),
      rawResponse: Buffer.from('HTTP/1.1 200 OK\r\n\r\n', 'utf8').toString('base64'),
    });
    expect(oobInteractionSchema.safeParse(interaction).success).toBe(true);
  });

  it('keeps binary and non-ASCII request bytes losslessly as base64', () => {
    const raw = 'POST /é HTTP/1.1\r\n\r\n☃';
    const interaction = toInteraction(wire({ 'raw-request': raw }), CID, RECEIVED);
    expect(Buffer.from(interaction.rawRequest, 'base64').toString('utf8')).toBe(raw);
  });

  it('omits rawResponse when the listener sent none (DNS and SMTP records)', () => {
    const interaction = toInteraction(
      wire({ protocol: 'dns', 'raw-response': undefined }),
      CID,
      RECEIVED,
    );
    expect(interaction).not.toHaveProperty('rawResponse');
    expect(interaction.protocol).toBe('dns');
  });

  it('defaults a missing remote address to the empty string', () => {
    expect(toInteraction(wire({ 'remote-address': undefined }), CID, RECEIVED).remoteAddress).toBe(
      '',
    );
  });

  it.each([
    ['the unique id is for another correlation id', { 'unique-id': 'zzzzzzzzzzzzzzzzzzzz1234567' }],
    ['the full id is for another correlation id', { 'full-id': 'zzzzzzzzzzzzzzzzzzzz1234567' }],
  ])('refuses a record whose %s (never correlate another session)', (_label, override) => {
    expect(thrownCode(() => toInteraction(wire(override), CID, RECEIVED))).toBe(
      'OOB_PROTOCOL_INCOMPATIBLE',
    );
  });

  it('refuses a timestamp that is not RFC 3339', () => {
    expect(() => toInteraction(wire({ timestamp: 'yesterday' }), CID, RECEIVED)).toThrow(AppError);
    expect(thrownCode(() => toInteraction(wire({ timestamp: 'yesterday' }), CID, RECEIVED))).toBe(
      'OOB_PROTOCOL_INCOMPATIBLE',
    );
  });

  it('refuses a full id that is not a DNS label of the expected shape', () => {
    expect(
      thrownCode(() => toInteraction(wire({ 'full-id': `${CID}NOT-A-LABEL` }), CID, RECEIVED)),
    ).toBe('OOB_PROTOCOL_INCOMPATIBLE');
  });
});
