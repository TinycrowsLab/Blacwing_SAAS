// Fixture: an app's config module. It parses at module scope, so importing it resolves config once.
import { zSecret } from '../coerce.js';
import { defineConfig } from '../env.js';
import { isMarkedSecret } from '../redaction.js';
import { baseEnvSchema } from '../schema.js';

export const config = defineConfig(baseEnvSchema.extend({ APP_SECRET: zSecret() }), {
  source: { NODE_ENV: 'test', APP_SECRET: 'fixture-import-secret-0008' },
});

/** Evaluated right after `defineConfig` returns, before any importer's code runs. */
export const registeredAtImport = isMarkedSecret('fixture-import-secret-0008');
