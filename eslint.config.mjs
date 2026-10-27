// ESLint 9 flat config for the whole TypeScript workspace (FOUND-004).
//
// - Type-aware everywhere: `projectService` resolves every file to its nearest tsconfig.json, so the
//   typed rules (no-unsafe-*, no-floating-promises, ...) really run. A file that no tsconfig includes
//   fails lint with a parsing error instead of being linted without types: add it to the nearest
//   tsconfig.json (scripts/ has its own) rather than relaxing this config.
// - typescript-eslint strictTypeChecked + stylisticTypeChecked, with `any`, unsafe access and
//   non-null assertions as hard errors (CONTEXT_PACK §5, §10).
// - Formatting belongs to Prettier: eslint-config-prettier is the final entry and switches off every
//   rule that would fight it.
// - Architectural import boundaries are FOUND-005 (#7) and dead code is FOUND-018; neither lives here.
//
// Each workspace member runs `eslint . --max-warnings=0` from its own directory (via `pnpm lint` /
// Turborepo); the root task `lint:root` covers scripts/ and the root config files.

import { builtinModules } from 'node:module';

import eslint from '@eslint/js';
import vitest from '@vitest/eslint-plugin';
import { defineConfig } from 'eslint/config';
import prettier from 'eslint-config-prettier';
import importPlugin from 'eslint-plugin-import';
import unicorn from 'eslint-plugin-unicorn';
import globals from 'globals';
import tseslint from 'typescript-eslint';

import { blackwingPlugin } from './scripts/eslint-rules/index.mjs';

/** Files that hold tests (Vitest in members, node:test under scripts/). */
export const TEST_FILES = ['**/*.test.{ts,tsx,mts,mjs}', '**/*.spec.{ts,tsx,mts,mjs}'];

/** Vitest test files only: scripts/ self-tests use node:test and must not get Vitest rules. */
export const VITEST_FILES = ['**/*.test.{ts,tsx,mts}', '**/*.spec.{ts,tsx,mts}'];

/** Tool configuration files, which their tools load through a default export. */
export const CONFIG_FILES = ['**/*.config.{ts,mts,cts,js,mjs,cjs}'];

/**
 * Next.js App Router special files, which the framework loads through a default export
 * (apps/web, CONTEXT_PACK §5). Anything else in apps/web uses named exports.
 */
export const NEXT_ROUTE_FILES = [
  'apps/web/**/app/**/{page,layout,template,loading,error,global-error,not-found,default}.tsx',
  'apps/web/**/app/**/{opengraph-image,twitter-image,icon,apple-icon}.tsx',
  'apps/web/**/app/**/{sitemap,robots,manifest}.ts',
];

/**
 * Storybook files, which Storybook loads through a default export: the `.storybook/` config and the
 * Component Story Format `default` meta in each `*.stories.tsx` (packages/ui, issue #271).
 */
export const STORYBOOK_FILES = [
  'packages/ui/.storybook/*.{ts,tsx}',
  'packages/ui/src/components/*.stories.{ts,tsx}',
];

/** Places where writing to the console is the job: the CLI and repository tooling. */
export const CONSOLE_ALLOWED_FILES = ['apps/cli/**', 'scripts/**'];

/**
 * Never linted: dependencies, build output, caches, generated code (OpenAPI/GraphQL clients,
 * drizzle snapshots, ...) and the deliberately failing lint fixtures. Keep generated-code patterns
 * in sync with .prettierignore.
 */
export const IGNORES = [
  '**/node_modules/**',
  '**/dist/**',
  '**/build/**',
  '**/out/**',
  '**/storybook-static/**',
  '**/coverage/**',
  '**/.next/**',
  '**/.turbo/**',
  '**/generated/**',
  '**/__generated__/**',
  '**/*.generated.*',
  '**/*.gen.*',
  'scripts/fixtures/eslint/**',
  // Fixtures of the blackwing/no-raw-tenant-db rule tests: deliberately raw tenant queries.
  'scripts/fixtures/tenant-db/**',
  // Compile-fail fixtures for the strict tsconfig flags (FOUND-003): deliberately wrong code.
  'packages/testing/typefixtures/**',
  // Design-tool exports (see design/README.md), not hand-written code.
  'design/**',
];

/** Small numbers that are never "magic" (indexes, sign, halving, doubling). */
const ALLOWED_NUMBERS = [-1, 0, 1, 2];

