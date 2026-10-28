import { defineIntegrationConfig } from '@blackwing/testing/vitest-config';

export default defineIntegrationConfig({
  resolve: {
    // Same CommonJS graphql build as the unit config and as production (see vitest.config.ts).
    alias: [{ find: /^graphql$/, replacement: 'graphql/index.js' }],
  },
});
