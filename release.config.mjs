// semantic-release configuration (CI-016, #150). One repository version for v1 (docs/runbooks/release.md):
// Conventional Commits on main drive the bump (feat -> minor, fix/perf/revert -> patch,
// `!` or a BREAKING CHANGE footer -> major); anything else (chore, docs, ci, test, ...) releases
// nothing and the run exits cleanly. The same analyzer settings back the pull-request dry run in
// scripts/release.mjs, so a PR reports exactly the version the release job would compute.

/** Rules shared by the release job and the PR dry run. */
export const RELEASE_RULES = Object.freeze([
  { type: 'feat', release: 'minor' },
  { type: 'fix', release: 'patch' },
  { type: 'perf', release: 'patch' },
  { type: 'revert', release: 'patch' },
  { breaking: true, release: 'major' },
]);

export const ANALYZER = Object.freeze({
  preset: 'conventionalcommits',
  releaseRules: RELEASE_RULES,
});

export const TAG_FORMAT = 'v${version}';

/** The bot's own changelog commit; `[skip ci]` keeps it from re-triggering workflows. */
export const RELEASE_COMMIT_MESSAGE =
  'chore(release): ${nextRelease.version} [skip ci]\n\n${nextRelease.notes}';

export default {
  branches: ['main'],
  tagFormat: TAG_FORMAT,
  plugins: [
    ['@semantic-release/commit-analyzer', { ...ANALYZER }],
    ['@semantic-release/release-notes-generator', { preset: 'conventionalcommits' }],
    ['@semantic-release/changelog', { changelogFile: 'CHANGELOG.md' }],
    // Nothing is published to npm in v1, so the version lives in the tag and the release only.
    ['@semantic-release/git', { assets: ['CHANGELOG.md'], message: RELEASE_COMMIT_MESSAGE }],
    [
      '@semantic-release/github',
      { successComment: false, failComment: false, releasedLabels: false },
    ],
  ],
};
