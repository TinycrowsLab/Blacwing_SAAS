import { z } from 'zod';

import {
  type EnvSource,
  isConfigValidationError,
  loadConfig,
  zSecret,
  zUrl,
} from '@blackwing/config';
import { AppError } from '@blackwing/errors';

/** Bolt and routing schemes the Neo4j driver accepts, with and without TLS (GRAPH-001, §5). */
export const NEO4J_URI_PROTOCOLS = [
  'bolt:',
  'bolt+s:',
  'bolt+ssc:',
  'neo4j:',
  'neo4j+s:',
  'neo4j+ssc:',
] as const;

/** Effective settings of the graph driver, after defaults. Camel-cased; the env keys are in {@link graphEnvSchema}. */
export interface Neo4jConfig {
  readonly uri: string;
  readonly username: string;
  /** Redacted from every log line (see `@blackwing/config` `zSecret`). Never returned from a health check. */
  readonly password: string;
  readonly database: string;
  readonly maxPoolSize: number;
  readonly connectionTimeoutMs: number;
  readonly maxTxRetryMs: number;
  /** Rows per upsert transaction (GRAPH_UPSERT_BATCH, GRAPH-007): a larger batch is split into chunks of this size. */
  readonly upsertBatchSize: number;
}

/** Upper bound for `NEO4J_MAX_POOL_SIZE`: a typo cannot open thousands of sockets. */
const MAX_POOL_SIZE = 1000;
/** Upper bound for `GRAPH_UPSERT_BATCH`: one transaction stays bounded in size. */
const MAX_UPSERT_BATCH = 5000;

/** A positive integer environment value, given as a decimal string. */
function zPositiveInt(max: number): z.ZodType<number, string> {
  return z
    .string()
    .regex(/^[1-9][0-9]*$/, 'must be a positive integer')
    .transform((raw): number => Number(raw))
    .pipe(z.number().int().max(max));
}

/**
 * Environment keys of the graph driver. `NEO4J_URI` and `NEO4J_PASSWORD` are required; the URI must not carry
 * credentials, so the password only ever comes from its own secret key.
 */
export const graphEnvSchema = z.object({
  NEO4J_URI: zUrl({ protocols: [...NEO4J_URI_PROTOCOLS] }).refine(
    (uri) => {
      const url = new URL(uri);
      return url.username === '' && url.password === '';
    },
    { message: 'must not contain credentials' },
  ),
  NEO4J_USER: z.string().min(1).default('neo4j'),
  NEO4J_PASSWORD: zSecret(),
  NEO4J_DATABASE: z.string().min(1).default('neo4j'),
  NEO4J_MAX_POOL_SIZE: z.string().default('50').pipe(zPositiveInt(MAX_POOL_SIZE)),
  GRAPH_UPSERT_BATCH: z.string().default('500').pipe(zPositiveInt(MAX_UPSERT_BATCH)),
});

/** Parses and freezes the graph config from `source` (default: the process environment, via `@blackwing/config`). */
export function loadNeo4jConfig(source?: EnvSource): Neo4jConfig {
  let env: z.output<typeof graphEnvSchema>;
  try {
    env = loadConfig(graphEnvSchema, source);
  } catch (error) {
    if (isConfigValidationError(error) && error.missingKeys.length > 0) {
      throw new AppError(
        'GRAPH_CONFIG_MISSING',
        `graph configuration missing required keys: ${error.missingKeys.join(', ')}`,
        { cause: error },
      );
    }
    throw error;
  }
  return Object.freeze({
    uri: env.NEO4J_URI,
    username: env.NEO4J_USER,
    password: env.NEO4J_PASSWORD,
    database: env.NEO4J_DATABASE,
    maxPoolSize: env.NEO4J_MAX_POOL_SIZE,
    connectionTimeoutMs: 5000,
    maxTxRetryMs: 15000,
    upsertBatchSize: env.GRAPH_UPSERT_BATCH,
  });
}
