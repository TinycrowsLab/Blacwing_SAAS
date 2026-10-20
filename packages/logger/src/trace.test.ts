import { context, type ContextManager, ROOT_CONTEXT, trace, TraceFlags } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { afterEach, describe, expect, it } from 'vitest';

import { createLogger, withContext } from './logger.js';
import { capture } from './testdata/capture.js';
import { activeTraceFields } from './trace.js';

const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
const SPAN_ID = '00f067aa0ba902b7';
const CHILD_SPAN_ID = 'b7ad6b7169203331';

/** A fake active span: a valid span context wrapped as a non-recording span (no SDK needed). */
function inSpan<T>(spanId: string, fn: () => T, traceId = TRACE_ID): T {
  const span = trace.wrapSpanContext({ traceId, spanId, traceFlags: TraceFlags.SAMPLED });
  return context.with(trace.setSpan(context.active(), span), fn);
}

function enableContext(): void {
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
}

afterEach(() => {
  context.disable();
});

describe('trace correlation', () => {
  it('omits trace fields gracefully before OpenTelemetry is initialised (no context manager)', () => {
    const out = capture();
    const log = createLogger('t', { destination: out.destination });
    // With the API's no-op context manager, context.with does not propagate: still no span.
    expect(() => {
      inSpan(SPAN_ID, () => {
        log.info('before init');
      });
    }).not.toThrow();
    expect(out.last()).not.toHaveProperty('traceId');
    expect(out.last()).not.toHaveProperty('spanId');
    expect(activeTraceFields()).toBeUndefined();
  });

  it('adds traceId/spanId to every line logged inside an active span, children included', () => {
    enableContext();
    const out = capture();
    const log = createLogger('t', { destination: out.destination, level: 'trace' });
    inSpan(SPAN_ID, () => {
      log.info('one');
      log.error({ k: 1 }, 'two');
      withContext(log, { tenantId: 'tnt' }).warn('three');
      log.child({ c: 1 }).trace('four');
    });
    const records = out.records();
    expect(records).toHaveLength(4);
    for (const record of records) {
      expect(record).toMatchObject({ traceId: TRACE_ID, spanId: SPAN_ID });
    }
  });

  it('follows the active span: nested spans, async continuations, and leaving the span', async () => {
    enableContext();
    const out = capture();
    const log = createLogger('t', { destination: out.destination });
    await inSpan(SPAN_ID, async () => {
      log.info('outer');
      inSpan(CHILD_SPAN_ID, () => {
        log.info('inner');
      });
      await new Promise((resolve) => setTimeout(resolve, 1));
      log.info('after await');
    });
    log.info('outside');
    const [outer, inner, afterAwait, outside] = out.records();
    expect(outer).toMatchObject({ spanId: SPAN_ID });
    expect(inner).toMatchObject({ traceId: TRACE_ID, spanId: CHILD_SPAN_ID });
    expect(afterAwait).toMatchObject({ spanId: SPAN_ID });
    expect(outside).not.toHaveProperty('traceId');
  });

  it('ignores an invalid (all-zero) span context', () => {
    enableContext();
    const out = capture();
    const log = createLogger('t', { destination: out.destination });
    inSpan(
      '0000000000000000',
      () => {
        log.info('invalid');
      },
      '00000000000000000000000000000000',
    );
    expect(out.last()).not.toHaveProperty('traceId');
  });

  it('never throws when the context manager itself fails', () => {
    const broken: ContextManager = {
      active: () => {
        throw new Error('context manager broken');
      },
      with: (_ctx, fn, thisArg, ...args) => fn.apply(thisArg, args),
      bind: (_ctx, target) => target,
      enable() {
        return this;
      },
      disable() {
        return this;
      },
    };
    context.setGlobalContextManager(broken);
    const out = capture();
    const log = createLogger('t', { destination: out.destination });
    expect(() => {
      log.info('still logs');
    }).not.toThrow();
    expect(out.last()).toMatchObject({ msg: 'still logs' });
    expect(out.last()).not.toHaveProperty('traceId');
  });

  it('uses a bound traceId as the fallback outside a span, and the active span inside one', () => {
    enableContext();
    const out = capture();
    const queued = withContext(createLogger('t', { destination: out.destination }), {
      tenantId: 'tnt',
      traceId: '11111111111111111111111111111111',
    });
    queued.info('from the job');
    queued.child({ step: 2 }).info('child of the job');
    inSpan(SPAN_ID, () => {
      queued.info('inside a span');
    });
    const [job, child, span] = out.records();
    expect(job).toMatchObject({ traceId: '11111111111111111111111111111111', tenantId: 'tnt' });
    expect(job).not.toHaveProperty('spanId');
    expect(child).toMatchObject({ traceId: '11111111111111111111111111111111', step: 2 });
    expect(span).toMatchObject({ traceId: TRACE_ID, spanId: SPAN_ID });
    // Never a duplicate key.
    for (const line of out.lines) expect(line.match(/"traceId"/g)).toHaveLength(1);
  });

  it('does not leak span context set on ROOT_CONTEXT elsewhere', () => {
    enableContext();
    expect(trace.getSpan(ROOT_CONTEXT)).toBeUndefined();
    expect(activeTraceFields()).toBeUndefined();
  });
});
