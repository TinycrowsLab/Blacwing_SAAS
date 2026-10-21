import { createHmac, timingSafeEqual } from 'node:crypto';

import { MAX_CURSOR_LENGTH } from '@blackwing/contracts';

import { invalidCursor } from './errors.js';

/** Bump when the cursor payload layout changes; older cursors then answer `invalid_cursor`. */
export const CURSOR_VERSION = 1;
/** Shortest HMAC key accepted (bytes of entropy matter more, but a floor stops obvious mistakes). */
export const MIN_CURSOR_SECRET_LENGTH = 32;

export type Direction = 'asc' | 'desc';

/** Decoded cursor payload `{ k, d, v }` plus the request signature `s` (sort + filters). */
export interface CursorPayload {
  /** Sort key values of the last row on the page; the final entry is always the unique row id. */
  readonly k: readonly (string | number)[];
  readonly d: Direction;
  readonly v: number;
  /** Digest of the sort field, direction and filters the cursor was issued for. */
  readonly s: string;
}

export interface CursorCodec {
  encode(payload: Omit<CursorPayload, 'v'>): string;
  /** Verifies the HMAC, version, direction and signature; every failure is `invalid_cursor`. */
  decode(token: string, expected: { readonly d: Direction; readonly s: string }): CursorPayload;
}

const BASE64URL = /^[A-Za-z0-9_-]+$/;

function sign(secret: string, body: string): Buffer {
  return createHmac('sha256', secret).update(body).digest();
}

/**
 * Opaque, tamper-evident cursors: `base64url(json).base64url(hmac-sha256)`. The key is
 * `API_CURSOR_SECRET`; a missing or short key throws at construction (fail closed).
 */
export function createCursorCodec(secret: string | undefined): CursorCodec {
  if (secret === undefined || secret.length < MIN_CURSOR_SECRET_LENGTH)
    throw new RangeError(
      `API_CURSOR_SECRET must be set to at least ${String(MIN_CURSOR_SECRET_LENGTH)} characters`,
    );
  return {
    encode(payload) {
      const body = Buffer.from(JSON.stringify({ ...payload, v: CURSOR_VERSION })).toString(
        'base64url',
      );
      return `${body}.${sign(secret, body).toString('base64url')}`;
    },
    decode(token, expected) {
      if (token.length > MAX_CURSOR_LENGTH) throw invalidCursor();
      const parts = token.split('.');
      const [body, mac] = parts;
      if (parts.length !== 2 || body === undefined || mac === undefined) throw invalidCursor();
      if (!BASE64URL.test(body) || !BASE64URL.test(mac)) throw invalidCursor();
      const given = Buffer.from(mac, 'base64url');
      const wanted = sign(secret, body);
      if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) throw invalidCursor();
      let parsed: unknown;
      try {
        parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
      } catch {
        throw invalidCursor();
      }
      const payload = asPayload(parsed);
      if (payload.v !== CURSOR_VERSION || payload.d !== expected.d || payload.s !== expected.s)
        throw invalidCursor();
      return payload;
    },
  };
}

function asPayload(value: unknown): CursorPayload {
  if (typeof value !== 'object' || value === null) throw invalidCursor();
  const { k, d, v, s } = value as Record<string, unknown>;
  if (
    !Array.isArray(k) ||
    k.length < 1 ||
    k.length > 2 ||
    !k.every(
      (entry) => typeof entry === 'string' || (typeof entry === 'number' && Number.isFinite(entry)),
    ) ||
    (d !== 'asc' && d !== 'desc') ||
    typeof v !== 'number' ||
    typeof s !== 'string'
  )
    throw invalidCursor();
  return { k: k as (string | number)[], d, v, s };
}