export default defineConfig(
  { name: 'blackwing/ignores', ignores: IGNORES },

  eslint.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,

  {
    name: 'blackwing/language',
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
      parserOptions: {
        projectService: {
          // Root-level tool configs (eslint.config.mjs, prettier.config.mjs) sit outside every
          // member; they are typechecked with the scripts/ settings.
          allowDefaultProject: [
            '*.config.mjs',
            'apps/web/*.config.mjs',
            'packages/testing/src/vitest/ci-preload.mjs',
          ],
          defaultProject: 'scripts/tsconfig.json',
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    linterOptions: {
      reportUnusedDisableDirectives: 'error',
      reportUnusedInlineConfigs: 'error',
    },
    settings: {
      'import/internal-regex': '^@blackwing/',
    },
  },

  {
    name: 'blackwing/rules',
    plugins: { import: importPlugin, unicorn },
    rules: {
      // No `any`, explicit or leaked through untyped values (CONTEXT_PACK §5, §10).
      '@typescript-eslint/no-explicit-any': [
        'error',
        { fixToUnknown: false, ignoreRestArgs: false },
      ],
      '@typescript-eslint/no-unsafe-argument': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-call': 'error',
      '@typescript-eslint/no-unsafe-declaration-merging': 'error',
      '@typescript-eslint/no-unsafe-enum-comparison': 'error',
      '@typescript-eslint/no-unsafe-function-type': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',
      '@typescript-eslint/no-unsafe-unary-minus': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',

      // Promises are awaited or explicitly handled; async functions really await.
      '@typescript-eslint/no-floating-promises': [
        'error',
        {
          // node:test registers suites and tests synchronously; their returned promises are
          // tracked by the runner (scripts/ self-tests).
          allowForKnownSafeCalls: [
            { from: 'package', package: 'node:test', name: ['describe', 'it', 'suite', 'test'] },
          ],
        },
      ],
      '@typescript-eslint/no-misused-promises': 'error',
      'require-await': 'off',
      '@typescript-eslint/require-await': 'error',

      // Type-only imports are explicit (pairs with verbatimModuleSyntax).
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/consistent-type-exports': 'error',
      '@typescript-eslint/no-import-type-side-effects': 'error',

      // NestJS (§5, apps/api) declares modules as decorated classes with no members of their own; the
      // rule still rejects undecorated static-only or empty classes.
      '@typescript-eslint/no-extraneous-class': ['error', { allowWithDecorator: true }],

      '@typescript-eslint/no-magic-numbers': [
        'error',
        {
          ignore: ALLOWED_NUMBERS,
          ignoreArrayIndexes: true,
          ignoreDefaultValues: true,
          ignoreEnums: true,
          ignoreNumericLiteralTypes: true,
          ignoreReadonlyClassProperties: true,
          ignoreTypeIndexes: true,
        },
      ],

      // Output goes through @blackwing/logger (redaction keeps secrets out of stdout, §8.7).
      'no-console': 'error',

      // No dynamic code evaluation.
      'no-eval': 'error',
      'no-new-func': 'error',
      'no-script-url': 'error',
      '@typescript-eslint/no-implied-eval': 'error',

      // Numbers and regular expressions stringify predictably; everything else must be a string.
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true, allowRegExp: true },
      ],

      eqeqeq: ['error', 'always'],
      'no-restricted-syntax': [
        'error',
        {
          selector: 'TSEnumDeclaration[const=true]',
          message: 'const enums break isolatedModules.',
        },
      ],

      // Imports: ordered, grouped, de-duplicated, named exports only.
      'import/first': 'error',
      'import/newline-after-import': 'error',
      'import/no-duplicates': ['error', { 'prefer-inline': true }],
      'import/no-default-export': 'error',
      'import/no-mutable-exports': 'error',
      'import/order': [
        'error',
        {
          groups: ['builtin', 'external', 'internal', ['parent', 'sibling', 'index'], 'type'],
          'newlines-between': 'always',
          alphabetize: { order: 'asc', caseInsensitive: true },
        },
      ],

      // Curated unicorn rules: correctness and modern Node APIs, not taste.
      'unicorn/error-message': 'error',
      // Next.js dynamic route segments (`[runId]`) are dictated by the framework.
      'unicorn/filename-case': ['error', { case: 'kebabCase', ignore: [/^\[\.{0,3}[A-Za-z]+\]$/] }],
      'unicorn/new-for-builtins': 'error',
      'unicorn/no-abusive-eslint-disable': 'error',
      'unicorn/no-array-callback-reference': 'error',
      'unicorn/no-instanceof-builtins': 'error',
      'unicorn/no-invalid-remove-event-listener': 'error',
      'unicorn/no-new-buffer': 'error',
      'unicorn/no-thenable': 'error',
      'unicorn/no-unnecessary-await': 'error',
      'unicorn/no-useless-promise-resolve-reject': 'error',
      'unicorn/no-useless-spread': 'error',
      'unicorn/prefer-array-find': 'error',
      'unicorn/prefer-array-flat-map': 'error',
      'unicorn/prefer-array-some': 'error',
      'unicorn/prefer-includes': 'error',
      'unicorn/prefer-module': 'error',
      'unicorn/prefer-node-protocol': 'error',
      'unicorn/prefer-optional-catch-binding': 'error',
      'unicorn/prefer-string-slice': 'error',
      'unicorn/prefer-string-starts-ends-with': 'error',
      'unicorn/prefer-structured-clone': 'error',
      'unicorn/prefer-type-error': 'error',
      'unicorn/throw-new-error': 'error',
    },
  },

  {
    name: 'blackwing/tests',
    files: TEST_FILES,
    rules: {
      // Expected values in assertions are literal by nature.
      '@typescript-eslint/no-magic-numbers': 'off',
    },
  },

  {
    // TENANT-002: tenant tables are reached only through withTenant's handle (see
    // docs/architecture/tenant-data-access.md). Migrations, the owner pool and withSystem opt out
    // per query with `// blackwing:allow-raw-tenant-db <reason>`, never by turning the rule off.
    name: 'blackwing/tenant-data-access',
    files: ['**/*.{ts,tsx,mts}'],
    plugins: { blackwing: blackwingPlugin },
    rules: { 'blackwing/no-raw-tenant-db': 'error' },
  },

  {
    ...vitest.configs.recommended,
    name: 'blackwing/vitest',
    files: VITEST_FILES,
    rules: {
      ...vitest.configs.recommended.rules,
      // Definition of Done: no skipped, focused or todo tests (CONTEXT_PACK §10).
      'vitest/no-disabled-tests': 'error',
      // Type-level assertions (expectTypeOf/assertType) and fast-check properties are assertions too.
      'vitest/expect-expect': [
        'error',
        { assertFunctionNames: ['expect', 'expect.*', 'expectTypeOf', 'assertType', 'fc.assert'] },
      ],
      // Vitest accepts a custom failure message as the second argument of expect().
      'vitest/valid-expect': ['error', { maxArgs: 2 }],
      'vitest/no-focused-tests': 'error',
      'vitest/warn-todo': 'error',
    },
  },

  {
    name: 'blackwing/config-files',
    files: [...CONFIG_FILES, ...NEXT_ROUTE_FILES, ...STORYBOOK_FILES],
    rules: {
      'import/no-default-export': 'off',
    },
  },

  {
    name: 'blackwing/console-allowed',
    files: CONSOLE_ALLOWED_FILES,
    rules: {
      'no-console': 'off',
    },
  },

  {
    name: 'blackwing/api-controllers-no-inline-zod',
    files: ['apps/api/src/**/*.controller.ts'],
    rules: {
      // API-002 (#54): request/response schemas live in @blackwing/contracts; controllers use DTOs.
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'zod',
              message:
                'Controllers never inline Zod schemas: import them from @blackwing/contracts and use createZodDto (apps/api/src/**/dto).',
            },
          ],
        },
      ],
    },
  },

  {
    name: 'blackwing/workflow-determinism',
    files: ['apps/worker/src/workflows/**/*.ts'],
    // Test files run under Node (replay tests read fixtures and start a test Worker); they are never
    // bundled into the workflow sandbox, so the sandbox rules do not apply to them.
    ignores: TEST_FILES,
    rules: {
      // Temporal replays workflow code, so it must make the same decisions on every replay
      // (docs/architecture/workflow-determinism.md). Type-only imports stay allowed everywhere.
      'no-restricted-globals': [
        'error',
        {
          name: 'process',
          message: 'Workflows are deterministic: read configuration in activities, not here.',
        },
        {
          name: 'crypto',
          message: 'Use uuid4() from @temporalio/workflow, never the Node or Web crypto API.',
        },
        {
          name: 'fetch',
          message: 'Network calls belong in activities; workflows only schedule them.',
        },
        {
          name: 'setTimeout',
          message: 'Use sleep() from @temporalio/workflow; timers outside it do not replay.',
        },
        {
          name: 'setInterval',
          message: 'Use sleep() from @temporalio/workflow; timers outside it do not replay.',
        },
        {
          name: 'setImmediate',
          message: 'Use sleep() from @temporalio/workflow; timers outside it do not replay.',
        },
      ],
      'no-restricted-properties': [
        'error',
        {
          object: 'Math',
          property: 'random',
          message: 'Use uuid4() from @temporalio/workflow for randomness.',
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: 'TSEnumDeclaration[const=true]',
          message: 'const enums break isolatedModules.',
        },
        {
          selector: 'NewExpression[callee.name="Date"][arguments.length=0]',
          message:
            'Reads the wall clock. Use workflowInfo().startTime or an activity. new Date(value) is fine.',
        },
        {
          selector: 'CallExpression[callee.name="Date"]',
          message: 'Date() reads the wall clock. Use workflowInfo().startTime or an activity.',
        },
        {
          selector: 'CallExpression[callee.object.name="Date"][callee.property.name="now"]',
          message: 'Date.now() reads the wall clock. Use workflowInfo().startTime or an activity.',
        },
      ],
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@temporalio/client',
              allowTypeImports: true,
              message:
                'Workflows never start or signal workflows; that is the API or worker code. Use activities.',
            },
            {
              name: 'ioredis',
              allowTypeImports: true,
              message: 'Redis access is I/O: move it into an activity.',
            },
            {
              name: 'pg',
              allowTypeImports: true,
              message: 'Database access is I/O: move it into an activity behind withTenant.',
            },
          ],
          patterns: [
            {
              group: ['node:*', ...builtinModules, ...builtinModules.map((m) => `${m}/*`)],
              allowTypeImports: true,
              message:
                'Node built-ins do IO or read the environment. Keep them in activities; see docs/architecture/workflow-determinism.md.',
            },
          ],
        },
      ],
    },
  },

  // Must stay last: turns off every rule that would fight Prettier.
  { name: 'eslint-config-prettier', ...prettier },
);
