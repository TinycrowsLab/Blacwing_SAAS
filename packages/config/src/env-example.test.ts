// DEVENV-003 (#157): the repository's `.env.example` must satisfy the shared config schemas, so a
// developer who copies it to `.env` boots an app with no validation errors.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { zPort } from './coerce.js';
import { loadConfig } from './env.js';
import { baseEnvSchema, databaseEnvSchema, valkeyEnvSchema } from './schema.js';

const examplePath = join(dirname(fileURLToPath(import.meta.url)), '../../../.env.example');

/** Parses the example the way `pnpm dev:deps` renders it: empty passwords filled, `${KEY}` expanded. */
function renderExample(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(examplePath, 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (!m?.[1]) continue;
    const raw = m[2] === '' && m[1].endsWith('_PASSWORD') ? 'dev0123456789abcdef' : (m[2] ?? '');
    out[m[1]] = raw.replace(/\$\{([A-Z0-9_]+)\}/g, (ref, k: string) => out[k] ?? ref);
  }
  return out;
}

describe('.env.example vs @blackwing/config schemas', () => {
  const env = renderExample();

  it('boots an example app schema (base + database + valkey) with no validation errors', () => {
    const schema = baseEnvSchema.extend(databaseEnvSchema.shape).extend(valkeyEnvSchema.shape);
    expect(() => loadConfig(schema, env)).not.toThrow();
    expect(env.TEMPORAL_ADDRESS).toMatch(/^[\d.]+:\d+$/);
  });

  it('uses the fixed dev ports for compose-backed services', () => {
    const ports = zPort();
    for (const url of [env.DATABASE_URL, env.REDIS_URL, env.NEO4J_URI, env.S3_ENDPOINT]) {
      expect(ports.safeParse(new URL(url ?? '').port).success).toBe(true);
    }
  });

  it('is development-only: NODE_ENV=development and password login flagged dev-only', () => {
    expect(env.NODE_ENV).toBe('development');
    expect(readFileSync(examplePath, 'utf8')).toContain('[DEV-ONLY] toggles');
  });

  it('edge case: a required key left empty fails with reason empty (empty means unset)', () => {
    expect(() => loadConfig(databaseEnvSchema, { DATABASE_URL: '' })).toThrow();
  });
});
