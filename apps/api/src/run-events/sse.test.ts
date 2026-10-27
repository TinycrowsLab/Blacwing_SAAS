import { describe, expect, it } from 'vitest';

import { ValidationError } from '@blackwing/errors';

import { TenantStreamLimiter } from './limits.js';
import { formatControlFrame, formatEventFrame, resumeCursor } from './sse.js';

describe('formatEventFrame', () => {
  it('writes id, event and a single JSON data line, ended by a blank line', () => {
    const frame = formatEventFrame('1700000000000-3', 'message.partial', {
      seq: 1,
      payload: { text: 'a\nb' },
    });
    expect(frame).toBe(
      'id: 1700000000000-3\nevent: message.partial\ndata: {"seq":1,"payload":{"text":"a\\nb"}}\n\n',
    );
    // JSON escapes the line break, so the frame has exactly one data line.
    expect(frame.split('\n').filter((line) => line.startsWith('data:'))).toHaveLength(1);
  });

  it.each(['1700000000000-0\nevent: injected', 'x\rdata: y', 'a\0b'])(
    'refuses a stream id that would break the frame (%j)',
    (id) => {
      expect(() => formatEventFrame(id, 'message.partial', {})).toThrow(ValidationError);
    },
  );

  it.each(['Message', 'a b', 'x\ndata: y', '', 'a'.repeat(129)])(
    'refuses the event name %j',
    (name) => {
      expect(() => formatEventFrame('1-0', name, {})).toThrow(ValidationError);
    },
  );
});

describe('formatControlFrame', () => {
  it('writes a frame without an id', () => {
    expect(formatControlFrame('resync', { reason: 'trimmed' })).toBe(
      'event: resync\ndata: {"reason":"trimmed"}\n\n',
    );
  });
});

describe('resumeCursor', () => {
  it('is undefined for a fresh stream', () => {
    expect(resumeCursor(undefined, undefined)).toBeUndefined();
    expect(resumeCursor('', undefined)).toBeUndefined();
    expect(resumeCursor(undefined, '')).toBeUndefined();
  });

  it('takes the Last-Event-ID header', () => {
    expect(resumeCursor('1700000000000-4', undefined)).toBe('1700000000000-4');
  });

  it('takes the lastEventId query when no header is sent', () => {
    expect(resumeCursor(undefined, '1700000000000-4')).toBe('1700000000000-4');
  });

  it('prefers the header over the query (what EventSource sends on reconnect wins)', () => {
    expect(resumeCursor('1700000000000-9', '1700000000000-1')).toBe('1700000000000-9');
  });

  it('accepts a bare millisecond id as the start of that millisecond', () => {
    expect(resumeCursor('1700000000000', undefined)).toBe('1700000000000');
  });

  it.each([
    ['$'],
    ['abc'],
    ['1-2-3'],
    ['1700000000000-x'],
    ['-1'],
    ['123456789012345678901-0'],
    ['1700000000000-0\n'],
    [' 1-0'],
  ])('refuses %j as a cursor', (value) => {
    expect(() => resumeCursor(value, undefined)).toThrow(ValidationError);
    expect(() => resumeCursor(undefined, value)).toThrow(ValidationError);
  });

  it('refuses a repeated header or query (an array is never guessed at)', () => {
    expect(() => resumeCursor(['1-0', '2-0'], undefined)).toThrow(ValidationError);
    expect(() => resumeCursor(undefined, ['1-0', '2-0'])).toThrow(ValidationError);
  });
});

describe('TenantStreamLimiter', () => {
  it('caps the open streams of one tenant and frees a slot on release', () => {
    const limiter = new TenantStreamLimiter(2);
    const first = limiter.tryAcquire('t1');
    const second = limiter.tryAcquire('t1');
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(limiter.tryAcquire('t1')).toBeUndefined();
    first?.();
    expect(limiter.openCount('t1')).toBe(1);
    expect(limiter.tryAcquire('t1')).toBeDefined();
  });

  it('counts each tenant separately', () => {
    const limiter = new TenantStreamLimiter(1);
    expect(limiter.tryAcquire('t1')).toBeDefined();
    expect(limiter.tryAcquire('t2')).toBeDefined();
  });

  it('releases once: a second release never frees another stream slot', () => {
    const limiter = new TenantStreamLimiter(2);
    const a = limiter.tryAcquire('t1');
    limiter.tryAcquire('t1');
    a?.();
    a?.();
    expect(limiter.openCount('t1')).toBe(1);
    expect(limiter.tryAcquire('t1')).toBeDefined();
    expect(limiter.tryAcquire('t1')).toBeUndefined();
  });

  it.each([0, -1, 1.5])('refuses a cap of %s', (cap) => {
    expect(() => new TenantStreamLimiter(cap)).toThrow(RangeError);
  });
});
