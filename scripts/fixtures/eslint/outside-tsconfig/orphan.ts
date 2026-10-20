// Lint fixture: a file that no tsconfig.json includes. Type-aware linting must refuse it with a
// parsing error instead of silently linting it without types.
export const orphan = 'not in any project';
