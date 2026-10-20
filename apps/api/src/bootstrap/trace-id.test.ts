import { describe, expect, it } from 'vitest';

import { isUuidV7 } from '@blackwing/ids';

import { deriveTraceId, traceIdFromTraceparent } from './trace-id.js';

const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
const TRACEPARENT = `00-${TRACE}-00f067aa0ba902b7-01`;

describe('traceIdFromTraceparent', () => {
  it('extracts the trace id of a valid version-00 header', () => {
    expect(traceIdFromTraceparent(TRACEPARENT)).toBe(TRACE);
    expect(traceIdFromTraceparent(TRACEPARENT.toUpperCase())).toBe(TRACE);
  });

  it.each([
    'garbage',
    `01-${TRACE}-00f067aa0ba902b7-01`,
    `00-${'0'.repeat(32)}-00f067aa0ba902b7-01`,
    `00-${TRACE}-${'0'.repeat(16)}-01`,
    `00-${TRACE}-00f067aa0ba902b7`,
    '',
  ])('rejects %j', (value) => {
    expect(traceIdFromTraceparent(value)).toBeUndefined();
  });
});

describe('deriveTraceId', () => {
  const fixed = (): string => 'generated';

  it('prefers a valid traceparent over x-request-id', () => {
    expect(deriveTraceId({ traceparent: TRACEPARENT, 'x-request-id': 'req-1' }, fixed)).toBe(TRACE);
  });

  it('falls back to a well-formed x-request-id', () => {
    expect(deriveTraceId({ 'x-request-id': 'req-1:abc.DEF_9' }, fixed)).toBe('req-1:abc.DEF_9');
    expect(deriveTraceId({ traceparent: 'bad', 'x-request-id': 'req-2' }, fixed)).toBe('req-2');
  });

  it('keeps the first of duplicate inbound ids', () => {
    expect(deriveTraceId({ 'x-request-id': ['first', 'second'] }, fixed)).toBe('first');
    const second = `00-${'a'.repeat(32)}-00f067aa0ba902b7-01`;
    expect(deriveTraceId({ traceparent: [TRACEPARENT, second] }, fixed)).toBe(TRACE);
  });

  it.each([
    ['a newline (log injection)', 'abc\n{"level":"fatal"}'],
    ['spaces', 'a b'],
    ['an oversized value', 'x'.repeat(129)],
    ['an empty value', ''],
  ])('generates a fresh id instead of adopting %s', (_label, value) => {
    expect(deriveTraceId({ 'x-request-id': value }, fixed)).toBe('generated');
  });

  it('generates a UUIDv7 by default when nothing usable is supplied', () => {
    const id = deriveTraceId({});
    expect(isUuidV7(id)).toBe(true);
    expect(deriveTraceId({})).not.toBe(id);
  });
});
