// commitlint: every commit message follows Conventional Commits (FOUND-006, #8; CONTEXT_PACK §5,
// §10), so the release workflow (CI-016) can derive semantic versions and changelogs from history.
// Run by the Husky `commit-msg` hook (.husky/commit-msg).
//
// - Types are exactly the ten in CLAUDE.md "Branches, commits and PRs" (no `style`: formatting
//   is Prettier's job and lands with the change that needs it).
// - The scope is optional; when present it must be one of the generated scopes
//   (scripts/commit-scopes.mjs: workspace members, epic keys, layout directories, repo scopes).
//   Several scopes may be combined with "," or "/" (`feat(api,web): ...`).
// - Git's own merge and revert messages ("Merge branch ...", `Revert "..."`) are exempt through
//   commitlint's default ignores; a hand-written revert uses the `revert` type.

import { RuleConfigSeverity } from '@commitlint/types';

import { allowedScopes } from './scripts/commit-scopes.mjs';

/** Allowed commit types, in the order CLAUDE.md lists them. */
export const COMMIT_TYPES = Object.freeze([
  'feat',
  'fix',
  'docs',
  'chore',
  'refactor',
  'test',
  'build',
  'ci',
  'perf',
  'revert',
]);

/** Scopes are read from the repository this config lives in, whatever the working directory. */
export const COMMIT_SCOPES = Object.freeze(allowedScopes(import.meta.dirname));

/** A header whose scope parentheses hold nothing (`feat(): ...`, `fix( ): ...`). */
const EMPTY_SCOPE = /^[^\s(:!]+\(\s*\)/;

/**
 * Local rules. `scope-enum` only checks a scope that has a value, so `feat(): ...` would pass it.
 * @type {import('@commitlint/types').Plugin}
 */
export const blackwingPlugin = {
  rules: {
    'scope-not-blank': (parsed) => [
      !EMPTY_SCOPE.test(parsed.header ?? ''),
      'scope may not be blank: name a scope or drop the parentheses',
    ],
  },
};

/** @type {import('@commitlint/types').UserConfig} */
const config = {
  extends: ['@commitlint/config-conventional'],
  plugins: [blackwingPlugin],
  defaultIgnores: true,
  helpUrl:
    'https://github.com/TinycrowsLab/Blacwing_SAAS/blob/main/CLAUDE.md#branches-commits-and-prs',
  rules: {
    'type-enum': [RuleConfigSeverity.Error, 'always', [...COMMIT_TYPES]],
    'scope-enum': [RuleConfigSeverity.Error, 'always', [...COMMIT_SCOPES]],
    'scope-case': [RuleConfigSeverity.Error, 'always', 'lower-case'],
    'scope-not-blank': [RuleConfigSeverity.Error, 'always'],
  },
};

export default config;
