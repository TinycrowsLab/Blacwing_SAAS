import { defineUnitConfig } from '@blackwing/testing/vitest-config';

export default defineUnitConfig({
  resolve: {
    // graphql ships an ES module build that Vite prefers for bare imports, while Nest and Mercurius load the
    // CommonJS build. Two copies fail graphql-js's instanceof checks. Node (production) loads the CommonJS
    // build for every import, so the tests resolve the same one.
    alias: [{ find: /^graphql$/, replacement: 'graphql/index.js' }],
  },
});
