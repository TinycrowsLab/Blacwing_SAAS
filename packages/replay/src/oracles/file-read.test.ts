import { describe, expect, it } from 'vitest';

import { oracleParamsSchemas } from '@blackwing/contracts';
import { ValidationError } from '@blackwing/errors';

import { assertBenignSentinel, fileReadEvaluator, FILE_READ_REASONS } from './file-read.js';
import { exchange, observationWith } from './fixtures.js';

const SENTINEL = 'blackwing-sentinel-01';
const params = { marker: SENTINEL };

describe('file_read evaluator', () => {
  it('fires when the declared benign sentinel is served by a successful response', () => {
    const observation = observationWith([exchange({ body: `header ${SENTINEL} footer` })]);
    expect(fileReadEvaluator(observation, params)).toEqual({
      matched: true,
      reason: FILE_READ_REASONS.sentinelReturned,
    });
  });

  it('does not count the sentinel on a non-2xx response (an error page echoing it is not a read)', () => {
    const observation = observationWith([exchange({ status: 404, body: SENTINEL })]);
    expect(fileReadEvaluator(observation, params)).toEqual({
      matched: false,
      reason: FILE_READ_REASONS.sentinelAbsent,
    });
  });

  it('is not fired when the sentinel is absent', () => {
    expect(
      fileReadEvaluator(observationWith([exchange({ body: 'nothing here' })]), params),
    ).toEqual({
      matched: false,
      reason: FILE_READ_REASONS.sentinelAbsent,
    });
  });

  it('is Suspected, not absent, when a truncated body could still hold the sentinel', () => {
    const observation = observationWith([exchange({ body: 'partial', truncated: true })]);
    expect(fileReadEvaluator(observation, params)).toEqual({
      matched: false,
      reason: FILE_READ_REASONS.truncatedBeforeSentinel,
    });
  });

  it('refuses a path, a traversal or a credential-shaped value as the marker (never a sensitive file)', () => {
    for (const marker of ['../../etc/passwd', '/etc/shadow', 'root:x:0:0', '.env', 'a/b', 'ab']) {
      expect(() => fileReadEvaluator(observationWith([exchange()]), { marker })).toThrow(
        ValidationError,
      );
    }
  });

  it('accepts a short benign sentinel id only', () => {
    expect(() => {
      assertBenignSentinel('blackwing-sentinel-01');
    }).not.toThrow();
    expect(() => {
      assertBenignSentinel('bw_marker-7');
    }).not.toThrow();
  });

  it('rejects a path or traversal marker at spec validation, before any replay runs', () => {
    expect(oracleParamsSchemas.file_read.safeParse({ marker: SENTINEL }).success).toBe(true);
    for (const marker of ['../../etc/passwd', '/etc/shadow', '.env', 'root:x:0:0']) {
      expect(oracleParamsSchemas.file_read.safeParse({ marker }).success).toBe(false);
    }
  });

  it('refuses params that carry extra fields', () => {
    expect(() => fileReadEvaluator(observationWith([]), { marker: SENTINEL, path: '/x' })).toThrow(
      ValidationError,
    );
  });
});
