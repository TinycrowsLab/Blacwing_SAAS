// The evidence object store slice (EVIDENCE #731): defaults keep writes COMPLIANCE-locked and 365 days long, and a
// missing bucket or KMS key stops the process at startup instead of writing evidence somewhere unkeyed.
import { describe, expect, it } from 'vitest';

import { loadConfig } from './env.js';
import { evidenceStoreEnvSchema } from './schema.js';

const required = { EVIDENCE_BUCKET: 'bw-dev-evidence', EVIDENCE_KMS_KEY_ID: 'alias/bw-evidence' };

describe('evidenceStoreEnvSchema', () => {
  it('defaults to COMPLIANCE object lock, 365 days of retention and AWS KMS', () => {
    expect(loadConfig(evidenceStoreEnvSchema, required)).toEqual({
      EVIDENCE_BUCKET: 'bw-dev-evidence',
      EVIDENCE_KMS_KEY_ID: 'alias/bw-evidence',
      EVIDENCE_OBJECT_LOCK_MODE: 'COMPLIANCE',
      EVIDENCE_DEFAULT_RETENTION_DAYS: 365,
      EVIDENCE_SSE: 'aws:kms',
    });
  });

  it('reads the retention days from the environment as a number', () => {
    const config = loadConfig(evidenceStoreEnvSchema, {
      ...required,
      EVIDENCE_DEFAULT_RETENTION_DAYS: '90',
    });
    expect(config.EVIDENCE_DEFAULT_RETENTION_DAYS).toBe(90);
  });

  it('accepts GOVERNANCE and the MinIO SSE mode for the dev bucket', () => {
    const config = loadConfig(evidenceStoreEnvSchema, {
      ...required,
      EVIDENCE_OBJECT_LOCK_MODE: 'GOVERNANCE',
      EVIDENCE_SSE: 'minio',
    });
    expect(config).toMatchObject({
      EVIDENCE_OBJECT_LOCK_MODE: 'GOVERNANCE',
      EVIDENCE_SSE: 'minio',
    });
  });

  it('requires a bucket and a KMS key, with no default that could point at the wrong one', () => {
    expect(() => loadConfig(evidenceStoreEnvSchema, { EVIDENCE_KMS_KEY_ID: 'k' })).toThrow();
    expect(() => loadConfig(evidenceStoreEnvSchema, { EVIDENCE_BUCKET: 'b' })).toThrow();
    expect(() =>
      loadConfig(evidenceStoreEnvSchema, { ...required, EVIDENCE_BUCKET: '' }),
    ).toThrow();
  });

  it.each([
    ['an unknown lock mode', { EVIDENCE_OBJECT_LOCK_MODE: 'NONE' }],
    ['an unknown SSE mode', { EVIDENCE_SSE: 'sse-c' }],
    ['zero retention days', { EVIDENCE_DEFAULT_RETENTION_DAYS: '0' }],
    ['a fractional retention', { EVIDENCE_DEFAULT_RETENTION_DAYS: '1.5' }],
    ['retention beyond 100 years', { EVIDENCE_DEFAULT_RETENTION_DAYS: '36501' }],
  ])('rejects %s', (_label, override) => {
    expect(() => loadConfig(evidenceStoreEnvSchema, { ...required, ...override })).toThrow();
  });
});
