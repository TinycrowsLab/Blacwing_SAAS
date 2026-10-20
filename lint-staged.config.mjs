// lint-staged: formats and lints only the files staged for the commit (FOUND-006, #8). Run by the
// Husky `pre-commit` hook (.husky/pre-commit). lint-staged passes just the staged paths to each
// command (split into chunks on very large commits), re-stages what the fixers changed, and
// leaves unstaged edits and every other file in the repository untouched.
//
// - TypeScript/JavaScript: `eslint --fix` with the repository flat config (eslint.config.mjs,
//   zero warnings; files ESLint ignores are skipped silently), then `prettier --write`.
// - JSON/YAML/CSS: `prettier --write`. Paths in .prettierignore are skipped (--ignore-unknown
//   also skips files Prettier has no parser for).
// - Go (apps/egress-gateway): `gofmt -w`. golangci-lint stays in `make lint` / CI: it is too
//   slow for a commit hook.

/** @type {import('lint-staged').Configuration} */
const config = {
  '*.{ts,tsx,mts,cts,js,mjs,cjs}': [
    'eslint --fix --max-warnings=0 --no-warn-ignored',
    'prettier --write --ignore-unknown',
  ],
  '*.{json,jsonc,yml,yaml,css}': 'prettier --write --ignore-unknown',
  '*.go': 'gofmt -w',
};

export default config;
