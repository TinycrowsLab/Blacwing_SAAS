import { describe, expect, it } from 'vitest';

import { approverCtx, eventOf, statusOf } from './state.fixtures.js';
import {
  applyTransition,
  IllegalRunEventError,
  type PausedReason,
  RUN_STATES,
  type RunStatus,
} from './state.js';

const REASONS: PausedReason[] = ['gate2_pending', 'cost_cap', 'operator_pause', 'window_closed'];

describe('paused round trip', () => {
  it.each(REASONS)('pause(%s) then resume returns to executing, remembering resumeTo', (reason) => {
    const paused = applyTransition(
      statusOf('executing', 2),
      { type: 'pause', reason },
      approverCtx,
    );
    expect(paused.next).toEqual({ state: 'paused', reason, resumeTo: 'executing', version: 3 });
    expect(paused.auditIntent).toMatchObject({ from: 'executing', to: 'paused', reason });

    const resumed = applyTransition(paused.next, eventOf('resume'), approverCtx);
    expect(resumed.next).toEqual({ state: 'executing', version: 4 });
  });

  it('pause is legal only from executing', () => {
    for (const from of RUN_STATES.filter((s) => s !== 'executing' && s !== 'paused')) {
      expect(() => applyTransition(statusOf(from), eventOf('pause'), approverCtx)).toThrow(
        IllegalRunEventError,
      );
    }
  });

  it('resume when not paused throws', () => {
    for (const from of RUN_STATES.filter((s) => s !== 'paused')) {
      expect(() => applyTransition(statusOf(from), eventOf('resume'), approverCtx)).toThrow(
        IllegalRunEventError,
      );
    }
  });

  it('pause while already paused is an idempotent no-op that keeps the original reason', () => {
    const paused: RunStatus = {
      state: 'paused',
      reason: 'gate2_pending',
      resumeTo: 'executing',
      version: 9,
    };
    const result = applyTransition(paused, { type: 'pause', reason: 'cost_cap' }, approverCtx);
    expect(result.next).toBe(paused);
    expect(result.auditIntent).toBeNull();
  });

  it('sa_expired takes precedence over an in-flight pause and wins against a later resume', () => {
    const paused = applyTransition(
      statusOf('executing'),
      { type: 'pause', reason: 'gate2_pending' },
      approverCtx,
    ).next;
    const expired = applyTransition(paused, eventOf('sa_expired'), approverCtx).next;
    expect(expired.state).toBe('expired');
    expect(() => applyTransition(expired, eventOf('resume'), approverCtx)).toThrow(
      IllegalRunEventError,
    );
    expect(() => applyTransition(expired, eventOf('pause'), approverCtx)).toThrow(
      IllegalRunEventError,
    );
  });

  it('kill from paused reaches killed', () => {
    expect(applyTransition(statusOf('paused'), eventOf('kill'), approverCtx).next.state).toBe(
      'killed',
    );
  });
});
