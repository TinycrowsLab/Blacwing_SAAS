import { describe, expect, it } from 'vitest';

import { isAppError } from '@blackwing/errors';

import { ALL_TASK_QUEUES, parseTaskQueues, TASK_QUEUES } from './task-queues.js';

function catchError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('TASK_QUEUES', () => {
  it('exports the nine task queues', () => {
    expect(TASK_QUEUES).toEqual({
      RUN_ORCHESTRATION: 'run-orchestration',
      AGENT_SESSIONS: 'agent-sessions',
      VALIDATION: 'validation',
      EXPORTS: 'exports',
      CONNECTORS: 'connectors',
      NOTIFICATIONS: 'notifications',
      RETENTION: 'retention',
      SCHEDULER: 'scheduler',
      OUTBOX_RELAY: 'outbox-relay',
    });
    expect(ALL_TASK_QUEUES).toHaveLength(9);
  });

  it('is immutable', () => {
    expect(Object.isFrozen(TASK_QUEUES)).toBe(true);
    expect(Object.isFrozen(ALL_TASK_QUEUES)).toBe(true);
    expect(() => {
      (TASK_QUEUES as Record<string, string>).EXPORTS = 'other';
    }).toThrow(TypeError);
  });
});

describe('parseTaskQueues', () => {
  it('defaults to every queue when unset or blank', () => {
    expect(parseTaskQueues(undefined)).toEqual(ALL_TASK_QUEUES);
    expect(parseTaskQueues('  ')).toEqual(ALL_TASK_QUEUES);
  });

  it('selects a trimmed, de-duplicated subset in order', () => {
    expect(parseTaskQueues('validation, exports,validation')).toEqual(['validation', 'exports']);
  });

  it.each(['validation,nope', 'validation,', 'Validation'])(
    'fails fast with WORKER_QUEUE_UNKNOWN for %j',
    (raw) => {
      const error = catchError(() => parseTaskQueues(raw));
      expect(isAppError(error) ? error.code : undefined).toBe('WORKER_QUEUE_UNKNOWN');
    },
  );
});
