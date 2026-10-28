import { pathToFileURL } from 'node:url';

import { createLogger } from '@blackwing/logger';

import { createApiApp } from '../bootstrap/create-app.js';
import { createHttpMetrics } from '../bootstrap/metrics.js';
import { loadApiConfig } from '../config.js';
import { GraphqlApiModule } from './module.js';

import type { MemberReadStore } from './store.js';

/**
 * The store of the schema emitter: the schema is built from the decorators, and no operation runs, so a
 * read is a programming error and fails loudly instead of answering.
 */
const SCHEMA_ONLY_STORE: MemberReadStore = {
  listMembers: () => Promise.reject(new Error('the schema emitter runs no operations')),
  findUsers: () => Promise.reject(new Error('the schema emitter runs no operations')),
};

/**
 * Writes the code-first schema to `apps/api/schema.gql` (`pnpm graphql:generate`, drift-checked). The file is
 * the one `@nestjs/graphql` writes at boot (`autoSchemaFile`); this boots the GraphQL module on a throwaway
 * app so the committed SDL matches the decorators without a database.
 */
export async function emitGraphqlSchema(): Promise<void> {
  const config = loadApiConfig({ NODE_ENV: 'test', WEB_ORIGIN: 'http://localhost:3000' });
  const logger = createLogger('api', { level: 'silent', nodeEnv: 'test' });
  const metrics = createHttpMetrics();
  const { app } = await createApiApp({
    config,
    logger,
    metrics,
    imports: [GraphqlApiModule.forRoot({ config, logger, metrics, store: SCHEMA_ONLY_STORE })],
  });
  await app.close();
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await emitGraphqlSchema();
}
