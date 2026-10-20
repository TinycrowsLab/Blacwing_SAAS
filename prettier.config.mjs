// Prettier owns formatting for the whole repository (FOUND-004); ESLint does not duplicate it
// (eslint-config-prettier is the last entry of eslint.config.mjs). Ignored paths: .prettierignore.

/** @type {import('prettier').Config} */
const config = {
  printWidth: 100,
  singleQuote: true,
  semi: true,
  trailingComma: 'all',
};

export default config;
